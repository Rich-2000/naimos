import { config, logConfigStatus } from './config';
import express, { Request, Response, NextFunction } from 'express';
import cors          from 'cors';
import helmet        from 'helmet';
import rateLimit     from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import hpp           from 'hpp';
import cookieParser  from 'cookie-parser';
import path          from 'path';
import fs            from 'fs';
 
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
 
// ── Static root — two levels up from backend/dist/ ───────────────────────────
// ENOENT FIX: resolve to an absolute path and verify it exists at startup.
const staticRoot = path.resolve(__dirname, '../../');
 
// Guard: warn loudly in dev if the static root doesn't contain index.html
// so the ENOENT error surfaces immediately at startup, not at request time.
if (config.nodeEnv !== 'production') {
  const indexPath = path.join(staticRoot, 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.warn(
      `[NAIMOS] ⚠  WARNING: index.html not found at ${indexPath}.\n` +
      `         Static file serving will fail. Check staticRoot path.`
    );
  }
}
 
// ── Trust Vercel's reverse proxy ─────────────────────────────────────────────
app.set('trust proxy', 1);
 
// ── 1. Hardened Helmet ────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://cdnjs.cloudflare.com',
          'https://fonts.googleapis.com',
          'https://unpkg.com',
          // Leaflet + OpenStreetMap tile worker
          'https://unpkg.com',
          'blob:',
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
          // Leaflet CSS via unpkg
          'https://unpkg.com',
           'https://cdnjs.cloudflare.com',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https:',
          // OpenStreetMap tile servers
          'https://*.tile.openstreetmap.org',
          'https://*.openstreetmap.org',
        ],
        connectSrc: [
          "'self'",
          config.allowedOrigin,
          'https://services.sentinel-hub.com',
          'https://earthengine.googleapis.com',
          'https://earthengine.google.com',
          'https://planetarycomputer.microsoft.com',
          'https://landsateuwest.blob.core.windows.net',
          'https://sentinel2l2a01.blob.core.windows.net',
          'https://images.unsplash.com',
          // OpenStreetMap / Nominatim / Overpass for Leaflet
          'https://unpkg.com',   
          'https://*.tile.openstreetmap.org',
          'https://nominatim.openstreetmap.org',
          'http://localhost:3001',
          'ws://localhost:3001',
        ],
        frameAncestors: ["'none'"],
        frameSrc:       ["'none'"],
        objectSrc:      ["'none'"],
        baseUri:        ["'self'"],
        formAction:     ["'self'"],
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
const ALLOWED_ORIGINS = config.allowedOrigin.split(',').map((o: string) => o.trim());
 
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
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-GEE-DateRange',
      'X-FIRMS-Days',
      'X-FIRMS-Sensor',
      'X-Copernicus-Source',
    ],
    credentials: true,
    maxAge:       600,
  })
);
 
// ── 3. Body parsing ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));
 
// ── 4. Cookie parser ──────────────────────────────────────────────────────────
app.use(cookieParser());
 
// ── 5. Cookie → Bearer bridge ─────────────────────────────────────────────────
const COOKIE_NAME = 'naimos_session';
const ME_ENDPOINT = '/api/auth/me';
 
app.use(function extractCookieToken(req: Request, _res: Response, next: NextFunction): void {
  if (req.path === ME_ENDPOINT) return next();
 
  const hasBearer = typeof req.headers['authorization'] === 'string' &&
                    req.headers['authorization'].startsWith('Bearer ');
 
  if (!hasBearer) {
    const cookieToken = (req as any).cookies?.[COOKIE_NAME];
    if (cookieToken && typeof cookieToken === 'string' && cookieToken.trim()) {
      req.headers['authorization'] = 'Bearer ' + cookieToken.trim();
    }
  }
  next();
});
 
// ── 6. NoSQL injection prevention ─────────────────────────────────────────────
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }: { req: Request; key: string }) => {
    console.warn(`[SECURITY] NoSQL injection blocked: key="${key}" ip="${req.ip}"`);
  },
}));
 
// ── 7. HTTP Parameter Pollution ───────────────────────────────────────────────
app.use(hpp());
 
// ── 8. Global input sanitization ──────────────────────────────────────────────
app.use(globalSanitize);
 
// ── 9. Request logger ─────────────────────────────────────────────────────────
app.use(logger);
 
// ── 10. Rate limiting ─────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             500,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests. Please try again later.' },
  skip:            (req: Request) => req.path.startsWith('/api/health'),
});
 
const aiLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'AI rate limit reached. Wait 60 seconds.' },
});
 
app.use(globalLimiter);
 
// ── 11. API Routes ────────────────────────────────────────────────────────────
 
// Public
app.use('/api/auth',   authRouter);
app.use('/api/health', healthRouter);
 
// Protected
app.use('/api/chat',       requireAuth, aiLimiter, chatRouter);
app.use('/api/firms',      requireAuth, firmsRouter);
app.use('/api/sentinel',   requireAuth, sentinelRouter);
app.use('/api/gee',        requireAuth, geeRouter);
app.use('/api/planetary',  requireAuth, planetaryRouter);
app.use('/api/drones',     requireAuth, dronesRouter);
app.use('/api/naimos',     requireAuth, naimosRouter);
app.use('/api/copernicus', requireAuth, copernicusRouter);
 
// 404 catch-all for unmatched /api/* routes
app.use('/api/*', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});
 
// ── 12. Static frontend ───────────────────────────────────────────────────────
app.use(express.static(staticRoot, {
  maxAge: '1h',
  setHeaders: (res: Response, filePath: string) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));
 
// ── Clean URL: /login → login.html ───────────────────────────────────────────
app.get('/login', (_req: Request, res: Response) => {
  const loginPath = path.join(staticRoot, 'login.html');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(loginPath, (err) => {
    if (err) {
      console.error('[NAIMOS] sendFile login.html error:', err.message);
      res.status(500).json({ error: 'Login page unavailable.' });
    }
  });
});
 
// ── SPA fallback — ENOENT-safe ────────────────────────────────────────────────
// All non-/api/* GET requests serve index.html.
// The error callback prevents the default Express ENOENT crash that was
// producing: {"error":"ENOENT: no such file or directory, stat '...index.html'"}
app.get('*', (_req: Request, res: Response) => {
  const indexPath = path.join(staticRoot, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('[NAIMOS] sendFile index.html error:', err.message);
      // Graceful degradation: send a minimal HTML page instead of crashing
      res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NAIMOS · Loading…</title>
  <style>
    body { background: #06080E; color: #D4A017; font-family: monospace;
           display: flex; align-items: center; justify-content: center;
           height: 100vh; margin: 0; flex-direction: column; gap: 12px; }
    .spinner { width: 36px; height: 36px; border: 2px solid rgba(212,160,23,0.2);
               border-top-color: #D4A017; border-radius: 50%;
               animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <div>NAIMOS AMS · Initialising…</div>
  <script>
    // Retry once after a brief delay in case of a cold-start race condition
    setTimeout(function(){ window.location.reload(); }, 2500);
  </script>
</body>
</html>`);
    }
  });
});
 
// ── 13. Global error handler ─────────────────────────────────────────────────
app.use(errorHandler);
 
// ── 14. Start server ─────────────────────────────────────────────────────────
if (config.nodeEnv !== 'production') {
  app.listen(PORT, () => {
    console.log(`\n🛰  NAIMOS AMS Backend running on http://localhost:${PORT}`);
    console.log(`   Environment : ${config.nodeEnv}`);
    console.log(`   Static root : ${staticRoot}`);
    logConfigStatus();
  });
} else {
  logConfigStatus();
}
 
export const handler = app;
export default app;