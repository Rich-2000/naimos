/**
 * ============================================================
 *  NAIMOS AMS — Centralised Configuration
 *  Merged: original fields + Copernicus OAuth2 additions
 * ============================================================
 */
if (process.env.NODE_ENV !== 'production') {
  const dotenv = require('dotenv');
  dotenv.config({ path: '../.env' });
}

function requireEnv(key: string): string {
  const val = process.env[key] || '';
  if (process.env.NODE_ENV === 'production' && !val) {
    console.error(`[CONFIG] FATAL: Required env var "${key}" is not set.`);
    process.exit(1);
  }
  return val;
}

function optionalEnv(key: string, fallback = ''): string {
  return process.env[key] || fallback;
}

export const config = {
  // ── Server ────────────────────────────────────────────────────────────────
  port:    Number(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',

  // ── Auth / DB (required in production) ───────────────────────────────────
  jwtSecret:  requireEnv('JWT_SECRET'),
  mongodbUri: requireEnv('MONGODB_URI'),

  // ── Gemini AI ─────────────────────────────────────────────────────────────
  geminiApiKey: optionalEnv('GEMINI_API_KEY'),
  geminiModel:  optionalEnv('GEMINI_MODEL', 'gemini-2.0-flash'),

  // ── NASA FIRMS ────────────────────────────────────────────────────────────
  firmsMapKey: optionalEnv('FIRMS_MAP_KEY'),

  // ── ESA Sentinel Hub (WMS / image rendering) ──────────────────────────────
  sentinelClientId:     optionalEnv('SENTINEL_CLIENT_ID'),
  sentinelClientSecret: optionalEnv('SENTINEL_CLIENT_SECRET'),

  // ── Copernicus Data Space Ecosystem (STAC catalogue, OAuth2) ─────────────
  // Register at: https://dataspace.copernicus.eu/ → My Account → OAuth Clients
  // grant_type: client_credentials   (SEPARATE from Sentinel Hub above)
  copernicusClientId:     optionalEnv('COPERNICUS_CLIENT_ID'),
  copernicusClientSecret: optionalEnv('COPERNICUS_CLIENT_SECRET'),

  // ── Google Earth Engine ───────────────────────────────────────────────────
  geeServiceAccount: optionalEnv('GEE_SERVICE_ACCOUNT'),
  geePrivateKey:     (optionalEnv('GEE_PRIVATE_KEY')).replace(/\\n/g, '\n'),
  geeProject:        optionalEnv('GEE_PROJECT', 'projects/naimo-gee'),

  // ── Cloudinary (drone imagery) ────────────────────────────────────────────
  cloudinaryUrl:         optionalEnv('CLOUDINARY_URL'),
  cloudinaryCloudName:   optionalEnv('CLOUDINARY_CLOUD_NAME'),
  cloudinaryApikey:      optionalEnv('CLOUDINARY_API_KEY'),
  cloudinaryApiSecret:   optionalEnv('CLOUDINARY_API_SECRET'),
  cloudinaryDroneFolder: optionalEnv('CLOUDINARY_DRONE_FOLDER'),

  // ── Microsoft Planetary Computer ──────────────────────────────────────────
  pcStacUrl:  'https://planetarycomputer.microsoft.com/api/stac/v1',
  pcTokenUrl: 'https://planetarycomputer.microsoft.com/api/sas/v1/token',

  // ── CORS ──────────────────────────────────────────────────────────────────
  allowedOrigin: optionalEnv('ALLOWED_ORIGIN', 'https://naimos.vercel.app'),
} as const;

export function logConfigStatus(): void {
  const checks: [string, boolean][] = [
    ['JWT_SECRET',                  !!config.jwtSecret],
    ['MONGODB_URI',                 !!config.mongodbUri],
    ['GEMINI_API_KEY',              !!config.geminiApiKey],
    ['FIRMS_MAP_KEY',               !!config.firmsMapKey],
    ['SENTINEL_CLIENT_ID/SECRET',   !!(config.sentinelClientId && config.sentinelClientSecret)],
    ['COPERNICUS_CLIENT_ID/SECRET', !!(config.copernicusClientId && config.copernicusClientSecret)],
    ['GEE_SERVICE_ACCOUNT',         !!config.geeServiceAccount],
    ['CLOUDINARY_URL',              !!config.cloudinaryUrl],
  ];
  console.log('\n[Config] Credential / service status:');
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' — NOT configured (degraded)'}`);
  }
  console.log();
}