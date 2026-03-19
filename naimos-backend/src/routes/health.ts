import { Router, Request, Response } from 'express';
import { config } from '../config';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  const checks = {
    server:    'ok',
    gemini:    config.geminiApiKey    ? 'configured' : 'missing',
    firms:     config.firmsMapKey     ? 'configured' : 'missing (pass per-request)',
    sentinel:  config.sentinelClientId && config.sentinelClientSecret ? 'configured' : 'missing',
    gee:       config.geeApiKey       ? 'configured' : 'missing',
    planetary: 'public (no key needed)',
    timestamp: new Date().toISOString(),
  };

  // Quick live ping to Planetary Computer
  try {
    const pcResp = await fetch(
      'https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-2-l2a',
      { signal: AbortSignal.timeout(4_000) },
    );
    (checks as any).planetary = pcResp.ok ? 'live' : `http-${pcResp.status}`;
  } catch {
    (checks as any).planetary = 'unreachable';
  }

  res.json(checks);
});
