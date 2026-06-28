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

const MODEL = process.env.MODEL || 'claude-sonnet-4-6';

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Very small in-memory rate limiter so one person can't hammer your API key.
// Resets every minute. Fine for a learning project; swap for something
// real (e.g. a Redis-backed limiter) before this ever goes to production.
const RATE_LIMIT = 20; // requests per IP per minute
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

// The agent returns a short, human reply AND the full website on every turn.
// We separate the two with a sentinel so the frontend can show the chat
// message in the conversation and load the HTML into the live preview.
// (A sentinel is far more robust than JSON here — escaping a whole HTML
// document into a JSON string balloons tokens and breaks easily.)
const HTML_MARKER = '===WEBSITE_HTML===';

const SYSTEM_PROMPT = `You are an expert web design agent inside an app called "AI Site Builder".
A person describes a website, then keeps chatting with you to tune it — "make the
header darker", "add a pricing section", "use a more playful font", and so on.
You maintain ONE single-page website across the whole conversation and edit it
in place from one turn to the next.

On EVERY turn you must reply in exactly this format:

<a short, friendly message — 1 to 3 sentences — saying what you just built or changed>
${HTML_MARKER}
<the COMPLETE, updated HTML document>

Rules for the message (the part before ${HTML_MARKER}):
- Keep it brief and conversational. No markdown, no code, no bullet lists.
- Describe the change you made, not the whole site.

Rules for the HTML (the part after ${HTML_MARKER}):
- Output the ENTIRE document every time, even for a tiny tweak. Never send a diff,
  a snippet, or "...". The frontend replaces the whole preview with what you return.
- It must start with <!DOCTYPE html> and end with </html>.
- One self-contained file: all CSS in a <style> tag in the <head>, all JS in a
  <script> tag. No external stylesheet or JS file references.
- You MAY use a CDN for fonts/icons (e.g. Google Fonts) but the page must still
  work if that CDN fails to load.
- For images use https://placehold.co or CSS gradients/shapes — never images that
  need an API key.
- Make it genuinely good: clear visual hierarchy, real sample copy that fits the
  request (no lorem ipsum), a responsive layout (it is shown in a resizable
  iframe), and a cohesive palette and typography.
- When the user asks for a change, KEEP everything else the same and only modify
  what they asked for, unless they ask for a fresh start.

Never put anything after </html>. Never wrap the HTML in markdown code fences.`;

/**
 * Pull the chat reply and the HTML document out of one model response.
 * Tolerates a few ways the model might drift from the exact format.
 */
function splitReplyAndHtml(raw) {
  const text = (raw || '').trim();

  let reply = '';
  let html = '';

  const markerIdx = text.indexOf(HTML_MARKER);
  if (markerIdx !== -1) {
    reply = text.slice(0, markerIdx).trim();
    html = text.slice(markerIdx + HTML_MARKER.length).trim();
  } else {
    // No sentinel. Fall back to locating where the HTML document starts.
    const lower = text.toLowerCase();
    const docIdx = lower.indexOf('<!doctype');
    const htmlIdx = lower.indexOf('<html');
    const start = docIdx !== -1 ? docIdx : htmlIdx;
    if (start !== -1) {
      reply = text.slice(0, start).trim();
      html = text.slice(start).trim();
    } else {
      // Couldn't find any HTML — treat the whole thing as a chat reply.
      reply = text;
      html = '';
    }
  }

  // Strip a stray markdown fence if the model added one despite instructions.
  html = html.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();

  if (!reply) {
    reply = html ? 'Here’s your website.' : 'I wasn’t able to build that — try rephrasing.';
  }

  return { reply, html };
}

app.post('/api/chat', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Wait a bit and try again.' });
  }

  const { messages, currentHtml } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No conversation provided.' });
  }

  // Sanitise the conversation we forward to the model.
  const convo = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!content) continue;
    convo.push({ role: m.role, content });
  }

  if (convo.length === 0 || convo[convo.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'The last message must be from the user.' });
  }

  const lastUser = convo[convo.length - 1];
  if (lastUser.content.length > 4000) {
    return res.status(400).json({ error: 'That message is too long (max 4000 characters).' });
  }

  // Give the model the current HTML to edit from. We attach it to the latest
  // user turn rather than replaying every past HTML version (which would burn
  // a huge number of tokens). The prior assistant turns in `convo` are just
  // the short chat replies, which is enough conversational memory.
  if (typeof currentHtml === 'string' && currentHtml.trim()) {
    lastUser.content =
      `Here is the current website HTML you produced. Modify it to satisfy my request, ` +
      `keeping everything else intact unless I ask otherwise.\n\n` +
      `--- CURRENT HTML ---\n${currentHtml.trim()}\n--- END CURRENT HTML ---\n\n` +
      `My request: ${lastUser.content}`;
  }

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: convo,
    });

    const textBlock = message.content.find((block) => block.type === 'text');
    const { reply, html } = splitReplyAndHtml(textBlock ? textBlock.text : '');

    res.json({ reply, html });
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(502).json({ error: 'The AI agent failed to respond. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ AI Site Builder running at http://localhost:${PORT}\n`);
});
