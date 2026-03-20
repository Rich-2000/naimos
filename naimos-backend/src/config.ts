// In production (Vercel), environment variables are injected automatically —
// dotenv is only needed for local development via the .env file.
// Using a relative path like '../.env' breaks on Vercel, so we guard it.
if (process.env.NODE_ENV !== 'production') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv');
  dotenv.config({ path: '../.env' });
}

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

  // ── Google Earth Engine (Service Account OAuth2) ──────────────────────────
  geeServiceAccount: process.env.GEE_SERVICE_ACCOUNT || '',
  // Vercel stores the private key with literal \n — replace them with real newlines
  geePrivateKey: (process.env.GEE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  geeProject:    process.env.GEE_PROJECT || 'projects/naimo-gee',

  // ── Microsoft Planetary Computer (no auth needed) ─────────────────────────
  pcStacUrl:  'https://planetarycomputer.microsoft.com/api/stac/v1',
  pcTokenUrl: 'https://planetarycomputer.microsoft.com/api/sas/v1/token',

  // ── CORS ──────────────────────────────────────────────────────────────────
  allowedOrigin: process.env.ALLOWED_ORIGIN || '*',
} as const;