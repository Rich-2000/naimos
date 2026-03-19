import { Router, Request, Response } from 'express';
import { config } from '../config';

export const firmsRouter = Router();

const GHANA_BBOX = '-3.3,4.7,1.2,11.2';

// NRT sensors (VIIRS_SNPP_NRT, VIIRS_NOAA20_NRT, MODIS_NRT) only accept 1–5 days.
// Standard archive sensors accept up to 10. We clamp to 5 to be universally safe.
const NRT_SENSORS = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'MODIS_NRT'];
const MAX_DAYS_NRT     = 5;
const MAX_DAYS_ARCHIVE = 10;

firmsRouter.get('/', async (req: Request, res: Response) => {
  const mapKey = (req.query.key as string) || config.firmsMapKey;
  const sensor = (req.query.sensor as string) || 'VIIRS_SNPP_NRT';
  const bbox   = (req.query.bbox   as string) || GHANA_BBOX;

  // Clamp days based on sensor type
  const isNRT  = NRT_SENSORS.includes(sensor);
  const maxDays = isNRT ? MAX_DAYS_NRT : MAX_DAYS_ARCHIVE;
  const rawDays = Number(req.query.days) || 2;
  const days    = Math.min(Math.max(rawDays, 1), maxDays);

  if (!mapKey) {
    return res.status(400).json({
      error: 'NASA FIRMS MAP_KEY required. Pass ?key=YOUR_KEY or set FIRMS_MAP_KEY in .env',
    });
  }

  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${sensor}/${bbox}/${days}`;

  console.log(`[FIRMS] Fetching: days=${days} (requested=${rawDays}, max=${maxDays}) sensor=${sensor}`);

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'NAIMOS-AMS/1.0' },
      signal: AbortSignal.timeout(20_000),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('[FIRMS error]', upstream.status, text.slice(0, 200));
      return res.status(upstream.status).json({
        error: `FIRMS API returned HTTP ${upstream.status}. Check your MAP_KEY.`,
        detail: text.slice(0, 200),
      });
    }

    const csv = await upstream.text();

    if (csv.includes('Invalid') || csv.startsWith('<!')) {
      return res.status(401).json({
        error: 'Invalid FIRMS MAP_KEY or API error.',
        detail: csv.slice(0, 200),
      });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('X-FIRMS-Days', String(days));
    res.setHeader('X-FIRMS-Sensor', sensor);
    return res.send(csv);

  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'FIRMS request timed out after 20s.' });
    }
    console.error('[FIRMS unexpected error]', err);
    return res.status(500).json({ error: err.message || 'Unexpected FIRMS error.' });
  }
});