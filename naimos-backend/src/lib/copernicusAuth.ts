/**
 * copernicusAuth.ts
 *
 * OAuth2 client-credentials token manager for the Copernicus Data Space Ecosystem.
 * Reads credentials from config (which reads from .env).
 *
 * Token is cached in memory and auto-refreshed 2 min before expiry.
 * If credentials are absent, returns null — callers fall back to
 * Microsoft Planetary Computer.
 *
 * Register credentials at:
 *   https://dataspace.copernicus.eu/ → My Account → OAuth Clients
 *   grant_type: client_credentials
 *
 * NOTE: These are DIFFERENT from SENTINEL_CLIENT_ID / SENTINEL_CLIENT_SECRET
 * (those are for Sentinel Hub WMS image rendering).
 * These are for the STAC catalogue search API.
 */

import { config } from '../config';

const TOKEN_URL =
  'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';

interface TokenCache {
  accessToken: string;
  expiresAt:   number; // epoch ms
}

let _cache: TokenCache | null = null;

export async function getCopernicusToken(): Promise<string | null> {
  const { copernicusClientId: clientId, copernicusClientSecret: clientSecret } = config;

  if (!clientId || !clientSecret) {
    // Credentials not configured — callers should fall back gracefully
    return null;
  }

  // Return valid cached token (with 2-min safety margin)
  if (_cache && Date.now() < _cache.expiresAt - 120_000) {
    return _cache.accessToken;
  }

  try {
    const body = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    });

    const resp = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal:  AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('[CopernicusAuth] Token request failed:', resp.status, text.slice(0, 200));
      return null;
    }

    const json = await resp.json() as { access_token: string; expires_in: number };

    _cache = {
      accessToken: json.access_token,
      expiresAt:   Date.now() + json.expires_in * 1_000,
    };

    console.log(
      `[CopernicusAuth] Token refreshed — expires in ${Math.round(json.expires_in / 60)} min`
    );
    return _cache.accessToken;

  } catch (err: any) {
    console.error('[CopernicusAuth] Unexpected error:', err.message);
    return null;
  }
}