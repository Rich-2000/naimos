/**
 * copernicus.ts
 *
 * Backend proxy for the Copernicus Data Space Ecosystem STAC / REST catalogue.
 * Mounted at /api/copernicus  (protected by requireAuth in server.ts)
 *
 * Why: catalogue.dataspace.copernicus.eu returns 403 for unauthenticated
 * browser requests. OAuth2 client_credentials are kept server-side only.
 *
 * Routes:
 *   GET /api/copernicus/stac    – scene search (Sentinel-1 / Sentinel-2)
 *   GET /api/copernicus/health  – verify credentials + upstream reachability
 *
 * Env vars (added to your .env — see config.ts):
 *   COPERNICUS_CLIENT_ID
 *   COPERNICUS_CLIENT_SECRET
 *
 * NOTE: These are separate from SENTINEL_CLIENT_ID / SENTINEL_CLIENT_SECRET.
 * Sentinel Hub = WMS image tiles. Copernicus = STAC catalogue search.
 */

import { Router, Request, Response } from 'express';
import { getCopernicusToken }         from '../lib/copernicusAuth';
import { config }                     from '../config';

export const copernicusRouter = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const CATALOGUE_BASE =
  'https://catalogue.dataspace.copernicus.eu/resto/api/collections';

const STAC_SEARCH_URL =
  'https://catalogue.dataspace.copernicus.eu/stac/search';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildCatalogueUrl(collection: string, params: URLSearchParams): string {
  return `${CATALOGUE_BASE}/${collection}/search.json?${params}`;
}

function buildStacBody(opts: {
  collection:   string;
  bbox:         string;
  dateFrom:     string;
  dateTo:       string;
  cloudMax?:    string;
  productType?: string;
  maxRecords:   string;
}): Record<string, unknown> {
  const { collection, bbox, dateFrom, dateTo, cloudMax, productType, maxRecords } = opts;

  const STAC_COLLECTION_MAP: Record<string, string> = {
    Sentinel2: 'SENTINEL-2',
    Sentinel1: 'SENTINEL-1',
    Landsat8:  'LANDSAT-8',
    Landsat9:  'LANDSAT-9',
  };

  const bboxArr = bbox.split(',').map(Number);
  const body: Record<string, unknown> = {
    collections: [STAC_COLLECTION_MAP[collection] ?? collection],
    bbox:        bboxArr,
    datetime:    `${dateFrom}T00:00:00Z/${dateTo}T23:59:59Z`,
    limit:       parseInt(maxRecords, 10) || 5,
    sortby:      [{ field: 'datetime', direction: 'desc' }],
  };

  const query: Record<string, unknown> = {};
  if (cloudMax)    query['eo:cloud_cover']  = { lte: parseFloat(cloudMax) };
  if (productType) query['s1:product_type'] = { eq: productType };
  if (Object.keys(query).length) body.query = query;

  return body;
}

function normaliseStacResponse(stacData: {
  features?:      unknown[];
  numberMatched?: number;
  numberReturned?: number;
}): Record<string, unknown> {
  return {
    type:       'FeatureCollection',
    properties: { totalResults: stacData.numberMatched ?? stacData.features?.length ?? 0 },
    features:   stacData.features ?? [],
    _source:    'stac-fallback',
  };
}

// ─── GET /api/copernicus/stac ─────────────────────────────────────────────────

copernicusRouter.get('/stac', async (req: Request, res: Response) => {
  const {
    collection  = 'Sentinel2',
    bbox,
    dateFrom,
    dateTo,
    cloudMax,
    productType,
    maxRecords  = '5',
  } = req.query as Record<string, string>;

  if (!bbox || !dateFrom || !dateTo) {
    return res.status(400).json({
      error: 'Missing required query params: bbox, dateFrom, dateTo',
    });
  }

  // ── Step 1: Obtain OAuth2 token ──────────────────────────────────────────
  const token = await getCopernicusToken();

  if (!token) {
    console.warn(
      '[Copernicus STAC] No OAuth2 token — COPERNICUS_CLIENT_ID/SECRET not set or fetch failed. ' +
      'Attempting unauthenticated STAC fallback.'
    );
  }

  // ── Step 2: Try authenticated REST catalogue ─────────────────────────────
  if (token) {
    const params = new URLSearchParams({
      startDate:      `${dateFrom}T00:00:00Z`,
      completionDate: `${dateTo}T23:59:59Z`,
      box:            bbox,
      maxRecords,
      sortParam:      'startDate',
      sortOrder:      'descending',
    });
    if (cloudMax)    params.set('cloudCover',  `[0,${cloudMax}]`);
    if (productType) params.set('productType', productType);

    try {
      const upstream = await fetch(buildCatalogueUrl(collection, params), {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent':  'NAIMOS-AMS/12.0 (Ghana Anti-Galamsey Platform)',
          Accept:        'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (upstream.ok) {
        const data = await upstream.json();
        return res
          .setHeader('Cache-Control', 'public, max-age=300')
          .setHeader('X-Copernicus-Source', 'rest-catalogue')
          .json(data);
      }

      console.warn(`[Copernicus STAC] REST catalogue ${upstream.status} — trying STAC fallback`);
    } catch (err: any) {
      console.warn('[Copernicus STAC] REST catalogue error:', err.message);
    }
  }

  // ── Step 3: STAC search API fallback ─────────────────────────────────────
  try {
    const stacBody = buildStacBody({
      collection, bbox, dateFrom, dateTo, cloudMax, productType, maxRecords,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent':   'NAIMOS-AMS/12.0',
      Accept:         'application/geo+json, application/json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const stacResp = await fetch(STAC_SEARCH_URL, {
      method:  'POST',
      headers,
      body:    JSON.stringify(stacBody),
      signal:  AbortSignal.timeout(15_000),
    });

    if (stacResp.ok) {
      const stacData = await stacResp.json() as {
        features?: unknown[];
        numberMatched?: number;
        numberReturned?: number;
      };
      return res
        .setHeader('Cache-Control', 'public, max-age=300')
        .setHeader('X-Copernicus-Source', 'stac-search')
        .json(normaliseStacResponse(stacData));
    }

    const errText = await stacResp.text().catch(() => '');
    console.error('[Copernicus STAC] Both paths failed. Last status:', stacResp.status);
    return res.status(stacResp.status).json({
      error:  `Copernicus: HTTP ${stacResp.status}`,
      detail: errText.slice(0, 200),
      hint:   'Set COPERNICUS_CLIENT_ID and COPERNICUS_CLIENT_SECRET in .env',
    });

  } catch (err: any) {
    console.error('[Copernicus STAC] Unexpected error:', err.message);
    return res.status(502).json({ error: err.message });
  }
});

// ─── GET /api/copernicus/health ───────────────────────────────────────────────

copernicusRouter.get('/health', async (_req: Request, res: Response) => {
  const hasCredentials = !!(config.copernicusClientId && config.copernicusClientSecret);

  if (!hasCredentials) {
    return res.status(503).json({
      status:  'degraded',
      message: 'COPERNICUS_CLIENT_ID / COPERNICUS_CLIENT_SECRET not set.',
      hint:    'Register at dataspace.copernicus.eu → My Account → OAuth Clients',
    });
  }

  const token = await getCopernicusToken();
  if (!token) {
    return res.status(503).json({
      status:  'error',
      message: 'Credentials present but token fetch failed. Check client ID/secret.',
    });
  }

  return res.json({ status: 'ok', authenticated: true });
});