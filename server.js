const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = 'deepseek-ai/deepseek-v4-pro';
const API_KEY = process.env.KIMI_API_KEY || '';
const PORT = process.env.PORT || 3000;

const SYSTEM_TARGETED = `You are an expert HTML editor. Return ONLY changes as SEARCH/REPLACE blocks.
Format:
<<<< SEARCH
[text to find]
==== REPLACE
[new text]
>>>>
After blocks, write one sentence about what you changed.`;

const SYSTEM_GENERATE = `You are an expert educational content creator. Create a complete HTML document with inline CSS and JS. Use navy #1f507b. Wrap in a code block.`;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', api_configured: !!API_KEY });
});

// Build endpoint — streams the AI response directly to the client
// No timeout because Render has no 150s limit like Supabase
app.post('/build', async (req, res) => {
  try {
    const { messages, max_tokens, temperature } = req.body;
    if (!messages) return res.status(400).json({ error: 'messages required' });
    if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });

    // Set headers for streaming response
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Call NVIDIA API with streaming
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: messages,
        max_tokens: max_tokens || 4096,
        temperature: temperature || 0.2,
        stream: true
      })
    });

    if (!response.ok) {
      const err = await response.text();
      res.write(JSON.stringify({ error: `AI API ${response.status}: ${err.substring(0, 200)}` }) + '\n');
      res.end();
      return;
    }

    // Pipe the stream: NVIDIA → Render → frontend
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const chunk = JSON.parse(jsonStr);
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              // Send each chunk to the client
              res.write(JSON.stringify({ chunk: delta.content }) + '\n');
            }
          } catch (e) {}
        }
      }
    }

    // Send done signal
    res.write(JSON.stringify({ done: true }) + '\n');
    res.end();
  } catch (e) {
    res.write(JSON.stringify({ error: e.message }) + '\n');
    res.end();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Module Tester running on port ${PORT}, api=${!!API_KEY}`);
});
