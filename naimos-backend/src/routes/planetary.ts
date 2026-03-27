
import { Router, Request, Response } from 'express';
import { config }                     from '../config';

export const planetaryRouter = Router();

// ─── Dataset / region maps ────────────────────────────────────────────────────

const COLLECTIONS: Record<string, string> = {
  s2:      'sentinel-2-l2a',
  s1:      'sentinel-1-grd',
  landsat: 'landsat-c2-l2',
  lulc:    'io-lulc-9-class',
  jrc:     'jrc-gsw',
  glad:    'glad-forest-change',
};

// Ghana region bounding boxes [west, south, east, north]
const REGION_BBOXES: Record<string, [number, number, number, number]> = {
  western:  [-3.3,  4.7, -1.5,  6.8],
  ashanti:  [-2.5,  5.8, -0.8,  7.3],
  eastern:  [-1.2,  5.8,  0.5,  7.2],
  central:  [-2.2,  5.0, -0.8,  6.2],
  northern: [-1.5,  9.0,  0.5, 10.8],
  upper:    [-0.5, 10.0,  1.2, 11.2],
  brong:    [-2.8,  7.0, -0.5,  8.5],
  volta:    [-0.2,  6.0,  1.2,  9.5],
  greater:  [-0.5,  5.4,  0.3,  6.2],
  ghana:    [-3.3,  4.7,  1.2, 11.2],
};

// ─── Token cache ──────────────────────────────────────────────────────────────

interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();

async function getPCToken(collection: string): Promise<string | null> {
  const cached = tokenCache.get(collection);
  if (cached && Date.now() < cached.expiresAt - 120_000) return cached.token;

  try {
    const resp = await fetch(`${config.pcTokenUrl}/${collection}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;

    const data = await resp.json() as {
      token: string;
      'msft:expiry'?: string;
      msft_expiry?:   string;
    };
    const expiry    = data['msft:expiry'] ?? data.msft_expiry;
    const expiresAt = expiry ? new Date(expiry).getTime() : Date.now() + 3_600_000;

    tokenCache.set(collection, { token: data.token, expiresAt });
    return data.token;
  } catch {
    return null; // SAS signing is optional — unsigned URLs work for search
  }
}

// ─── Shared STAC search ───────────────────────────────────────────────────────

interface SearchOpts {
  collection: string;
  bbox:       [number, number, number, number];
  dateFrom:   string;
  dateTo:     string;
  maxCloud?:  number;
  limit?:     number;
}

async function pcSearch(opts: SearchOpts) {
  const { collection, bbox, dateFrom, dateTo, maxCloud, limit = 10 } = opts;

  const query: Record<string, unknown> = {};
  if (maxCloud !== undefined && collection.includes('sentinel-2')) {
    query['eo:cloud_cover'] = { lte: maxCloud };
  }

  const body: Record<string, unknown> = {
    collections: [collection],
    bbox,
    datetime:    `${dateFrom}T00:00:00Z/${dateTo}T23:59:59Z`,
    limit,
    sortby:      [{ field: 'datetime', direction: 'desc' }],
  };
  if (Object.keys(query).length) body.query = query;

  const resp = await fetch(`${config.pcStacUrl}/search`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(20_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw Object.assign(
      new Error(`PC STAC HTTP ${resp.status}`),
      { status: resp.status, detail: text.slice(0, 300) }
    );
  }

  return resp.json() as Promise<{
    features:        unknown[];
    numberMatched?:  number;
    numberReturned?: number;
  }>;
}

function signAssets(scenes: any[], token: string | null): any[] {
  if (!token) return scenes;
  return scenes.map((s: any) => {
    const signed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries<any>(s.assets ?? {})) {
      signed[k] = {
        ...v,
        href: v.href
          ? v.href + (v.href.includes('?') ? '&' : '?') + token
          : v.href,
      };
    }
    return { ...s, assets: signed };
  });
}

function isoToday(): string  { return new Date().toISOString().slice(0, 10); }
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

// ─── GET /api/planetary/stac ──────────────────────────────────────────────────
// Matches the frontend query-param pattern:
//   ?dataset=s2&region=western&dateFrom=2026-01-26&dateTo=2026-03-27&limit=2

planetaryRouter.get('/stac', async (req: Request, res: Response) => {
  const {
    dataset   = 's2',
    region    = 'ghana',
    dateFrom,
    dateTo,
    limit     = '10',
    maxCloud  = '40',
  } = req.query as Record<string, string>;

  const collection = COLLECTIONS[dataset];
  if (!collection) {
    return res.status(400).json({
      error: `Unknown dataset: "${dataset}". Valid: ${Object.keys(COLLECTIONS).join(', ')}`,
    });
  }

  const bbox        = REGION_BBOXES[region] ?? REGION_BBOXES.ghana;
  const resolvedFrom = dateFrom || isoDaysAgo(30);
  const resolvedTo   = dateTo   || isoToday();

  console.log(`[PC STAC] GET dataset=${dataset} region=${region} ${resolvedFrom}→${resolvedTo}`);

  try {
    const data   = await pcSearch({
      collection,
      bbox,
      dateFrom: resolvedFrom,
      dateTo:   resolvedTo,
      maxCloud: parseFloat(maxCloud) || 40,
      limit:    parseInt(limit, 10)  || 10,
    });

    const token  = await getPCToken(collection);
    const scenes = signAssets(data.features as any[], token);

    return res
      .setHeader('Cache-Control', 'public, max-age=300')
      .json({
        scenes,
        count:    scenes.length,
        total:    data.numberMatched ?? scenes.length,
        dataset,
        region,
        bbox,
        dateFrom: resolvedFrom,
        dateTo:   resolvedTo,
      });

  } catch (err: any) {
    console.error('[PC STAC GET]', err.message);
    return res.status(err.status ?? 502).json({
      error:  err.message,
      detail: err.detail ?? undefined,
    });
  }
});

// ─── POST /api/planetary/search ───────────────────────────────────────────────
// Called by loadPCScenes(), loadPCLULC(), loadPCJRCWater(), loadPCForestAlerts()

planetaryRouter.post('/search', async (req: Request, res: Response) => {
  const {
    dataset  = 's2',
    region   = 'ghana',
    days     = 30,
    maxCloud = 40,
    limit    = 15,
  } = req.body as {
    dataset?:  string;
    region?:   string;
    days?:     number;
    maxCloud?: number;
    limit?:    number;
  };

  const collection = COLLECTIONS[dataset];
  if (!collection) {
    return res.status(400).json({ error: `Unknown dataset: "${dataset}"` });
  }

  const bbox   = REGION_BBOXES[region] ?? REGION_BBOXES.ghana;
  const fromDt = isoDaysAgo(days);
  const toDt   = isoToday();

  console.log(`[PC STAC] POST dataset=${dataset} region=${region} days=${days} cloud≤${maxCloud}`);

  try {
    const data   = await pcSearch({ collection, bbox, dateFrom: fromDt, dateTo: toDt, maxCloud, limit });
    const token  = await getPCToken(collection);
    const scenes = signAssets(data.features as any[], token);

    return res
      .setHeader('Cache-Control', 'public, max-age=300')
      .json({ scenes, count: scenes.length, dataset, region, fromDt, toDt });

  } catch (err: any) {
    console.error('[PC STAC POST]', err.message);
    return res.status(err.status ?? 502).json({
      error:  err.message,
      detail: err.detail ?? undefined,
    });
  }
});

// ─── GET /api/planetary/token/:dataset ───────────────────────────────────────
// Called by window.getPCToken() in api-client.js

planetaryRouter.get('/token/:dataset', async (req: Request, res: Response) => {
  const collection = COLLECTIONS[req.params.dataset];
  if (!collection) {
    return res.status(400).json({ error: `Unknown dataset: "${req.params.dataset}"` });
  }

  const token = await getPCToken(collection);
  if (!token) {
    return res.status(503).json({ error: 'Could not obtain Planetary Computer SAS token.' });
  }

  const cached    = tokenCache.get(collection);
  const expiresAt = cached ? new Date(cached.expiresAt).toISOString() : null;
  return res.json({ token, expiresAt });
});

// ─── GET /api/planetary/health ────────────────────────────────────────────────

planetaryRouter.get('/health', async (_req: Request, res: Response) => {
  try {
    const resp = await fetch(`${config.pcStacUrl}/`, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return res.json({ status: 'ok', stacUrl: config.pcStacUrl });
  } catch (err: any) {
    return res.status(502).json({ status: 'error', message: err.message });
  }
});