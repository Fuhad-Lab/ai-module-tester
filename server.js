/**
 * AI Module Tester & Creator — Blue Horizon E-Learning
 * Express + Playwright + Kimi K2.6 (NVIDIA API)
 */

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

// ─── Kimi K2.6 API call ──────────────────────────────────────────────
async function callKimi(messages, { max_tokens = 16384 } = {}) {
  if (!KIMI_API_KEY) throw new Error('KIMI_API_KEY not configured');

  const response = await fetch(KIMI_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KIMI_API_KEY}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens,
      temperature: 1.0,
      top_p: 1.0,
      stream: false,
      chat_template_kwargs: { thinking: false },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Kimi API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const msg = data.choices?.[0]?.message || {};
  // Kimi K2.6 may put content in 'content' or 'reasoning_content'
  return {
    content: msg.content || '',
    reasoning: msg.reasoning_content || msg.reasoning || '',
    raw: msg,
  };
}

// ─── Extract HTML from AI response ───────────────────────────────────
function extractHtml(text) {
  if (!text) return '';
  // Try ```html ... ``` block (with optional leading whitespace)
  let m = text.match(/```html\s*\n?([\s\S]*?)```/i);
  if (m) return m[1].trim();
  // Try ``` ... ``` block containing HTML
  m = text.match(/```(?:\w*\s*\n?)?([\s\S]*?)```/i);
  if (m && m[1] && m[1].includes('<')) return m[1].trim();
  // Try raw HTML (starts with <!DOCTYPE or <html or <div)
  const trimmed = text.trim();
  if (trimmed.match(/^<!DOCTYPE|<html|<div|<head|<body/i)) {
    return trimmed;
  }
  // Try to find any HTML-like content
  const htmlStart = text.search(/<!DOCTYPE|<html/i);
  if (htmlStart >= 0) {
    // Find the end (last > or </html>)
    const sub = text.substring(htmlStart);
    const endIdx = sub.lastIndexOf('</html>');
    if (endIdx >= 0) return sub.substring(0, endIdx + 7).trim();
    return sub.trim();
  }
  return '';
}

// ─── System prompts ──────────────────────────────────────────────────
const GENERATE_SYSTEM = `You are an expert educational content creator for Blue Horizon Schools.
Your task is to create interactive, self-contained HTML learning modules for Nigerian secondary school students.

Rules:
1. Output a COMPLETE, self-contained HTML document (with <!DOCTYPE html>, <html>, <head>, <body>)
2. Use inline CSS (in a <style> tag) — no external stylesheets
3. Use vanilla JavaScript (in <script> tags) — no external libraries except CDN links for fonts/icons
4. Make it interactive: quizzes, draggable elements, animations, expandable sections, etc.
5. Use clear, age-appropriate language for JSS/SSS students
6. Include: lesson title, learning objectives, main content with examples, interactive practice, summary
7. Use Blue Horizon's navy color (#1f507b) as the primary color
8. Make it responsive and visually appealing
9. Return ONLY the HTML code in a \`\`\`html block, followed by a brief explanation

The module should be educational, engaging, and immediately usable in a browser.`;

const EDIT_SYSTEM = `You are an expert educational content editor. You will be given existing HTML
and an edit instruction. Return the COMPLETE updated HTML document with the changes applied.

Rules:
1. Return the complete HTML (not just the changed part)
2. Preserve all existing content unless told to remove it
3. Apply the requested changes precisely
4. Return ONLY the HTML in a \`\`\`html block, followed by a brief explanation of what you changed.`;

// ─── Playwright browser management ───────────────────────────────────
let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function getNewPage() {
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: 1280, height: 720 } });
  return context.newPage();
}

// ─── Routes ──────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    kimi_configured: !!KIMI_API_KEY,
    playwright_ready: !!browser,
  });
});

// AI generates a module from a prompt
app.post('/generate', async (req, res) => {
  try {
    const { prompt, current_html } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    let messages;
    if (current_html) {
      messages = [
        { role: 'system', content: EDIT_SYSTEM },
        { role: 'user', content: `Here is the current module HTML:\n\n\`\`\`html\n${current_html}\n\`\`\`\n\nInstruction: ${prompt}` },
      ];
    } else {
      messages = [
        { role: 'system', content: GENERATE_SYSTEM },
        { role: 'user', content: prompt },
      ];
    }

    const result = await callKimi(messages, { max_tokens: 8192 });
    // Try content first, then reasoning (Kimi may put HTML in reasoning_content)
    let html = extractHtml(result.content);
    if (!html && result.reasoning) {
      html = extractHtml(result.reasoning);
    }
    
    let reply = result.content;
    // Remove the HTML block from the reply to get just the explanation
    reply = reply.replace(/```html\s*\n?[\s\S]*?```/gi, '').replace(/```[\s\S]*?```/gi, '').trim();
    if (!reply) reply = 'Module generated successfully. You can preview it below.';

    if (!html) {
      return res.status(500).json({ 
        error: 'AI did not generate valid HTML. Please try again with a different prompt.',
        raw_content: result.content.substring(0, 500),
      });
    }

    res.json({ html, reply });
  } catch (error) {
    console.error('Generate error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// AI edits existing HTML
app.post('/edit', async (req, res) => {
  try {
    const { instruction, current_html } = req.body;
    if (!instruction || !current_html) {
      return res.status(400).json({ error: 'instruction and current_html required' });
    }

    const messages = [
      { role: 'system', content: EDIT_SYSTEM },
      { role: 'user', content: `Here is the current module HTML:\n\n\`\`\`html\n${current_html}\n\`\`\`\n\nEdit instruction: ${instruction}` },
    ];

    const result = await callKimi(messages);
    let html = extractHtml(result.content);
    if (!html && result.reasoning) {
      html = extractHtml(result.reasoning);
    }
    
    let reply = result.content.replace(/```html\s*\n?[\s\S]*?```/gi, '').replace(/```[\s\S]*?```/gi, '').trim();
    if (!reply) reply = 'Module updated successfully.';

    if (!html) {
      return res.status(500).json({ 
        error: 'AI did not generate valid HTML. Please try again.',
      });
    }

    res.json({ html, reply });
  } catch (error) {
    console.error('Edit error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Load HTML into Playwright and return a screenshot
app.post('/start', async (req, res) => {
  let testPage;
  try {
    const { htmlContent } = req.body;
    if (!htmlContent) return res.status(400).json({ error: 'htmlContent required' });

    testPage = await getNewPage();
    await testPage.setContent(htmlContent, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await testPage.waitForTimeout(500);

    const screenshot = await testPage.screenshot({ encoding: 'base64', fullPage: false });
    res.json({ screenshot });
  } catch (error) {
    console.error('Start error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (testPage) await testPage.close().catch(() => {});
  }
});

// Execute an action (click, type) and return new screenshot
let activePage = null;
app.post('/action', async (req, res) => {
  try {
    const { action, selector, text } = req.body;
    if (!activePage) return res.status(400).json({ error: 'No active page. Call /start first.' });

    if (action === 'click') {
      await activePage.click(selector);
    } else if (action === 'type') {
      await activePage.fill(selector, text);
    } else if (action === 'scroll') {
      await activePage.evaluate(() => window.scrollBy(0, 500));
    }

    await activePage.waitForTimeout(500);
    const screenshot = await activePage.screenshot({ encoding: 'base64', fullPage: false });
    res.json({ success: true, screenshot });
  } catch (error) {
    console.error('Action error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI autonomously tests a module
app.post('/test', async (req, res) => {
  let testPage;
  try {
    const { htmlContent } = req.body;
    if (!htmlContent) return res.status(400).json({ error: 'htmlContent required' });

    testPage = await getNewPage();
    await testPage.setContent(htmlContent, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await testPage.waitForTimeout(1000);

    const screenshotBuffer = await testPage.screenshot({ type: 'png', fullPage: false });
    const screenshotB64 = screenshotBuffer.toString('base64');

    const messages = [
      { role: 'system', content: 'You are an AI QA tester. Analyze this rendered HTML module screenshot. Return JSON: {"issues": [...], "overall": "good|needs_work|broken", "suggestions": [...]}' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this rendered HTML module. The HTML:\n\n' + htmlContent.substring(0, 3000) },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotB64}` } },
        ],
      },
    ];

    const result = await callKimi(messages, { max_tokens: 4096 });
    let analysis;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { issues: [], overall: 'unknown', raw: result.content };
    } catch (e) {
      analysis = { issues: [], overall: 'unknown', raw: result.content };
    }

    res.json({ analysis, screenshot: screenshotB64 });
  } catch (error) {
    console.error('Test error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (testPage) await testPage.close().catch(() => {});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Module Tester running on port ${PORT}`);
  console.log(`Kimi API: ${KIMI_API_KEY ? 'configured' : 'NOT configured'}`);
});
