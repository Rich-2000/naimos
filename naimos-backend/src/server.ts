/**
 * ============================================================
 *  NAIMOS AMS — Production Server  (FIXED v4)
 *  Express · TypeScript · JWT Auth · MongoDB · Hardened
 *
 *  Changes vs v3:
 *  ─────────────────────────────────────────────────────────
 *  FIX 1: connectSrc no longer lists allorigins / corsproxy /
 *    thingproxy / catalogue.dataspace.copernicus.eu.
 *    All those requests now go server→server via /api/* routes.
 *    Removing them from CSP closes the attack surface.
 *
 *  FIX 2: /api/copernicus route imported and mounted with auth.
 *
 *  FIX 3: server.ts no longer imports the dummy config.ts stub —
 *    it imports the real merged config with all credentials.
 *
 *  FIX 4: logConfigStatus() called at startup so the terminal
 *    clearly shows which credentials are missing.
 * ============================================================
 */

import { config, logConfigStatus } from './config';
import express       from 'express';
import cors          from 'cors';
import helmet        from 'helmet';
import rateLimit     from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import hpp           from 'hpp';
import path          from 'path';

import { chatRouter }       from './routes/chat';
import { firmsRouter }      from './routes/firms';
import { sentinelRouter }   from './routes/sentinel';
import { geeRouter }        from './routes/gee';
import { planetaryRouter }  from './routes/planetary';
import { healthRouter }     from './routes/health';
import { dronesRouter }     from './routes/drones';
import { naimosRouter }     from './routes/naimos_scraper';
import { authRouter }       from './routes/auth';
import { copernicusRouter } from './routes/copernicus';

import { errorHandler }   from './middleware/errorHandler';
import { logger }         from './middleware/logger';
import { globalSanitize } from './middleware/sanitize';
import { requireAuth }    from './auth';

const app  = express();
const PORT = config.port;

// ── 1. Hardened Helmet (CSP v4) ───────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],

        scriptSrc: [
          "'self'",
          "'unsafe-inline'",            // index.html large inline <script> block
          'https://cdnjs.cloudflare.com',
          'https://fonts.googleapis.com',
          'https://unpkg.com',
          'blob:',
        ],

        // Required for onclick / onchange / onsubmit attributes in index.html
        scriptSrcAttr: ["'unsafe-inline'"],

        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
        ],

        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],

        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],

        // FIX 1: Removed CORS proxy hosts and direct third-party API hosts.
        // All data is now fetched server-side via /api/*; the browser never
        // calls Copernicus, FIRMS, or Sentinel Hub directly.
        connectSrc: [
          "'self'",
          config.allowedOrigin,
          // ESA Sentinel Hub (image tiles — still loaded by the Sentinel image viewer)
          'https://services.sentinel-hub.com',
          // Google Earth Engine (tile URLs returned by the GEE route)
          'https://earthengine.googleapis.com',
          'https://earthengine.google.com',
          // Microsoft Planetary Computer (signed blob URLs for asset downloads)
          'https://planetarycomputer.microsoft.com',
          'https://landsateuwest.blob.core.windows.net',
          'https://sentinel2l2a01.blob.core.windows.net',
          // Unsplash drone fallback gallery
          'https://images.unsplash.com',
          // Local dev
          'http://localhost:3001',
          'ws://localhost:3001',
        ],

        frameSrc:   ["'none'"],
        objectSrc:  ["'none'"],
        baseUri:    ["'self'"],
        formAction: ["'self'"],
        ...(config.nodeEnv === 'production'
          ? { upgradeInsecureRequests: [] }
          : {}),
      },
    },
    crossOriginEmbedderPolicy:  false,
    crossOriginResourcePolicy:  { policy: 'cross-origin' },
    referrerPolicy:             { policy: 'strict-origin-when-cross-origin' },
    hsts: {
      maxAge:            31536000,
      includeSubDomains: true,
      preload:           true,
    },
    noSniff:            true,
    xssFilter:          true,
    hidePoweredBy:      true,
    ieNoOpen:           true,
    dnsPrefetchControl: { allow: false },
    frameguard:         { action: 'deny' },
  })
);

// ── 2. CORS ───────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = config.allowedOrigin.split(',').map(o => o.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin) || config.nodeEnv !== 'production') {
        return cb(null, true);
      }
      cb(new Error(`CORS: origin "${origin}" is not allowed.`));
    },
    methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-drone-secret'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-GEE-DateRange',
                     'X-FIRMS-Days', 'X-FIRMS-Sensor', 'X-Copernicus-Source'],
    credentials:    true,
    maxAge:         600,
  })
);

// ── 3. Body parsing ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// ── 4. NoSQL injection prevention ────────────────────────────────────────────
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    console.warn(`[SECURITY] NoSQL injection blocked: key="${key}" ip="${req.ip}"`);
  },
}));

// ── 5. HTTP Parameter Pollution ───────────────────────────────────────────────
app.use(hpp());

// ── 6. Global input sanitization ─────────────────────────────────────────────
app.use(globalSanitize);

// ── 7. Request logger ────────────────────────────────────────────────────────
app.use(logger);

// ── 8. Rate limiting ─────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             500,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests. Please try again later.' },
  skip:            (req) => req.path.startsWith('/api/health'),
});

const aiLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'AI rate limit reached. Wait 60 seconds.' },
});

app.use(globalLimiter);

// ── 9. Routes ─────────────────────────────────────────────────────────────────
// Public
app.use('/api/auth',   authRouter);
app.use('/api/health', healthRouter);

// Protected (requireAuth verifies JWT from auth-guard.js)
app.use('/api/chat',       requireAuth, aiLimiter, chatRouter);
app.use('/api/firms',      requireAuth, firmsRouter);
app.use('/api/sentinel',   requireAuth, sentinelRouter);
app.use('/api/gee',        requireAuth, geeRouter);
app.use('/api/planetary',  requireAuth, planetaryRouter);
app.use('/api/drones',     requireAuth, dronesRouter);
app.use('/api/naimos',     requireAuth, naimosRouter);
app.use('/api/copernicus', requireAuth, copernicusRouter);

app.use('/api/*', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

// ── 10. Static frontend ───────────────────────────────────────────────────────
const staticRoot = path.join(__dirname, '../../');
app.use(express.static(staticRoot));
app.get('*', (_req, res) => {
  res.sendFile(path.join(staticRoot, 'index.html'));
});

// ── 11. Global error handler ─────────────────────────────────────────────────
app.use(errorHandler);

// ── 12. Start server ─────────────────────────────────────────────────────────
if (config.nodeEnv !== 'production') {
  app.listen(PORT, () => {
    console.log(`\n🛰  NAIMOS AMS Backend running on http://localhost:${PORT}`);
    console.log(`   Environment : ${config.nodeEnv}`);
    logConfigStatus();
  });
}

export default app;