import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

export const config = {
  port:    Number(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',

  // ── AI ────────────────────────────────────────────────────────────────────
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel:  process.env.GEMINI_MODEL   || 'gemini-2.0-flash',

  // ── NASA FIRMS ────────────────────────────────────────────────────────────
  firmsMapKey: process.env.FIRMS_MAP_KEY || '',

  // ── ESA Sentinel Hub ──────────────────────────────────────────────────────
  sentinelClientId:     process.env.SENTINEL_CLIENT_ID     || '',
  sentinelClientSecret: process.env.SENTINEL_CLIENT_SECRET || '',

  // ── Google Earth Engine (Service Account OAuth2 — no API key needed) ──────
  geeServiceAccount: process.env.GEE_SERVICE_ACCOUNT || '',
  geePrivateKey:     process.env.GEE_PRIVATE_KEY     || '',
  geeProject:        process.env.GEE_PROJECT         || 'projects/naimo-gee',

  // ── Microsoft Planetary Computer (no auth needed) ─────────────────────────
  pcStacUrl:  'https://planetarycomputer.microsoft.com/api/stac/v1',
  pcTokenUrl: 'https://planetarycomputer.microsoft.com/api/sas/v1/token',

  // ── CORS ──────────────────────────────────────────────────────────────────
  allowedOrigin: process.env.ALLOWED_ORIGIN || '*',
} as const;