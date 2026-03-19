import { Router, Request, Response } from 'express';
import { config } from '../config';

export const planetaryRouter = Router();

const COLLECTIONS: Record<string, string> = {
  s2:      'sentinel-2-l2a',
  s1:      'sentinel-1-grd',
  landsat: 'landsat-c2-l2',
  lulc:    'io-lulc-9-class',
  jrc:     'jrc-gsw',
  glad:    'glad-forest-change',
};

const REGION_BBOXES: Record<string, number[]> = {
  western: [-3.3, 4.7, -1.5, 6.8],
  ashanti: [-2.5, 5.8, -0.8, 7.3],
  ghana:   [-3.3, 4.7,  1.2, 11.2],
};

// Token cache per collection
const tokenCache: Record<string, { token: string; expiry: number }> = {};

async function getPCToken(collection: string): Promise<string | null> {
  const c = tokenCache[collection];
  if (c && Date.now() < c.expiry - 120_000) return c.token;

  try {
    const resp = await fetch(`${config.pcTokenUrl}/${collection}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { token: string; 'msft:expiry': string };
    tokenCache[collection] = {
      token:  data.token,
      expiry: new Date(data['msft:expiry']).getTime(),
    };
    return data.token;
  } catch {
    return null; // Planetary Computer STAC still works without token for search
  }
}

/**
 * GET /api/planetary/token/:dataset
 * Returns a fresh SAS token for the given dataset (never exposes to browser directly — 
 * the browser gets it via this safe proxy and can use it for direct blob URLs).
 */
planetaryRouter.get('/token/:dataset', async (req: Request, res: Response) => {
  const dataset    = req.params.dataset;
  const collection = COLLECTIONS[dataset];
  if (!collection) {
    return res.status(400).json({ error: `Unknown dataset: ${dataset}` });
  }

  const token = await getPCToken(collection);
  if (!token) {
    return res.status(503).json({ error: 'Could not obtain Planetary Computer token.' });
  }

  const expiry = tokenCache[collection]?.expiry;
  return res.json({ token, expiresAt: expiry ? new Date(expiry).toISOString() : null });
});

/**
 * POST /api/planetary/search
 * Body: { dataset, region, days?, maxCloud? }
 * 
 * Searches the PC STAC API server-side, signs asset URLs with SAS tokens,
 * and returns clean scene list to the frontend.
 */
planetaryRouter.post('/search', async (req: Request, res: Response) => {
  const { dataset = 's2', region = 'western', days = 30, maxCloud = 40 } = req.body as {
    dataset?: string;
    region?: string;
    days?: number;
    maxCloud?: number;
  };

  const collection = COLLECTIONS[dataset];
  if (!collection) {
    return res.status(400).json({ error: `Unknown dataset: ${dataset}` });
  }

  const bbox = REGION_BBOXES[region] || REGION_BBOXES.ghana;
  const today   = new Date();
  const fromDt  = new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);
  const toDt    = today.toISOString().slice(0, 10);

  const query: Record<string, unknown> = {};
  if (collection.includes('sentinel-2') && maxCloud) {
    query['eo:cloud_cover'] = { lte: maxCloud };
  }

  console.log(`[PC] Searching ${collection} for ${region} (${fromDt} → ${toDt})`);

  const body = {
    collections: [collection],
    bbox,
    datetime: `${fromDt}T00:00:00Z/${toDt}T23:59:59Z`,
    query,
    limit: 15,
    sortby: [{ field: 'datetime', direction: 'desc' }],
  };

  const stacResp = await fetch(`${config.pcStacUrl}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!stacResp.ok) {
    return res.status(stacResp.status).json({ error: `STAC search failed: HTTP ${stacResp.status}` });
  }

  const data = await stacResp.json() as { features?: unknown[] };
  const scenes = data.features || [];

  // Optionally sign asset URLs with SAS token
  const token = await getPCToken(collection);

  const enriched = (scenes as any[]).map((s: any) => {
    const signedAssets: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.assets || {})) {
      const asset = v as any;
      signedAssets[k] = {
        ...asset,
        href: token && asset.href
          ? asset.href + (asset.href.includes('?') ? '&' : '?') + token
          : asset.href,
      };
    }
    return { ...s, assets: signedAssets };
  });

  return res.json({ scenes: enriched, count: enriched.length, dataset, region, fromDt, toDt });
});
