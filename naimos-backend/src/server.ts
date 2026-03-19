import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { chatRouter } from './routes/chat';
import { firmsRouter } from './routes/firms';
import { sentinelRouter } from './routes/sentinel';
import { geeRouter } from './routes/gee';
import { planetaryRouter } from './routes/planetary';
import { healthRouter } from './routes/health';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './middleware/logger';

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate limiting ─────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'AI rate limit reached. Wait 60 seconds.' },
});

app.use(limiter);
app.use(express.json({ limit: '1mb' }));
app.use(logger);

// ── API Routes ────────────────────────────────────────────
app.use('/api/health',    healthRouter);
app.use('/api/chat',      aiLimiter, chatRouter);
app.use('/api/firms',     firmsRouter);
app.use('/api/sentinel',  sentinelRouter);
app.use('/api/gee',       geeRouter);
app.use('/api/planetary', planetaryRouter);

// ── Serve static frontend ─────────────────────────────────
app.use(express.static(path.join(__dirname, '../../')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../index.html'));
});

// ── Error handler ─────────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`\n🛰  NAIMOS AMS Backend running on http://localhost:${PORT}`);
  console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Gemini AI   : ${process.env.GEMINI_API_KEY      ? '✓ key set'         : '✗ GEMINI_API_KEY missing'}`);
  console.log(`   NASA FIRMS  : ${process.env.FIRMS_MAP_KEY        ? '✓ key set'         : '⚠ FIRMS_MAP_KEY missing'}`);
  console.log(`   Sentinel Hub: ${process.env.SENTINEL_CLIENT_ID   ? '✓ credentials set' : '⚠ SENTINEL credentials missing'}`);
  console.log(`   GEE         : ${process.env.GEE_SERVICE_ACCOUNT  ? '✓ service account set' : '✗ GEE_SERVICE_ACCOUNT missing'}`);
});

export default app;