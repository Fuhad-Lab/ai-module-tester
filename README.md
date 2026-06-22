# AI Module Tester — Blue Horizon E-Learning

A Render-hosted backend that uses **Kimi K2.6** (via NVIDIA API) to generate and edit interactive HTML learning modules, and **Playwright** to visually test them.

## Architecture

```
Teacher browser (modules.html)
  → Supabase Edge Function (ai-module)
    → This Render service (/generate, /edit, /test, /start, /action)
      → Kimi K2.6 API (text generation)
      → Playwright (browser screenshots for visual testing)
```

The Kimi API key is stored as a Render environment variable and NEVER exposed to the frontend.

## Deploy to Render

### Option A: Using render.yaml (recommended)
1. Push this repo to GitHub
2. Go to https://dashboard.render.com → New → Blueprint
3. Select this repo
4. Set the `KIMI_API_KEY` environment variable to: `REDACTED`
5. Deploy

### Option B: Manual
1. Push this repo to GitHub
2. Go to https://dashboard.render.com → New → Web Service
3. Select this repo
4. Set:
   - Environment: Docker
   - Or: Node + add build command `npm install && npx playwright install chromium`
5. Add environment variable: `KIMI_API_KEY=REDACTED`
6. Deploy

## After deployment

Once deployed, you'll get a URL like `https://ai-module-tester-xxxx.onrender.com`.

1. Test it: visit `https://your-url.onrender.com/health` — should return `{"status":"ok","kimi_configured":true}`
2. Set the URL as a Supabase secret:
   ```bash
   supabase secrets set MODULE_TESTER_URL=https://your-url.onrender.com
   ```
3. The `ai-module` edge function will then proxy requests to this service.

## Endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/health` | — | `{status, kimi_configured}` |
| POST | `/generate` | `{prompt, current_html?}` | `{html, reply}` |
| POST | `/edit` | `{instruction, current_html}` | `{html, reply}` |
| POST | `/test` | `{htmlContent}` | `{analysis, screenshot}` |
| POST | `/start` | `{htmlContent}` | `{screenshot}` |
| POST | `/action` | `{action, selector?, text?}` | `{success, screenshot}` |
