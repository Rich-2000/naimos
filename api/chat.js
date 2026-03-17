export default async function handler(req, res) {
  // CORS headers — allow requests from your Vercel frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request: messages array required.' });
    }

    // API key comes from Vercel Environment Variables (never hardcoded)
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_KEY) {
      return res.status(500).json({
        error: 'OpenAI API key not configured. Add OPENAI_API_KEY in Vercel → Settings → Environment Variables.'
      });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 512,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenAI error:', data);
      return res.status(response.status).json({
        error: data.error?.message || `OpenAI returned status ${response.status}`
      });
    }

    return res.status(200).json(data);

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message });
  }
}