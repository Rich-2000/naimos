// /api/chat.js — NAIMOS Gemini AI Proxy
// Vercel serverless function — key stays on server, never in the browser
// Set GEMINI_API_KEY in: Vercel Dashboard → Project → Settings → Environment Variables

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY not set. Add it in Vercel → Project → Settings → Environment Variables, then redeploy.'
    });
  }

  try {
    const { contents, system_instruction } = req.body;

    if (!contents || !Array.isArray(contents)) {
      return res.status(400).json({ error: 'Invalid request: contents array required.' });
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;

    const body = {
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 512,
        topP: 0.9
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    if (system_instruction) body.system_instruction = system_instruction;

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error('Gemini error:', JSON.stringify(data));
      return res.status(upstream.status).json({
        error: data?.error?.message || `Gemini returned HTTP ${upstream.status}`
      });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}