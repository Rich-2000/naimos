

import { Router, Request, Response } from 'express';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { config } from '../config';

export const firmsRouter = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const FIRMS_API_BASE  = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const GHANA_BBOX      = '-3.3,4.7,1.2,11.2';
const NRT_SENSORS     = new Set(['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'MODIS_NRT']);
const MAX_DAYS_NRT    = 5;
const MAX_DAYS_ARCH   = 10;
const DEFAULT_SENSOR  = 'VIIRS_SNPP_NRT';
const DEFAULT_DAYS    = 2;

// ─── CSV → GeoJSON ────────────────────────────────────────────────────────────

function csvToGeoJSON(csv: string): FeatureCollection<Point> {
  const lines   = csv.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return { type: 'FeatureCollection', features: [] };

  const headers  = lines[0].split(',').map(h => h.trim());
  const features: Feature<Point>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    if (vals.length < headers.length) continue;

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] ?? '').trim(); });

    const lat = parseFloat(row.latitude);
    const lon = parseFloat(row.longitude);
    if (isNaN(lat) || isNaN(lon)) continue;

    features.push({
      type:     'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] } as Point,
      properties: {
        bright_ti4: parseFloat(row.bright_ti4 ?? row.brightness ?? '0') || null,
        bright_ti5: parseFloat(row.bright_ti5 ?? '0') || null,
        frp:        parseFloat(row.frp ?? '0') || null,
        confidence: row.confidence ?? '',
        acq_date:   row.acq_date   ?? '',
        acq_time:   row.acq_time   ?? '',
        satellite:  row.satellite  ?? '',
        instrument: row.instrument ?? '',
        daynight:   row.daynight   ?? '',
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

// ─── Shared FIRMS fetch ───────────────────────────────────────────────────────

async function fetchFIRMSCsv(params: {
  mapKey: string;
  sensor: string;
  bbox:   string;
  days:   number;
}): Promise<string> {
  const { mapKey, sensor, bbox, days } = params;
  const url = `${FIRMS_API_BASE}/${mapKey}/${sensor}/${bbox}/${days}`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'NAIMOS-AMS/12.0 (Ghana Anti-Galamsey Platform)' },
    signal:  AbortSignal.timeout(25_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw Object.assign(
      new Error(`FIRMS API HTTP ${resp.status}`),
      { status: resp.status, detail: text.slice(0, 300) }
    );
  }

  const csv = await resp.text();

  // FIRMS returns HTML error pages for invalid MAP keys
  if (csv.startsWith('<!') || csv.toLowerCase().includes('invalid')) {
    throw Object.assign(
      new Error('Invalid FIRMS MAP_KEY or malformed request'),
      { status: 401, detail: csv.slice(0, 200) }
    );
  }

  return csv;
}

function clampDays(rawDays: number, sensor: string): number {
  const isNRT   = NRT_SENSORS.has(sensor);
  const maxDays = isNRT ? MAX_DAYS_NRT : MAX_DAYS_ARCH;
  return Math.min(Math.max(rawDays, 1), maxDays);
}

// ─── GET /api/firms ───────────────────────────────────────────────────────────
// Called by window.fetchFIRMSData() in api-client.js → raw CSV

firmsRouter.get('/', async (req: Request, res: Response) => {
  const mapKey = (req.query.key    as string) || config.firmsMapKey;
  const sensor = (req.query.sensor as string) || DEFAULT_SENSOR;
  const bbox   = (req.query.bbox   as string) || GHANA_BBOX;
  const days   = clampDays(parseInt(req.query.days as string, 10) || DEFAULT_DAYS, sensor);

  if (!mapKey) {
    return res.status(400).json({
      error: 'FIRMS MAP_KEY required. Set FIRMS_MAP_KEY in .env or pass ?key=YOUR_KEY.',
      docs:  'https://firms.modaps.eosdis.nasa.gov/api/',
    });
  }

  console.log(`[FIRMS] sensor=${sensor} days=${days} bbox=${bbox}`);

  try {
    const csv = await fetchFIRMSCsv({ mapKey, sensor, bbox, days });
    return res
      .setHeader('Content-Type',   'text/csv; charset=utf-8')
      .setHeader('Cache-Control',  'public, max-age=600')
      .setHeader('X-FIRMS-Sensor', sensor)
      .setHeader('X-FIRMS-Days',   String(days))
      .setHeader('X-FIRMS-BBox',   bbox)
      .send(csv);

  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'FIRMS request timed out after 25 s.' });
    }
    console.error('[FIRMS]', err.message, err.detail ?? '');
    return res.status(err.status ?? 502).json({
      error:  err.message,
      detail: err.detail ?? undefined,
    });
  }
});

// ─── GET /api/firms/geojson ───────────────────────────────────────────────────

firmsRouter.get('/geojson', async (req: Request, res: Response) => {
  const mapKey = (req.query.key    as string) || config.firmsMapKey;
  const sensor = (req.query.sensor as string) || DEFAULT_SENSOR;
  const bbox   = (req.query.bbox   as string) || GHANA_BBOX;
  const days   = clampDays(parseInt(req.query.days as string, 10) || DEFAULT_DAYS, sensor);

  if (!mapKey) {
    return res.status(400).json({
      error: 'FIRMS MAP_KEY required. Set FIRMS_MAP_KEY in .env or pass ?key=YOUR_KEY.',
      docs:  'https://firms.modaps.eosdis.nasa.gov/api/',
    });
  }

  console.log(`[FIRMS GeoJSON] sensor=${sensor} days=${days} bbox=${bbox}`);

  try {
    const csv    = await fetchFIRMSCsv({ mapKey, sensor, bbox, days });
    const geojson = csvToGeoJSON(csv);
    return res
      .setHeader('Content-Type',  'application/geo+json; charset=utf-8')
      .setHeader('Cache-Control', 'public, max-age=600')
      .setHeader('X-FIRMS-Count', String(geojson.features.length))
      .json(geojson);

  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'FIRMS request timed out.' });
    }
    console.error('[FIRMS GeoJSON]', err.message);
    return res.status(err.status ?? 502).json({
      error:  err.message,
      detail: err.detail ?? undefined,
    });
  }
});

// ─── GET /api/firms/health ────────────────────────────────────────────────────

firmsRouter.get('/health', async (req: Request, res: Response) => {
  const mapKey = (req.query.key as string) || config.firmsMapKey;

  if (!mapKey) {
    return res.status(503).json({
      status:  'degraded',
      message: 'FIRMS_MAP_KEY not configured.',
      docs:    'https://firms.modaps.eosdis.nasa.gov/api/',
    });
  }

  try {
    await fetchFIRMSCsv({ mapKey, sensor: DEFAULT_SENSOR, bbox: GHANA_BBOX, days: 1 });
    return res.json({ status: 'ok', keyPresent: true });
  } catch (err: any) {
    return res.status(502).json({ status: 'error', message: err.message });
  }
});