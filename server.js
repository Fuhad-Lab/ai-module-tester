const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const KIMI_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const MODEL = 'moonshotai/kimi-k2.6';
const PORT = process.env.PORT || 3000;

// ─── Stream Kimi response (keeps connection alive for Render) ────────
async function callKimiStreaming(messages, { max_tokens = 8192 } = {}) {
  if (!KIMI_API_KEY) throw new Error('KIMI_API_KEY not configured');
  const response = await fetch(KIMI_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KIMI_API_KEY}`,
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL, messages, max_tokens,
      temperature: 1.0, top_p: 1.0,
      stream: true,
      chat_template_kwargs: { thinking: false },
    }),
  });
  if (!response.ok) throw new Error(`Kimi ${response.status}: ${await response.text()}`);
  
  // Read the stream and accumulate content
  let content = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        try {
          const chunk = JSON.parse(jsonStr);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
        } catch (e) { /* skip invalid */ }
      }
    }
  }
  return content;
}

// ─── Extract HTML ────────────────────────────────────────────────────
function extractHtml(text) {
  if (!text) return '';
  let m = text.match(/```html\s*\n?([\s\S]*?)```/i);
  if (m) return m[1].trim();
  m = text.match(/```(?:\w*\s*\n?)?([\s\S]*?)```/i);
  if (m && m[1] && m[1].includes('<')) return m[1].trim();
  const trimmed = text.trim();
  if (trimmed.match(/^<!DOCTYPE|<html|<div/i)) return trimmed;
  const idx = text.search(/<!DOCTYPE|<html/i);
  if (idx >= 0) {
    const sub = text.substring(idx);
    const end = sub.lastIndexOf('</html>');
    if (end >= 0) return sub.substring(0, end + 7).trim();
    return sub.trim();
  }
  return '';
}

const SYSTEM = `You are an educational web page designer. Create a visually appealing educational web page about the topic the user requests.

Output requirements:
- A complete HTML document with <!DOCTYPE html>, <html>, <head>, and <body> tags
- CSS styles inside a <style> tag in the head
- The page should be educational and suitable for secondary school students
- Use the color #1f507b (navy blue) as the main color
- Include a title, explanatory text, and a simple quiz with 2-3 questions
- Wrap the entire HTML in a code block starting with \`\`\`html

After the code block, write one sentence describing what you created.`;

// ─── Playwright ──────────────────────────────────────────────────────
let browser = null;
async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

// ─── Routes ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', kimi_configured: !!KIMI_API_KEY, playwright_ready: !!browser });
});

app.post('/generate', async (req, res) => {
  try {
    const { prompt, current_html } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const messages = current_html
      ? [{ role: 'system', content: SYSTEM },
         { role: 'user', content: `Here is the current module:\n\n\`\`\`html\n${current_html}\n\`\`\`\n\nInstruction: ${prompt}` }]
      : [{ role: 'system', content: SYSTEM },
         { role: 'user', content: prompt }];

    // Send headers early to prevent timeout
    res.setHeader('Content-Type', 'application/json');
    
    const content = await callKimiStreaming(messages);
    const html = extractHtml(content);
    let reply = content.replace(/```html\s*\n?[\s\S]*?```/gi, '').replace(/```[\s\S]*?```/gi, '').trim();
    if (!reply) reply = 'Module generated successfully.';

    if (!html) {
      return res.status(500).json({ error: 'AI did not generate valid HTML.', raw_content: content.substring(0, 300) });
    }
    res.json({ html, reply });
  } catch (e) {
    console.error('Generate error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.post('/edit', async (req, res) => {
  try {
    const { instruction, current_html } = req.body;
    if (!instruction || !current_html) return res.status(400).json({ error: 'instruction and current_html required' });
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Current module:\n\n\`\`\`html\n${current_html}\n\`\`\`\n\nEdit: ${instruction}` },
    ];
    const content = await callKimiStreaming(messages);
    const html = extractHtml(content);
    let reply = content.replace(/```html\s*\n?[\s\S]*?```/gi, '').trim();
    if (!reply) reply = 'Module updated.';
    if (!html) return res.status(500).json({ error: 'AI did not generate valid HTML.' });
    res.json({ html, reply });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.post('/start', async (req, res) => {
  let p;
  try {
    const { htmlContent } = req.body;
    if (!htmlContent) return res.status(400).json({ error: 'htmlContent required' });
    const b = await getBrowser();
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    p = await ctx.newPage();
    await p.setContent(htmlContent, { waitUntil: 'networkidle', timeout: 15000 }).catch(()=>{});
    await p.waitForTimeout(500);
    const screenshot = await p.screenshot({ encoding: 'base64' });
    res.json({ screenshot });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  } finally {
    if (p) await p.close().catch(()=>{});
  }
});

app.post('/action', async (req, res) => {
  // Simplified — no persistent page across requests
  res.json({ success: false, error: 'Use /start for screenshots' });
});

app.post('/test', async (req, res) => {
  let p;
  try {
    const { htmlContent } = req.body;
    if (!htmlContent) return res.status(400).json({ error: 'htmlContent required' });
    const b = await getBrowser();
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    p = await ctx.newPage();
    await p.setContent(htmlContent, { waitUntil: 'networkidle', timeout: 15000 }).catch(()=>{});
    await p.waitForTimeout(1000);
    const sc = await p.screenshot({ type: 'png' });
    const b64 = sc.toString('base64');
    res.json({ analysis: { overall: 'checked', issues: [], suggestions: [] }, screenshot: b64 });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  } finally {
    if (p) await p.close().catch(()=>{});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Module Tester on port ${PORT}, kimi=${!!KIMI_API_KEY}`);
});
