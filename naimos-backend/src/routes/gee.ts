/**
 * gee.ts — Google Earth Engine REST API v1
 * NDVI + Change Detection for Ghana galamsey / surface-mining monitoring.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ROOT-CAUSE FIX: "Parameter 'image' is required and may not be null"
 *
 * The bug was TWO wrong argument names, verified against the official EE Python
 * SDK test suite (earthengine-api/python/ee/tests/image_test.py):
 *
 *   Function              Wrong key used    Correct key (SDK-verified)
 *   ──────────────────    ──────────────    ──────────────────────────
 *   Image.visualize       'input'      →    'image'
 *   Image.subtract        'input'      →    'image1'   (2nd arg: 'image2')
 *
 * All other argument names were already correct:
 *   Image.normalizedDifference  → 'input', 'bandNames'       ✓
 *   Image.select                → 'input', 'bandSelectors'   ✓
 *   Image.rename                → 'input', 'names'           ✓
 *   ImageCollection.mosaic      → 'collection'               ✓
 *   ImageCollection.load        → 'id'                       ✓
 *   Collection.filter           → 'collection', 'filter'     ✓
 *   Filter.dateRangeContains    → 'leftValue', 'rightField'  ✓
 *   Filter.lessThan             → 'leftField', 'rightValue'  ✓
 *   Filter.and                  → 'filters'                  ✓
 *   DateRange                   → 'start', 'end'             ✓
 *   Date                        → 'value'                    ✓
 *
 * Expression graph design rule:
 *   Every node lives in the flat top-level `values` map.
 *   Arguments referencing another node use { valueReference: "<key>" }.
 *   Leaf values use { constantValue: v }.
 *   NO inline nested functionInvocationValue objects — GEE REST
 *   computePixels does not support inline nesting for Image operations.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Router, Request, Response } from 'express';
import { createSign } from 'crypto';
import { config } from '../config';

export const geeRouter = Router();

// ── Bounding boxes ─────────────────────────────────────────────────────────────
const BBOXES: Record<string, { west: number; south: number; east: number; north: number }> = {
  western: { west: -3.3, south: 4.7,  east: -1.5, north: 6.8  },
  ashanti: { west: -2.5, south: 5.8,  east: -0.8, north: 7.3  },
  ghana:   { west: -3.3, south: 4.7,  east:  1.2, north: 11.2 },
};

// ── Sentinel-2 collection ID ───────────────────────────────────────────────────
const S2_COLLECTION = 'COPERNICUS/S2_SR_HARMONIZED';

// ── OAuth2 token cache ─────────────────────────────────────────────────────────
let _cachedToken: string | null = null;
let _tokenExpiry   = 0;
let _clockOffsetMs = 0;
let _clockSynced   = false;

async function syncGoogleClock(): Promise<void> {
  if (_clockSynced) return;
  try {
    const t0  = Date.now();
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    'grant_type=invalid',
      signal:  AbortSignal.timeout(6_000),
    });
    const t1 = Date.now();
    const d  = res.headers.get('date');
    if (d) {
      _clockOffsetMs = new Date(d).getTime() - Math.round((t0 + t1) / 2);
      console.log(`[GEE] Clock sync — offset ${_clockOffsetMs}ms`);
    }
  } catch {
    console.warn('[GEE] Clock sync failed — using local clock');
  }
  _clockSynced = true;
}

async function getAccessToken(): Promise<string> {
  await syncGoogleClock();
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiry - 5 * 60_000) return _cachedToken;

  const sa  = config.geeServiceAccount as string | undefined;
  const key = config.geePrivateKey     as string | undefined;
  if (!sa || !key) throw new Error('GEE_SERVICE_ACCOUNT or GEE_PRIVATE_KEY missing from .env');

  const privateKey = key.replace(/\\n/g, '\n');
  const nowSec     = Math.floor((now + _clockOffsetMs) / 1000);
  const b64u       = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

  const hdr  = b64u({ alg: 'RS256', typ: 'JWT' });
  const pay  = b64u({
    iss:   sa, sub: sa,
    aud:   'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/earthengine.readonly',
    iat:   nowSec - 30,
    exp:   nowSec + 3570,
  });
  const unsigned = `${hdr}.${pay}`;
  const signer   = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(privateKey, 'base64url');

  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  `${unsigned}.${sig}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!tr.ok) {
    const txt = await tr.text();
    if (txt.includes('invalid_grant') || txt.includes('timeframe')) _clockSynced = false;
    throw new Error(`OAuth2 failed (${tr.status}): ${txt}`);
  }

  const td     = await tr.json() as { access_token: string; expires_in: number };
  _cachedToken = td.access_token;
  _tokenExpiry = now + td.expires_in * 1000;
  console.log(`[GEE] Token obtained — expires in ${td.expires_in}s`);
  return _cachedToken;
}

// ══════════════════════════════════════════════════════════════════════════════
// Expression graph
// ══════════════════════════════════════════════════════════════════════════════

type ConstantNode   = { constantValue: unknown };
type ReferenceNode  = { valueReference: string };
type InvocationNode = {
  functionInvocationValue: {
    functionName: string;
    arguments: Record<string, ExprNode>;
  };
};
type ArrayValueNode = { arrayValue: { values: ReferenceNode[] } };
type ExprNode       = ConstantNode | ReferenceNode | InvocationNode | ArrayValueNode;
type ValueMap       = Record<string, ExprNode>;

class ExprGraph {
  readonly values: ValueMap = {};
  private counter = 0;

  private register(v: ExprNode): string {
    const k = String(this.counter++);
    this.values[k] = v;
    return k;
  }

  fn(functionName: string, args: Record<string, ExprNode>): string {
    return this.register({
      functionInvocationValue: { functionName, arguments: args },
    });
  }

  ref(key: string): ReferenceNode {
    return { valueReference: key };
  }

  build(resultKey: string): { values: ValueMap; result: string } {
    return { values: this.values, result: resultKey };
  }
}

/** Inline constant leaf. */
const C = (v: unknown): ConstantNode => ({ constantValue: v });

// ══════════════════════════════════════════════════════════════════════════════
// Node constructors
// ══════════════════════════════════════════════════════════════════════════════

function makeDate(g: ExprGraph, iso: string): string {
  return g.fn('Date', { value: C(iso) });
}

function makeDateRange(g: ExprGraph, startKey: string, endKey: string): string {
  return g.fn('DateRange', { start: g.ref(startKey), end: g.ref(endKey) });
}

/**
 * Filter.dateRangeContains
 * Verified: filter_test.py → test_date_with_datetime
 */
function makeDateFilter(g: ExprGraph, startIso: string, endIso: string): string {
  const rangeKey = makeDateRange(g, makeDate(g, startIso), makeDate(g, endIso));
  return g.fn('Filter.dateRangeContains', {
    leftValue:  g.ref(rangeKey),
    rightField: C('system:time_start'),
  });
}

/**
 * Filter.lessThan
 * Verified: filter_test.py — "Note: not Filter.lt."
 */
function makeCloudFilter(g: ExprGraph, maxCloudPct: number): string {
  return g.fn('Filter.lessThan', {
    leftField:  C('CLOUDY_PIXEL_PERCENTAGE'),
    rightValue: C(maxCloudPct),
  });
}

/**
 * Filter.and
 * Verified: filter_test.py → test_or (identical array pattern)
 */
function makeAndFilter(g: ExprGraph, ...filterKeys: string[]): string {
  return g.fn('Filter.and', {
    filters: { arrayValue: { values: filterKeys.map(k => g.ref(k)) } } as ArrayValueNode,
  });
}

/**
 * Build one NDVI image node.
 * All argument names verified against image_test.py + imagecollection_test.py.
 */
function makeNDVINode(g: ExprGraph, startIso: string, endIso: string): string {
  // 1. Load ImageCollection
  const collKey = g.fn('ImageCollection.load', { id: C(S2_COLLECTION) });

  // 2. Combined filter
  const andFiltKey = makeAndFilter(
    g,
    makeDateFilter(g, startIso, endIso),
    makeCloudFilter(g, 30),
  );

  // 3. Collection.filter — verified collection_test.py
  const filteredKey = g.fn('Collection.filter', {
    collection: g.ref(collKey),
    filter:     g.ref(andFiltKey),
  });

  // 4. ImageCollection.mosaic — arg: 'collection' — verified imagecollection_test.py
  const mosaicKey = g.fn('ImageCollection.mosaic', {
    collection: g.ref(filteredKey),
  });

  // 5. Image.select — args: 'input', 'bandSelectors' — verified image_test.py
  const selectedKey = g.fn('Image.select', {
    input:         g.ref(mosaicKey),
    bandSelectors: C(['B8', 'B4']),
  });

  // 6. Image.normalizedDifference — args: 'input', 'bandNames' — verified image_test.py
  //    Output band is named 'nd' by GEE convention.
  return g.fn('Image.normalizedDifference', {
    input:     g.ref(selectedKey),
    bandNames: C(['B8', 'B4']),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Expression builders
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Single-period NDVI visualisation.
 *
 * Image.visualize — first arg is 'image' NOT 'input'
 * Verified: image_test.py → test_visualize
 */
function buildNDVIExpression(fromDt: string, toDt: string): { values: ValueMap; result: string } {
  const g       = new ExprGraph();
  const ndviKey = makeNDVINode(g, fromDt, toDt);

  const visKey = g.fn('Image.visualize', {
    image:   g.ref(ndviKey),    // ← 'image', NOT 'input'
    bands:   C(['nd']),
    min:     C(-0.2),
    max:     C(0.8),
    palette: C([
      '#d73027', // bare / active mining
      '#fc8d59', // stressed / sparse
      '#fee08b', // low vegetation
      '#d9ef8b', // moderate vegetation
      '#91cf60', // healthy vegetation
      '#1a9850', // dense forest
    ]),
  });

  return g.build(visKey);
}

/**
 * Two-period NDVI change detection: recent − older.
 *   positive  → vegetation recovery
 *   negative  → vegetation loss (likely mining)
 *
 * Image.subtract — args: 'image1' (minuend), 'image2' (subtrahend)
 * Verified: image_test.py → test_subtract
 *
 * Image.visualize — first arg: 'image' NOT 'input'
 * Verified: image_test.py → test_visualize
 */
function buildNDVIChangeExpression(
  farDt: string,
  midDt: string,
  toDt:  string,
): { values: ValueMap; result: string } {
  const g          = new ExprGraph();
  const ndviOldKey = makeNDVINode(g, farDt, midDt);
  const ndviNewKey = makeNDVINode(g, midDt, toDt);

  // Image.subtract: { image1: minuend, image2: subtrahend }
  const diffKey = g.fn('Image.subtract', {
    image1: g.ref(ndviNewKey),   // ← 'image1', NOT 'input'
    image2: g.ref(ndviOldKey),
  });

  // Image.rename: { input, names } — verified image_test.py → test_rename
  const renamedKey = g.fn('Image.rename', {
    input: g.ref(diffKey),
    names: C(['change']),
  });

  const visKey = g.fn('Image.visualize', {
    image:   g.ref(renamedKey),  // ← 'image', NOT 'input'
    bands:   C(['change']),
    min:     C(-0.5),
    max:     C(0.5),
    palette: C([
      '#8B0000', // severe loss — active strip mining
      '#d73027', // heavy loss
      '#fc8d59', // moderate loss
      '#FFFFBF', // no change
      '#91cf60', // moderate gain
      '#1a9850', // strong recovery
      '#004d00', // dense regrowth
    ]),
  });

  return g.build(visKey);
}

// ══════════════════════════════════════════════════════════════════════════════
// GEE computePixels
// ══════════════════════════════════════════════════════════════════════════════

type GEEOk  = { ok: true;  buffer: Buffer; contentType: string };
type GEEErr = { ok: false; status: number; error: string; hint: string };

async function callComputePixels(
  token:      string,
  project:    string,
  expression: { values: ValueMap; result: string },
  bbox:       { west: number; south: number; east: number; north: number },
  size = 512,
): Promise<GEEOk | GEEErr> {
  const endpoint = `https://earthengine.googleapis.com/v1/${project}/image:computePixels`;

  const scaleX = (bbox.east  - bbox.west)  / size;
  const scaleY = (bbox.north - bbox.south) / size;

  const payload = {
    expression,
    fileFormat: 'PNG',
    grid: {
      dimensions:      { width: size, height: size },
      affineTransform: {
        scaleX,
        shearX:     0,
        translateX: bbox.west,
        shearY:     0,
        scaleY:     -scaleY,   // negative → top-left origin
        translateY: bbox.north,
      },
      crsCode: 'EPSG:4326',
    },
  };

  // Uncomment to inspect exact payload:
  // console.log('[GEE payload]', JSON.stringify(payload, null, 2));

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body:   JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, error: `GEE network error: ${msg}`, hint: 'Check server connectivity.' };
  }

  if (!upstream.ok) {
    let errData: Record<string, unknown> = {};
    try { errData = (await upstream.json()) as Record<string, unknown>; } catch { /* ignore */ }
    console.error('[GEE error]', JSON.stringify(errData));

    const errObj = errData['error'] as Record<string, unknown> | undefined;
    const error  = (errObj?.['message'] as string | undefined) ?? `GEE HTTP ${upstream.status}`;
    const hints: Record<number, string> = {
      400: 'Bad expression — check function names and argument keys.',
      401: 'Invalid OAuth2 token — check GEE_SERVICE_ACCOUNT and GEE_PRIVATE_KEY in .env.',
      403: 'Access denied — ensure Earth Engine API is enabled and the service account has "Earth Engine Resource Viewer" IAM role.',
      429: 'Quota exceeded — wait and retry.',
      500: 'GEE internal error — retry in a moment.',
      503: 'GEE temporarily unavailable — retry in a moment.',
    };
    return {
      ok:     false,
      status: upstream.status,
      error,
      hint:   hints[upstream.status] ?? `Unexpected GEE error (HTTP ${upstream.status}).`,
    };
  }

  const buffer      = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get('content-type') ?? 'image/png';
  return { ok: true, buffer, contentType };
}

// ══════════════════════════════════════════════════════════════════════════════
// Route helpers
// ══════════════════════════════════════════════════════════════════════════════

function resolveRegion(raw: unknown): {
  region: string;
  bbox: { west: number; south: number; east: number; north: number };
} {
  const region = (typeof raw === 'string' ? raw : 'western').toLowerCase();
  return { region, bbox: BBOXES[region] ?? BBOXES.western };
}

function getProject(): string {
  return (config.geeProject as string | undefined) || 'projects/earthengine-public';
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function acquireToken(res: Response): Promise<string | null> {
  try {
    return await getAccessToken();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[GEE auth]', msg);
    res.status(500).json({ error: 'Authentication failed', detail: msg });
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Routes
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/gee/ndvi
 *
 * Query params:
 *   region  western | ashanti | ghana   (default: western)
 *   days    1–180                       (default: 45)
 *   size    256–1024                    (default: 512)
 */
geeRouter.get('/ndvi', async (req: Request, res: Response) => {
  const { region, bbox } = resolveRegion(req.query.region);
  const days   = Math.max(1,   Math.min(180,  parseInt((req.query.days as string) || '45',  10)));
  const size   = Math.max(256, Math.min(1024, parseInt((req.query.size as string) || '512', 10)));
  const toDt   = daysAgo(0);
  const fromDt = daysAgo(days);

  console.log(`[GEE] NDVI "${region}" (${fromDt} → ${toDt})`);

  const token = await acquireToken(res);
  if (!token) return;

  const result = await callComputePixels(
    token,
    getProject(),
    buildNDVIExpression(fromDt, toDt),
    bbox,
    size,
  );

  if (!result.ok) return res.status(result.status).json({ error: result.error, hint: result.hint });

  console.log(`[GEE] NDVI OK — ${result.buffer.byteLength} bytes`);
  res.setHeader('Content-Type',    result.contentType);
  res.setHeader('Cache-Control',   'public, max-age=1800');
  res.setHeader('X-GEE-Region',    region);
  res.setHeader('X-GEE-DateRange', `${fromDt}/${toDt}`);
  return res.send(result.buffer);
});

/**
 * GET /api/gee/ndvi-change
 *
 * Query params:
 *   region  western | ashanti | ghana   (default: western)
 *   months  1–12                        (default: 3)
 *   size    256–1024                    (default: 512)
 *
 * Timeline: [farDt ── older window ── midDt ── recent window ── toDt]
 */
geeRouter.get('/ndvi-change', async (req: Request, res: Response) => {
  const { region, bbox } = resolveRegion(req.query.region);
  const months = Math.max(1,   Math.min(12,   parseInt((req.query.months as string) || '3',   10)));
  const size   = Math.max(256, Math.min(1024, parseInt((req.query.size   as string) || '512', 10)));

  const toDt  = daysAgo(0);
  const midDt = daysAgo(months * 30);
  const farDt = daysAgo(months * 60);

  console.log(`[GEE] Change "${region}" A:${farDt}→${midDt}  B:${midDt}→${toDt}`);

  const token = await acquireToken(res);
  if (!token) return;

  const result = await callComputePixels(
    token,
    getProject(),
    buildNDVIChangeExpression(farDt, midDt, toDt),
    bbox,
    size,
  );

  if (!result.ok) return res.status(result.status).json({ error: result.error, hint: result.hint });

  console.log(`[GEE] Change OK — ${result.buffer.byteLength} bytes`);
  res.setHeader('Content-Type',    result.contentType);
  res.setHeader('Cache-Control',   'public, max-age=1800');
  res.setHeader('X-GEE-Region',    region);
  res.setHeader('X-GEE-Periods',   `${farDt}/${midDt} vs ${midDt}/${toDt}`);
  return res.send(result.buffer);
});

/**
 * GET /api/gee/health
 * Auth smoke-test only — no pixel computation.
 */
geeRouter.get('/health', async (_req: Request, res: Response) => {
  try {
    await getAccessToken();
    res.json({
      status:  'ok',
      project: getProject(),
      regions: Object.keys(BBOXES),
      routes:  ['/ndvi', '/ndvi-change'],
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ status: 'error', detail: msg });
  }
});

/**
 * GET /api/gee/debug-expression?type=ndvi|change&region=western
 * Returns the raw expression JSON without making a pixel call.
 * Use to validate the expression graph structure during development.
 */
geeRouter.get('/debug-expression', (req: Request, res: Response) => {
  const { region, bbox } = resolveRegion(req.query.region);
  const type   = (req.query.type as string) || 'ndvi';
  const toDt   = daysAgo(0);
  const fromDt = daysAgo(45);
  const midDt  = daysAgo(90);
  const farDt  = daysAgo(180);

  const expression = type === 'change'
    ? buildNDVIChangeExpression(farDt, midDt, toDt)
    : buildNDVIExpression(fromDt, toDt);

  res.json({ region, bbox, type, expression });
});