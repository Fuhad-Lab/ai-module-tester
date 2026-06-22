/**
 * AI Module Tester & Creator — Blue Horizon E-Learning
 * 
 * This service runs on Render. It provides:
 *  1. AI module generation/editing via Kimi K2.6 (NVIDIA API)
 *  2. Live browser preview via Playwright (for AI visual testing)
 * 
 * Security: The KIMI_API_KEY is stored as a Render environment variable
 * and NEVER exposed to the frontend. The Supabase edge function
 * `ai-module` proxies requests to this service.
 * 
 * Endpoints:
 *  POST /generate  — AI generates module HTML from a prompt
 *  POST /edit      — AI edits existing HTML based on instruction
 *  POST /test      — AI autonomously tests a module (Playwright)
 *  POST /start     — Load HTML into Playwright, return screenshot
 *  POST /action    — Click/type in Playwright, return screenshot
 *  GET  /health    — Health check
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
async function callKimi(messages, { stream = false, max_tokens = 16384 } = {}) {
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
      stream: false, // We don't stream — easier to handle in edge function
      chat_template_kwargs: { thinking: true },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Kimi API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─── Extract HTML from AI response ───────────────────────────────────
// The AI may wrap HTML in ```html ... ``` blocks or return raw HTML.
function extractHtml(text) {
  // Try ```html ... ``` block first
  const htmlMatch = text.match(/```html\s*\n?([\s\S]*?)```/i);
  if (htmlMatch) return htmlMatch[1].trim();
  // Try ``` ... ``` block
  const codeMatch = text.match(/```\s*\n?([\s\S]*?)```/i);
  if (codeMatch && codeMatch[1].includes('<')) return codeMatch[1].trim();
  // Try raw HTML (starts with <!DOCTYPE or <html or <div)
  const trimmed = text.trim();
  if (trimmed.match(/^<!DOCTYPE|<html|<div|<head|<body/i)) {
    return trimmed;
  }
  // Fallback: return as-is
  return trimmed;
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

const TEST_SYSTEM = `You are an AI QA tester. You will receive screenshots of an educational HTML module
rendered in a browser. Your job is to:
1. Visually inspect the module for issues (broken layout, missing content, unreadable text, etc.)
2. Describe what you see
3. Identify any problems
4. Suggest specific fixes

Return a JSON object: {"issues": ["issue1", "issue2"], "overall": "good|needs_work|broken", "suggestions": ["fix1", "fix2"]}`;

// ─── Playwright browser management ───────────────────────────────────
let browser = null;
let page = null;

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

// Health check
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
      // Edit mode — include the current HTML
      messages = [
        { role: 'system', content: EDIT_SYSTEM },
        { role: 'user', content: `Here is the current module HTML:\n\n\`\`\`html\n${current_html}\n\`\`\`\n\nInstruction: ${prompt}` },
      ];
    } else {
      // Generate mode
      messages = [
        { role: 'system', content: GENERATE_SYSTEM },
        { role: 'user', content: prompt },
      ];
    }

    const aiResponse = await callKimi(messages);
    const html = extractHtml(aiResponse);

    // Extract the explanation (text after the HTML block)
    let reply = aiResponse.replace(/```html\s*\n?[\s\S]*?```/i, '').trim();
    if (!reply) reply = 'Module generated successfully. You can preview it below.';

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

    const aiResponse = await callKimi(messages);
    const html = extractHtml(aiResponse);
    let reply = aiResponse.replace(/```html\s*\n?[\s\S]*?```/i, '').trim();
    if (!reply) reply = 'Module updated successfully.';

    res.json({ html, reply });
  } catch (error) {
    console.error('Edit error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Load HTML into Playwright and return a screenshot
app.post('/start', async (req, res) => {
  try {
    const { htmlContent } = req.body;
    if (!htmlContent) return res.status(400).json({ error: 'htmlContent required' });

    page = await getNewPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    res.json({ screenshot });
  } catch (error) {
    console.error('Start error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Execute an action (click, type) and return new screenshot
app.post('/action', async (req, res) => {
  try {
    const { action, selector, text } = req.body;
    if (!page) return res.status(400).json({ error: 'No active page. Call /start first.' });

    if (action === 'click') {
      await page.click(selector);
    } else if (action === 'type') {
      await page.fill(selector, text);
    } else if (action === 'scroll') {
      await page.evaluate(() => window.scrollBy(0, 500));
    } else if (action === 'screenshot') {
      // just take a screenshot
    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    await page.waitForTimeout(500);
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    res.json({ success: true, screenshot });
  } catch (error) {
    console.error('Action error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI autonomously tests a module — loads HTML, takes screenshot, sends to AI for analysis
app.post('/test', async (req, res) => {
  try {
    const { htmlContent } = req.body;
    if (!htmlContent) return res.status(400).json({ error: 'htmlContent required' });

    const testPage = await getNewPage();
    await testPage.setContent(htmlContent, { waitUntil: 'networkidle' });
    await testPage.waitForTimeout(1000);

    // Take a screenshot
    const screenshotBuffer = await testPage.screenshot({ type: 'png', fullPage: false });
    const screenshotB64 = screenshotBuffer.toString('base64');

    // Send to AI for visual analysis (using the screenshot)
    const messages = [
      { role: 'system', content: TEST_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this rendered HTML module screenshot. The HTML being tested is:\n\n' + htmlContent.substring(0, 3000) },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotB64}` } },
        ],
      },
    ];

    const aiResponse = await callKimi(messages, { max_tokens: 4096 });

    let analysis;
    try {
      // Try to parse JSON from the response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { issues: [], overall: 'unknown', suggestions: [], raw: aiResponse };
    } catch (e) {
      analysis = { issues: [], overall: 'unknown', suggestions: [], raw: aiResponse };
    }

    await testPage.close();

    res.json({
      analysis,
      screenshot: screenshotB64,
    });
  } catch (error) {
    console.error('Test error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Module Tester running on port ${PORT}`);
  console.log(`Kimi API: ${KIMI_API_KEY ? 'configured' : 'NOT configured'}`);
});
