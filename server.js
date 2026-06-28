require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// This app is "bring your own key": each visitor supplies their OWN Anthropic
// API key from the browser, and it's used only to make that one request. The
// server holds no key of its own, so visitors can never spend your credits.
// The key is read from a request header, used once, and never stored or logged.
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';

// Behind a host's load balancer (Render, Railway, Fly, etc.) the client IP
// arrives in X-Forwarded-For. Trust it so the rate limiter buckets per real
// visitor instead of lumping everyone under the proxy's single IP.
app.set('trust proxy', true);

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Light in-memory rate limiter — just abuse protection so a single IP can't
// hammer the endpoint. It does NOT protect your credits (visitors use their
// own keys); that's what bring-your-own-key handles. Resets every minute.
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

// Pull the visitor's key from the request. Never log this value.
function getUserKey(req) {
  const header = req.get('x-anthropic-key');
  return typeof header === 'string' ? header.trim() : '';
}

function looksLikeKey(key) {
  // Anthropic keys start with "sk-ant-". We only sanity-check the shape so we
  // can give a clear error; the real validation is Anthropic rejecting it.
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);
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

  const userKey = getUserKey(req);
  if (!userKey) {
    return res.status(401).json({
      error: 'Add your Anthropic API key to start building. It stays in your browser and is used only for your own requests.',
      code: 'NO_KEY',
    });
  }
  if (!looksLikeKey(userKey)) {
    return res.status(401).json({
      error: 'That doesn’t look like a valid Anthropic API key (they start with "sk-ant-").',
      code: 'BAD_KEY',
    });
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
    // Build a client from THIS visitor's key. Created per-request and discarded;
    // the key is never persisted server-side.
    const anthropic = new Anthropic({ apiKey: userKey });

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
    // Pull the real reason out of the Anthropic error so the visitor can act on
    // it, instead of hiding everything behind a generic "failed" message.
    const status = err && err.status;
    const apiType = err && err.error && err.error.error && err.error.error.type;
    const apiMsg = (err && err.error && err.error.error && err.error.error.message) || '';

    // Log only status/type/message — never the raw error (it can echo request
    // data) and never the key (it travels in a header, not in these fields).
    console.error('Claude API error:', status, apiType, apiMsg);

    // Out of credit / billing not set up — the most common first-run failure.
    if (status === 400 && /credit|billing|too low/i.test(apiMsg)) {
      return res.status(402).json({
        error:
          'Your Anthropic account has no credit. Add billing or claim the free trial credit at ' +
          'console.anthropic.com (Settings → Billing), then try again.',
        code: 'NO_CREDIT',
      });
    }

    if (status === 401 || status === 403) {
      return res.status(401).json({
        error: 'Your Anthropic API key was rejected. Check that the key is correct and still active.',
        code: 'KEY_REJECTED',
      });
    }

    if (status === 429) {
      return res.status(429).json({
        error: 'Anthropic rate-limited your key. Wait a moment and try again.',
      });
    }

    if (status === 400) {
      // Surface the actual validation message rather than a vague failure.
      return res.status(400).json({
        error: apiMsg ? `Anthropic rejected the request: ${apiMsg}` : 'The request was invalid.',
      });
    }

    if (status === 529 || (status >= 500 && status <= 599)) {
      return res.status(502).json({
        error: 'Anthropic is temporarily overloaded. Wait a moment and try again.',
      });
    }

    // Unknown failure (often a network/timeout reaching Anthropic). Include any
    // message we have so it isn't a dead end.
    res.status(502).json({
      error: apiMsg
        ? `The AI agent failed: ${apiMsg}`
        : 'The AI agent could not reach Anthropic. Check your connection and try again.',
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ AI Site Builder running at http://localhost:${PORT}`);
  console.log('   Bring-your-own-key: visitors supply their own Anthropic key.\n');
});
