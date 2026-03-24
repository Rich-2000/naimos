// ─────────────────────────────────────────────────────────────────────────────
// NAIMOS AMS · /api/drones — UAV/Drone Image Management Route
// Cloudinary-backed, production-grade, real-time image store
// Drop into: backend/src/routes/drones.ts
// Register in server.ts: app.use('/api/drones', dronesRouter);
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { v2 as cloudinary }           from 'cloudinary';
import multer                          from 'multer';
import { Readable }                    from 'stream';

export const dronesRouter = Router();

// ── Cloudinary config (from environment variables) ────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
  api_key:    process.env.CLOUDINARY_API_KEY    || '',
  api_secret: process.env.CLOUDINARY_API_SECRET || '',
  secure:     true,
});

const DRONE_FOLDER = process.env.CLOUDINARY_DRONE_FOLDER || 'naimos/drones';

// ── Multer — memory storage (stream to Cloudinary) ───────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

// ── Helper: upload Buffer → Cloudinary stream ─────────────────────────────────
function uploadToCloudinary(
  buffer: Buffer,
  options: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err || !result) return reject(err ?? new Error('Cloudinary upload failed'));
      resolve(result as unknown as Record<string, unknown>);
    });
    Readable.from(buffer).pipe(stream);
  });
}

// ── Helper: build clean image object from Cloudinary resource ─────────────────
function buildImageObj(resource: Record<string, unknown>) {
  const ctx = (resource.context as Record<string, unknown>)?.custom as Record<string, string> || {};
  const secureUrl = resource.secure_url as string || '';

  return {
    id:          resource.public_id,
    url:         secureUrl,
    thumbnail:   secureUrl.replace('/upload/', '/upload/w_400,h_300,c_fill,q_auto,f_auto/'),
    mission:     ctx.mission     || '',
    region:      ctx.region      || '',
    droneId:     ctx.droneId     || '',
    type:        ctx.type        || 'rgb',
    lat:         parseFloat(ctx.lat  || '0'),
    lon:         parseFloat(ctx.lon  || '0'),
    alt:         ctx.alt         || '',
    notes:       ctx.notes       || '',
    captureTime: ctx.captureTime || '',
    uploadedAt:  resource.created_at,
    bytes:       resource.bytes,
    width:       resource.width,
    height:      resource.height,
    format:      resource.format,
    assetId:     resource.asset_id,
  };
}

// ── Helper: build Cloudinary search expression from filters ───────────────────
function buildSearchExpression(filters: Record<string, string | undefined>): string {
  const parts: string[] = [`folder:${DRONE_FOLDER}/*`];
  if (filters.region)  parts.push(`context.region="${filters.region.replace(/"/g, '\\"')}"`);
  if (filters.mission) parts.push(`context.mission="${filters.mission.replace(/"/g, '\\"')}"`);
  if (filters.droneId) parts.push(`context.droneId="${filters.droneId}"`);
  if (filters.type)    parts.push(`context.type="${filters.type}"`);
  return parts.join(' AND ');
}

// ── Shared type for a built image object ──────────────────────────────────────
type DroneImage = ReturnType<typeof buildImageObj>;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/drones/images
// Query: region?, mission?, droneId?, type?, limit=50, nextCursor?
// ─────────────────────────────────────────────────────────────────────────────
dronesRouter.get('/images', async (req: Request, res: Response) => {
  const { region, mission, droneId, type, limit = '50', nextCursor } = req.query as Record<string, string>;

  try {
    const searchExpr = buildSearchExpression({ region, mission, droneId, type });

    const result = await cloudinary.search
      .expression(searchExpr)
      .sort_by('created_at', 'desc')
      .max_results(Math.min(parseInt(limit) || 50, 100))
      .next_cursor(nextCursor || (undefined as any))
      .with_field('context')
      .with_field('tags')
      .execute();

    const images = ((result as any).resources || []).map(buildImageObj);

    return res.json({
      images,
      total:      (result as any).total_count || images.length,
      nextCursor: (result as any).next_cursor || null,
      query:      { region, mission, droneId, type },
      updatedAt:  new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[Drones] List images error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to fetch drone images' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/drones/missions
// Returns a list of unique missions derived from Cloudinary image metadata.
// Each mission includes image count, regions covered, active drone IDs,
// image types used, first/last activity timestamps, and the latest thumbnail.
// A mission is flagged "active" if it has images from within the last 7 days.
// ─────────────────────────────────────────────────────────────────────────────
dronesRouter.get('/missions', async (_req: Request, res: Response) => {
  try {
    const result = await cloudinary.search
      .expression(`folder:${DRONE_FOLDER}/*`)
      .sort_by('created_at', 'desc')
      .max_results(500)
      .with_field('context')
      .execute();

    const images: DroneImage[] = ((result as any).resources || []).map(buildImageObj);

    // ── Group images by mission name ──────────────────────────────────────────
    interface MissionEntry {
      name:      string;
      count:     number;
      regions:   Set<string>;
      droneIds:  Set<string>;
      types:     Set<string>;
      latest:    DroneImage | null;
      firstSeen: string;
      lastSeen:  string;
    }

    const missionMap: Record<string, MissionEntry> = {};

    images.forEach((img) => {
      const key = (img.mission as string)?.trim() || 'Unnamed';

      if (!missionMap[key]) {
        missionMap[key] = {
          name:      key,
          count:     0,
          regions:   new Set<string>(),
          droneIds:  new Set<string>(),
          types:     new Set<string>(),
          latest:    null,
          firstSeen: (img.uploadedAt as string) || '',
          lastSeen:  (img.uploadedAt as string) || '',
        };
      }

      const entry = missionMap[key];
      entry.count++;

      if (img.region)  entry.regions.add(img.region  as string);
      if (img.droneId) entry.droneIds.add(img.droneId as string);
      if (img.type)    entry.types.add(img.type       as string);

      // Images arrive newest-first from Cloudinary, so the first encounter = latest
      if (!entry.latest) entry.latest = img;

      const uploadedAt = (img.uploadedAt as string) || '';
      if (uploadedAt && uploadedAt < entry.firstSeen) entry.firstSeen = uploadedAt;
      if (uploadedAt && uploadedAt > entry.lastSeen)  entry.lastSeen  = uploadedAt;
    });

    // ── Serialise and sort (most recent activity first) ───────────────────────
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    const missions = Object.values(missionMap)
      .sort((a, b) => (b.lastSeen > a.lastSeen ? 1 : -1))
      .map((m) => ({
        name:      m.name,
        count:     m.count,
        regions:   Array.from(m.regions),
        droneIds:  Array.from(m.droneIds),
        types:     Array.from(m.types),
        latest:    m.latest,
        firstSeen: m.firstSeen,
        lastSeen:  m.lastSeen,
        status:
          m.lastSeen &&
          Date.now() - new Date(m.lastSeen).getTime() < SEVEN_DAYS_MS
            ? 'active'
            : 'inactive',
      }));

    return res.json({
      missions,
      total:     missions.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[Drones] Missions error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to fetch missions' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/drones/stats
// Returns fleet statistics: total images, by region, by type, today count, etc.
// ─────────────────────────────────────────────────────────────────────────────
dronesRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const result = await cloudinary.search
      .expression(`folder:${DRONE_FOLDER}/*`)
      .sort_by('created_at', 'desc')
      .max_results(500)
      .with_field('context')
      .execute();

    const resources = ((result as any).resources || []) as Record<string, unknown>[];
    const images    = resources.map(buildImageObj);

    // Today count
    const todayStr   = new Date().toDateString();
    const todayCount = images.filter(
      (img) => new Date(img.uploadedAt as string).toDateString() === todayStr
    ).length;

    // By region
    const byRegion: Record<string, number> = {};
    images.forEach((img) => {
      const r = (img.region as string) || 'Unknown';
      byRegion[r] = (byRegion[r] || 0) + 1;
    });

    // By type
    const byType: Record<string, number> = {};
    images.forEach((img) => {
      const t = (img.type as string) || 'rgb';
      byType[t] = (byType[t] || 0) + 1;
    });

    // By mission
    const byMission: Record<string, number> = {};
    images.forEach((img) => {
      if (!img.mission) return;
      const m = img.mission as string;
      byMission[m] = (byMission[m] || 0) + 1;
    });

    const latest = images[0] || null;

    return res.json({
      total:     images.length,
      today:     todayCount,
      byRegion,
      byType,
      byMission,
      latest,
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[Drones] Stats error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/drones/latest — returns the most recent N images
// Quick endpoint for the UAVs/Drones tab to poll every 30s
// ─────────────────────────────────────────────────────────────────────────────
dronesRouter.get('/latest', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) || '24', 10), 60);

  try {
    const result = await cloudinary.search
      .expression(`folder:${DRONE_FOLDER}/*`)
      .sort_by('created_at', 'desc')
      .max_results(limit)
      .with_field('context')
      .execute();

    const images = ((result as any).resources || []).map(buildImageObj);

    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    return res.json({
      images,
      count:     images.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[Drones] Latest error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/drones/upload — multipart/form-data
// Fields: image (file), mission, region, droneId, type, lat, lon, alt, notes, captureTime
// ─────────────────────────────────────────────────────────────────────────────
dronesRouter.post('/upload', upload.single('image'), async (req: Request, res: Response) => {
  const file = (req as any).file;
  if (!file) return res.status(400).json({ error: 'No image file provided (field name: image)' });

  const {
    mission     = '',
    region      = '',
    droneId     = '',
    type        = 'rgb',
    lat         = '',
    lon         = '',
    alt         = '',
    notes       = '',
    captureTime = '',
  } = req.body as Record<string, string>;

  try {
    const ts       = Date.now();
    const safe     = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const publicId = `${DRONE_FOLDER}/${safe(mission || 'unnamed')}_${safe(droneId || 'unknown')}_${ts}`;

    const result = await uploadToCloudinary(file.buffer, {
      public_id:     publicId,
      resource_type: 'image',
      overwrite:     false,
      quality:       'auto:best',
      fetch_format:  'auto',
      context: {
        mission,
        region,
        droneId,
        type,
        lat,
        lon,
        alt,
        notes: notes.slice(0, 500),
        captureTime,
      },
      tags: [
        'naimos',
        'drone',
        type,
        region.replace(/\s+/g, '-').toLowerCase(),
        mission.replace(/\s+/g, '-').toLowerCase(),
      ].filter(Boolean),
    });

    const image = buildImageObj(result);

    console.log(`[Drones] ✓ Upload: ${publicId} · ${region} · ${type}`);
    return res.status(201).json({ success: true, image });
  } catch (err: any) {
    console.error('[Drones] Upload error:', err.message);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/drones/upload-url — returns a signed Cloudinary upload URL
// so the browser can upload directly to Cloudinary without going through the server
// ─────────────────────────────────────────────────────────────────────────────
dronesRouter.post('/upload-url', async (req: Request, res: Response) => {
  const { mission = '', region = '', droneId = '', type = 'rgb' } = req.body as Record<string, string>;

  try {
    const ts        = Date.now();
    const safe      = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const publicId  = `${DRONE_FOLDER}/${safe(mission || 'unnamed')}_${safe(droneId || 'unknown')}_${ts}`;
    const timestamp = Math.round(Date.now() / 1000);

    const paramsToSign: Record<string, string | number> = {
      folder:    DRONE_FOLDER,
      public_id: publicId,
      timestamp,
      context:   `mission=${mission}|region=${region}|droneId=${droneId}|type=${type}`,
    };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET!
    );

    return res.json({
      uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
      apiKey:    process.env.CLOUDINARY_API_KEY,
      signature,
      timestamp,
      publicId,
      folder:    DRONE_FOLDER,
    });
  } catch (err: any) {
    console.error('[Drones] Upload-url error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/drones/images/:publicId
// ─────────────────────────────────────────────────────────────────────────────
dronesRouter.delete('/images/:publicId(*)', async (req: Request, res: Response) => {
  const { publicId } = req.params;
  if (!publicId) return res.status(400).json({ error: 'publicId is required' });

  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    if ((result as any).result === 'ok' || (result as any).result === 'not found') {
      return res.json({ success: true, deleted: publicId });
    }
    return res.status(400).json({ error: 'Cloudinary delete failed', result });
  } catch (err: any) {
    console.error('[Drones] Delete error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/drones/webhook — Cloudinary webhook for real-time sync
// Configure in Cloudinary: Settings → Webhooks → POST /api/drones/webhook
// ─────────────────────────────────────────────────────────────────────────────
dronesRouter.post('/webhook', async (req: Request, res: Response) => {
  const body             = req.body as Record<string, unknown>;
  const notificationType = body.notification_type as string;

  console.log(`[Drones] Webhook: ${notificationType}`, JSON.stringify(body).slice(0, 200));

  // Optional: validate Cloudinary webhook signature in production:
  // const signature = req.headers['x-cld-signature'];
  // const timestamp = req.headers['x-cld-timestamp'];
  // const expectedSig = cloudinary.utils.api_sign_request({ ... }, secret);

  if (notificationType === 'upload') {
    const resource = body as Record<string, unknown>;
    if (!((resource.public_id as string || '').startsWith(DRONE_FOLDER))) {
      return res.json({ ok: true, skipped: true });
    }
    const image = buildImageObj(resource);
    console.log(`[Drones] Webhook: new image uploaded → ${image.id} · ${image.region}`);
    // Broadcast via WebSockets if available:
    // io.emit('drone:image:new', image);
  }

  if (notificationType === 'delete') {
    console.log(`[Drones] Webhook: image deleted → ${body.public_id}`);
  }

  return res.json({ ok: true });
});