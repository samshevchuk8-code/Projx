require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n❌ Missing ANTHROPIC_API_KEY.');
  console.error('   Copy .env.example to .env and add your key.\n');
  process.exit(1);
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Very small in-memory rate limiter so one person can't hammer your API key.
// Resets every minute. Fine for a learning project; swap for something
// real (e.g. a Redis-backed limiter) before this ever goes to production.
const RATE_LIMIT = 8; // requests per IP per minute
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const entry = hits.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

const SYSTEM_PROMPT = `You are a website-generating agent. The user will describe a website in plain language.

Respond with ONE complete, self-contained HTML document and nothing else:
- No markdown code fences, no commentary before or after, no explanations.
- All CSS must be inline in a <style> tag in the <head>. Do not link external stylesheets.
- All JS must be inline in a <script> tag. Do not reference external JS files.
- You MAY use a CDN for icons or fonts (e.g. Google Fonts) if it improves the design, but the page must work even if that CDN fails to load.
- Do not use any placeholder images that require an API key. Use https://placehold.co or solid CSS backgrounds/gradients/shapes for visuals instead.
- Make it genuinely good: a clear visual hierarchy, real (not lorem-ipsum) sample copy that fits the request, responsive layout (it will be shown in an iframe and may be resized), and a cohesive color palette and font choice.
- The output must start with <!DOCTYPE html> and end with </html>. Nothing else.`;

app.post('/api/generate', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Wait a bit and try again.' });
  }

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Please describe the website you want.' });
  }
  if (prompt.length > 2000) {
    return res.status(400).json({ error: 'Description is too long (max 2000 characters).' });
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Build this website: ${prompt.trim()}` },
      ],
    });

    const textBlock = message.content.find((block) => block.type === 'text');
    let html = textBlock ? textBlock.text.trim() : '';

    // Safety net: if the model wrapped the output in a markdown fence
    // despite instructions, strip it rather than failing the request.
    html = html.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();

    if (!html.toLowerCase().startsWith('<!doctype') && !html.toLowerCase().startsWith('<html')) {
      console.warn('Model output did not look like a full HTML document.');
    }

    res.json({ html });
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(502).json({ error: 'The AI agent failed to generate a site. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ AI Site Builder running at http://localhost:${PORT}\n`);
});
