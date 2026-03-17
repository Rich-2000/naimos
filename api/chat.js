export default async function handler(req, res) {
  // Allow CORS from your domains
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request: messages array is required.' });
    }

    const OPENAI_KEY = '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';

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messages,
        max_tokens: 512,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'OpenAI error' });
    }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}