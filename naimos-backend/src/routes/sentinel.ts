import { Router, Request, Response } from 'express';
import { config } from '../config';

export const sentinelRouter = Router();

// ── In-memory token cache ──────────────────────────────────────────────────
let cachedToken: string | null = null;
let tokenExpiry  = 0;

// ── Bounding boxes [west, south, east, north] ─────────────────────────────
const BBOXES: Record<string, [number, number, number, number]> = {
  western: [-3.3, 4.7, -1.5, 6.8],
  ashanti: [-2.5, 5.8, -0.8, 7.3],
  ghana:   [-3.3, 4.7,  1.2, 11.2],
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sentinel/token
// ─────────────────────────────────────────────────────────────────────────────
sentinelRouter.post('/token', async (_req: Request, res: Response) => {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 60_000) {
    return res.json({ token: cachedToken, expiresIn: Math.round((tokenExpiry - now) / 1000) });
  }

  const { sentinelClientId, sentinelClientSecret } = config;
  if (!sentinelClientId || !sentinelClientSecret) {
    return res.status(500).json({ error: 'Sentinel Hub credentials not configured in .env' });
  }

  const body =
    `grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(sentinelClientId)}` +
    `&client_secret=${encodeURIComponent(sentinelClientSecret)}`;

  try {
    const upstream = await fetch('https://services.sentinel-hub.com/oauth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(12_000),
    });

    const data = (await upstream.json()) as Record<string, unknown>;

    if (!upstream.ok || !data.access_token) {
      console.error('[Sentinel] Token error:', JSON.stringify(data));
      return res.status(upstream.status).json({
        error: (data as any).error_description ?? (data as any).error ?? 'Sentinel Hub auth failed',
      });
    }

    cachedToken = data.access_token as string;
    tokenExpiry = now + Number(data.expires_in) * 1000;

    return res.json({ token: cachedToken, expiresIn: data.expires_in });
  } catch (err: any) {
    console.error('[Sentinel] Token fetch error:', err.message);
    return res.status(500).json({ error: err.message || 'Token fetch failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sentinel/image?layer=ndvi&region=western&width=512&height=512
// ─────────────────────────────────────────────────────────────────────────────
sentinelRouter.get('/image', async (req: Request, res: Response) => {
  const layer  = ((req.query.layer  as string) || 'ndvi').toLowerCase().trim();
  const region = ((req.query.region as string) || 'ghana').toLowerCase().trim();
  const width  = Math.min(Number(req.query.width)  || 512, 2500);
  const height = Math.min(Number(req.query.height) || 512, 2500);

  const bbox = BBOXES[region] ?? BBOXES.ghana;
  const [west, south, east, north] = bbox;

  const today       = new Date().toISOString().slice(0, 10);
  const opticalFrom = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
  const sarFrom     = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);

  // ── Ensure valid token ───────────────────────────────────────────────────
  const now = Date.now();
  if (!cachedToken || now >= tokenExpiry - 60_000) {
    try {
      const tokenRes = await fetch(
        `http://localhost:${config.port}/api/sentinel/token`,
        { method: 'POST', signal: AbortSignal.timeout(15_000) },
      );
      if (!tokenRes.ok) {
        const e = (await tokenRes.json().catch(() => ({}))) as any;
        return res.status(502).json({ error: e.error ?? 'Cannot refresh Sentinel token' });
      }
      const td = (await tokenRes.json()) as { token: string; expiresIn: number };
      cachedToken = td.token;
      tokenExpiry = now + td.expiresIn * 1000;
    } catch (err: any) {
      return res.status(502).json({ error: `Token refresh failed: ${err.message}` });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  ROOT CAUSE & FIX — "Dataset with id: 1 not found"
  //
  //  The error occurs because TWO input objects in setup() are treated as
  //  TWO SEPARATE datasets by the Process API. CLM is a derived/computed
  //  band (DN-only, N/A source format) — it is NOT an independent dataset
  //  and cannot be fetched as dataset id:1. It must live in the SAME input
  //  object as the optical bands.
  //
  //  CORRECT PATTERN — single input object, units: "DN", divide by 10000:
  //
  //    input: [{ bands: ["B04", "B08", "CLM"], units: "DN" }]
  //    // In evaluatePixel:
  //    var b04 = sample.B04 / 10000.0;   // → reflectance 0-1
  //    var b08 = sample.B08 / 10000.0;   // → reflectance 0-1
  //    // CLM stays as-is: 0=clear, 1=cloud, 255=nodata
  //
  //  WHY DN UNITS:
  //  CLM is DN-only — it has no REFLECTANCE unit. If you request the entire
  //  input as REFLECTANCE the API rejects CLM. The solution is to use DN for
  //  the whole input object and manually convert optical bands: divide by
  //  10000 (since DN = 10000 × REFLECTANCE for Sentinel-2).
  //
  //  SAR stays unchanged: single input object, units: "LINEAR_POWER",
  //  with required dataFilter.acquisitionMode + processing.backCoeff.
  // ─────────────────────────────────────────────────────────────────────────

  interface LayerConf {
    datasource: string;
    dataFilter: Record<string, unknown>;
    processing?: Record<string, unknown>;
    evalscript: string;
  }

  // ── NDVI — Sentinel-2 L2A ─────────────────────────────────────────────────
  // Single input object, units: "DN".
  // B04 and B08 divided by 10000 to convert to reflectance.
  // CLM: 0=clear, 1=cloud/shadow, 255=no-data — no conversion needed.
  const NDVI_SCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "CLM"], units: "DN" }],
    output: { bands: 3, sampleType: "UINT8" }
  };
}
function evaluatePixel(sample) {
  // CLM: 0=clear pixel, anything else=cloud/shadow/no-data
  if (sample.CLM !== 0) return [140, 158, 190];

  // Convert DN → reflectance (DN = 10000 × reflectance for Sentinel-2)
  var b04 = sample.B04 / 10000.0;
  var b08 = sample.B08 / 10000.0;

  var denom = b08 + b04;
  if (denom < 1e-6) return [25, 25, 45];

  var ndvi = (b08 - b04) / denom;

  // Colour ramp tuned for Ghana galamsey / land-use signatures
  if (ndvi < -0.05) return [220,  35,  25];  // water / very disturbed pit
  if (ndvi <  0.05) return [200,  50,  30];  // bare soil / active excavation
  if (ndvi <  0.15) return [240, 100,  20];  // recently cleared land
  if (ndvi <  0.25) return [255, 165,   0];  // sparse regrowth / degraded
  if (ndvi <  0.35) return [255, 215,   0];  // degraded savanna / scrub
  if (ndvi <  0.50) return [144, 238, 144];  // moderate vegetation cover
  if (ndvi <  0.65) return [ 46, 204, 113];  // good vegetation
  return                   [  0,  80,  20];  // dense forest
}`;

  // ── True Colour — Sentinel-2 L2A ──────────────────────────────────────────
  const TRUECOLOR_SCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B02", "B03", "B04", "CLM"], units: "DN" }],
    output: { bands: 3, sampleType: "UINT8" }
  };
}
function evaluatePixel(sample) {
  if (sample.CLM !== 0) return [175, 188, 210];
  var r = sample.B04 / 10000.0;
  var g = sample.B03 / 10000.0;
  var b = sample.B02 / 10000.0;
  return [
    Math.round(Math.min(r * 3.5, 1.0) * 255),
    Math.round(Math.min(g * 3.5, 1.0) * 255),
    Math.round(Math.min(b * 3.5, 1.0) * 255)
  ];
}`;

  // ── False Colour NIR — Sentinel-2 L2A ─────────────────────────────────────
  const FALSECOLOR_SCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B03", "B04", "B08", "CLM"], units: "DN" }],
    output: { bands: 3, sampleType: "UINT8" }
  };
}
function evaluatePixel(sample) {
  if (sample.CLM !== 0) return [175, 188, 210];
  var nir = sample.B08 / 10000.0;
  var red = sample.B04 / 10000.0;
  var grn = sample.B03 / 10000.0;
  return [
    Math.round(Math.min(nir * 2.8, 1.0) * 255),
    Math.round(Math.min(red * 2.8, 1.0) * 255),
    Math.round(Math.min(grn * 2.8, 1.0) * 255)
  ];
}`;

  // ── SAR Backscatter — Sentinel-1 GRD ──────────────────────────────────────
  // Single input object, units: "LINEAR_POWER" — works correctly as-is.
  // acquisitionMode + polarization + processing.backCoeff are required.
  const SAR_SCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["VV", "VH"], units: "LINEAR_POWER" }],
    output: { bands: 3, sampleType: "UINT8" }
  };
}
function evaluatePixel(sample) {
  var vvDb = 10.0 * Math.log10(sample.VV + 1e-10);
  var vhDb = 10.0 * Math.log10(sample.VH + 1e-10);
  var vv = Math.max(0, Math.min(1, (vvDb + 28) / 30));
  var vh = Math.max(0, Math.min(1, (vhDb + 35) / 30));
  return [
    Math.round(Math.min(vv * 340, 255)),
    Math.round(vh * 200),
    Math.round((1 - vv) * 120)
  ];
}`;

  // ── Layer configuration map ────────────────────────────────────────────────
  const LAYERS: Record<string, LayerConf> = {
    ndvi: {
      datasource: 'sentinel-2-l2a',
      dataFilter: {
        timeRange:        { from: `${opticalFrom}T00:00:00Z`, to: `${today}T23:59:59Z` },
        maxCloudCoverage:  70,
        mosaickingOrder:  'leastCC',
      },
      evalscript: NDVI_SCRIPT,
    },
    truecolor: {
      datasource: 'sentinel-2-l2a',
      dataFilter: {
        timeRange:        { from: `${opticalFrom}T00:00:00Z`, to: `${today}T23:59:59Z` },
        maxCloudCoverage:  70,
        mosaickingOrder:  'leastCC',
      },
      evalscript: TRUECOLOR_SCRIPT,
    },
    falsecolor: {
      datasource: 'sentinel-2-l2a',
      dataFilter: {
        timeRange:        { from: `${opticalFrom}T00:00:00Z`, to: `${today}T23:59:59Z` },
        maxCloudCoverage:  70,
        mosaickingOrder:  'leastCC',
      },
      evalscript: FALSECOLOR_SCRIPT,
    },
    sar: {
      datasource: 'sentinel-1-grd',
      dataFilter: {
        timeRange:        { from: `${sarFrom}T00:00:00Z`, to: `${today}T23:59:59Z` },
        acquisitionMode:  'IW',
        polarization:     'DV',
        resolution:       'HIGH',
        mosaickingOrder:  'mostRecent',
      },
      processing: {
        backCoeff:    'SIGMA0_ELLIPSOID',
        orthorectify:  true,
        demInstance:  'COPERNICUS_30',
      },
      evalscript: SAR_SCRIPT,
    },
  };

  const conf = LAYERS[layer] ?? LAYERS.ndvi;
  const isSAR = conf.datasource === 'sentinel-1-grd';

  // ── Assemble Process API request body ─────────────────────────────────────
  const dataEntry: Record<string, unknown> = {
    type:       conf.datasource,
    dataFilter: conf.dataFilter,
  };
  if (conf.processing) {
    dataEntry.processing = conf.processing;
  }

  const requestBody = {
    input: {
      bounds: {
        bbox:       [west, south, east, north],
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
      },
      data: [dataEntry],
    },
    output: {
      width,
      height,
      responses: [{ identifier: 'default', format: { type: 'image/png' } }],
    },
    evalscript: conf.evalscript,
  };

  console.log(
    `[Sentinel] Process API: ${layer.toUpperCase()} · ${region} · ${conf.datasource}` +
    ` · ${isSAR ? sarFrom : opticalFrom} → ${today}`,
  );

  // ── Call Sentinel Hub Process API ─────────────────────────────────────────
  try {
    const processResp = await fetch('https://services.sentinel-hub.com/api/v1/process', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${cachedToken}`,
      },
      body:   JSON.stringify(requestBody),
      signal: AbortSignal.timeout(50_000),
    });

    // ── Error handling ───────────────────────────────────────────────────────
    if (!processResp.ok) {
      const ct = processResp.headers.get('content-type') ?? '';
      let errMsg    = `HTTP ${processResp.status}`;
      let errDetail = '';

      try {
        if (ct.includes('json')) {
          const errJson = (await processResp.json()) as any;
          errMsg =
            errJson?.message ??
            errJson?.error?.message ??
            errJson?.errors?.[0]?.message ??
            JSON.stringify(errJson).slice(0, 300);
          errDetail = JSON.stringify(errJson);
        } else {
          errMsg = (await processResp.text()).slice(0, 300);
        }
      } catch (_) { /* ignore parse errors */ }

      console.error(`[Sentinel] Process API ${processResp.status}: ${errMsg}`);

      if (processResp.status === 401 || processResp.status === 403) {
        cachedToken = null;
        tokenExpiry = 0;
        return res.status(processResp.status).json({
          error: 'Sentinel Hub auth failed — token cleared, will retry on next request.',
          detail: errMsg,
        });
      }

      if (processResp.status === 422) {
        return res.status(422).json({
          error: `No ${isSAR ? 'SAR' : 'optical'} data found for "${region}" in this date range.`,
          detail: errMsg,
        });
      }

      return res.status(processResp.status).json({
        error: `Sentinel Process API error: ${errMsg}`,
        detail: errDetail,
      });
    }

    // ── Validate content-type ────────────────────────────────────────────────
    const contentType = processResp.headers.get('content-type') ?? 'image/png';
    if (
      contentType.includes('xml')  ||
      contentType.includes('html') ||
      contentType.includes('json')
    ) {
      const text = await processResp.text();
      console.error(`[Sentinel] Unexpected content-type "${contentType}": ${text.slice(0, 300)}`);
      return res.status(502).json({
        error: 'Sentinel returned non-image response',
        detail: text.slice(0, 300),
      });
    }

    // ── Stream image to client ───────────────────────────────────────────────
    const puSpent = processResp.headers.get('x-processingunits-spent') ?? '?';
    console.log(`[Sentinel] ✓ ${layer.toUpperCase()} ${region} ${width}×${height}px PU:${puSpent}`);

    res.setHeader('Content-Type',        contentType);
    res.setHeader('Cache-Control',       'public, max-age=3600');
    res.setHeader('X-Sentinel-Layer',    layer);
    res.setHeader('X-Sentinel-Region',   region);
    res.setHeader('X-Sentinel-DateFrom', isSAR ? sarFrom : opticalFrom);
    res.setHeader('X-Sentinel-DateTo',   today);
    res.setHeader('X-Processing-Units',  puSpent);

    const buf = await processResp.arrayBuffer();
    return res.send(Buffer.from(buf));

  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error('[Sentinel] Request timed out');
      return res.status(504).json({
        error: 'Sentinel Hub timed out (50s). Try a smaller region — "western" or "ashanti" instead of "ghana".',
      });
    }
    console.error('[Sentinel] Network error:', err.message);
    return res.status(502).json({ error: `Sentinel request failed: ${err.message}` });
  }
});