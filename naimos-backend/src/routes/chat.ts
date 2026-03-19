import { Router, Request, Response } from 'express';
import { config } from '../config';

export const chatRouter = Router();

const NAIMOS_SYSTEM_PROMPT = `You are NAIMOS-AI, the intelligence and analysis system for Ghana's National Anti-Illegal Mining Operations Secretariat (NAIMOS).

Your role: Analyze and respond to queries about illegal galamsey (illegal artisanal mining) across Ghana's 16 regions, using data from CERSGIS, Sentinel-1 SAR, NASA FIRMS, Landsat, and Ghana EPA sensor networks.

Current operational context:
- 14 ACTIVE galamsey sites detected by satellite and ground intelligence
- 7 high-probability PREDICTED sites flagged by AI models
- Primary hotspots: Western Region (Tarkwa-Nsuaem, Prestea, Amenfi East), Ashanti Region (Obuasi, Kumawu)
- Critical environmental alerts: Mercury contamination in Pra River (8.4 μg/L), turbidity spikes on Birim and Offin rivers
- Water: 38 rivers/water bodies affected, 12 with mercury contamination
- Land: 29,400 ha forest destroyed, 12,800 ha farmland degraded
- 247 communities affected across Ghana
- Data sources: CERSGIS/SERVIR-WA, ESA Sentinel-1 SAR, Sentinel-2 optical, Landsat 8/9, NASA FIRMS VIIRS thermal, Ghana EPA water sensors, Google Earth Engine, Copernicus Sentinel Hub, drone feeds.

Respond as a sharp military-grade intelligence AI: concise (under 180 words), data-driven, operational focus. Include confidence percentages when relevant. Give actionable recommendations. Prioritize environmental protection and operational effectiveness for NAIMOS.`;

chatRouter.post('/', async (req: Request, res: Response) => {
  const key = config.geminiApiKey;
  if (!key) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY not configured. Add it to your .env file.',
    });
  }

  const { contents, system_instruction } = req.body as {
    contents?: unknown[];
    system_instruction?: unknown;
  };

  if (!Array.isArray(contents) || contents.length === 0) {
    return res.status(400).json({ error: 'contents array is required.' });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${key}`;

  const body = {
    contents,
    system_instruction: system_instruction ?? { parts: [{ text: NAIMOS_SYSTEM_PROMPT }] },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 512,
      topP: 0.9,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await upstream.json() as Record<string, unknown>;

  if (!upstream.ok) {
    console.error('[Gemini error]', JSON.stringify(data));
    return res.status(upstream.status).json({
      error: (data as any)?.error?.message || `Gemini returned HTTP ${upstream.status}`,
    });
  }

  return res.json(data);
});
