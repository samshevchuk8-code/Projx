require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// This app is "bring your own key": each visitor supplies their OWN AI key
// from the browser, used only for that one request. The server holds no key of
// its own, so visitors can never spend your credits. The key is read from a
// request header, used once, and never stored or logged.
//
// Two providers are supported, auto-detected from the key's shape:
//   - Anthropic (Claude) — keys start with "sk-ant-"  (paid / free trial credit)
//   - Google Gemini      — keys start with "AIza"      (permanently free tier)
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ---- Free managed AI agent + usage-based billing (optional) ----------------
// If you set SERVER_AI_KEY, the app offers a managed agent that uses YOUR key.
//
// The billing model is monthly, usage-based:
//   • Every visitor starts on the FREE plan with a monthly token allowance.
//   • When the FREE allowance is spent, the agent is paywalled (HTTP 402) and
//     they must pick a paid plan (Stripe links) or paste their own key.
//   • Each PAID plan INCLUDES a larger monthly token allowance. If a paid user
//     goes OVER their included amount, they keep building and are billed for
//     the OVERAGE — only for how much they went over, at $/1,000 tokens.
//   • Allowances RESET every calendar month.
//
// A free, strong default: a Google Gemini key (AIza…) has a permanently free
// tier — set it as SERVER_AI_KEY and the managed agent costs you nothing.
//
// NOTE: usage + plan assignment are tracked IN MEMORY (reset on restart) and
// keyed by an anonymous browser id — demo-grade metering, not hardened billing.
// For production, persist usage in a database, set the plan from a verified
// Stripe webhook, and report overage to Stripe metered billing.
const SERVER_AI_KEY = (process.env.SERVER_AI_KEY || '').trim();
const STRIPE_PRO_LINK = process.env.STRIPE_PRO_LINK || '';
const STRIPE_STUDIO_LINK = process.env.STRIPE_STUDIO_LINK || '';
const COURSE_LINK = process.env.COURSE_LINK || '';
const MARKETING_LINK = process.env.MARKETING_LINK || '';
const DOMAIN_SEARCH_LINK = process.env.DOMAIN_SEARCH_LINK || '';

// Plans: each has an included monthly token allowance, a monthly price, and an
// overage rate ($ per 1,000 tokens over the included amount). The FREE plan has
// no overage — it hard-stops and must upgrade. All tunable via env.
const PLANS = {
  free: {
    id: 'free', name: 'Free', price: 0,
    monthlyTokens: parseInt(process.env.FREE_TOKEN_QUOTA || '100000', 10),
    overagePer1k: 0, allowOverage: false,
    link: '',
  },
  pro: {
    id: 'pro', name: 'Pro', price: 12,
    monthlyTokens: parseInt(process.env.PRO_TOKENS || '2000000', 10),
    overagePer1k: parseFloat(process.env.PRO_OVERAGE_PER_1K || '0.002'),
    allowOverage: true,
    link: STRIPE_PRO_LINK,
  },
  studio: {
    id: 'studio', name: 'Studio', price: 39,
    monthlyTokens: parseInt(process.env.STUDIO_TOKENS || '10000000', 10),
    overagePer1k: parseFloat(process.env.STUDIO_OVERAGE_PER_1K || '0.0015'),
    allowOverage: true,
    link: STRIPE_STUDIO_LINK,
  },
};

// Per-visitor token tally, scoped to the current month so it resets monthly.
const usage = new Map();        // `${clientId}|${YYYY-MM}` -> tokens used
const planOf = new Map();       // clientId -> plan id (set on payment)
function currentPeriod() { return new Date().toISOString().slice(0, 7); } // YYYY-MM
function usageKey(id) { return `${id}|${currentPeriod()}`; }
function getUsage(id) { return usage.get(usageKey(id)) || 0; }
function addUsage(id, tokens) { if (id && tokens > 0) usage.set(usageKey(id), getUsage(id) + tokens); }
function getPlan(id) { return PLANS[planOf.get(id)] || PLANS.free; }

// A full billing snapshot for a visitor this month.
function usageSummary(id) {
  const plan = getPlan(id);
  const used = getUsage(id);
  const included = plan.monthlyTokens;
  const overageTokens = Math.max(0, used - included);
  const overageCost = +(overageTokens / 1000 * plan.overagePer1k).toFixed(2);
  return {
    plan: plan.id,
    planName: plan.name,
    used,
    included,
    remaining: Math.max(0, included - used),
    allowOverage: plan.allowOverage,
    overageTokens,
    overagePer1k: plan.overagePer1k,
    overageCost,
    period: currentPeriod(),
  };
}

// Behind a host's load balancer (Render, Railway, Fly, etc.) the client IP
// arrives in X-Forwarded-For. Trust it so the rate limiter buckets per real
// visitor instead of lumping everyone under the proxy's single IP.
app.set('trust proxy', true);

app.use(express.json({ limit: '8mb' }));
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

// Figure out which provider a key belongs to from its shape. We only sanity-
// check the prefix so we can give a clear error; the real validation is the
// provider accepting or rejecting it.
function detectProvider(key) {
  if (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return 'anthropic';
  if (/^AIza[A-Za-z0-9_-]{30,}$/.test(key)) return 'gemini';
  return null;
}

// The agent returns a short, human reply AND a whole multi-file website project
// on every turn. We separate the two with sentinels so the frontend can show
// the chat message in the conversation and load each file into the workspace
// (file explorer + editor + live preview).
//
// Sentinels are far more robust than JSON here: escaping multiple whole source
// files into one JSON string balloons tokens and breaks on the slightest stray
// quote or backslash. The format is line-based and easy to parse forgivingly.
const FILES_MARKER = '===FILES===';
const FILE_HEADER = /^===FILE:\s*(.+?)\s*===$/; // ===FILE: path/name.ext===
const END_MARKER = '===END==='; // optional terminator

const SYSTEM_PROMPT = `You are an expert full-stack web design agent inside an app called "Atelier" — an AI website builder (think Replit, but focused entirely on shipping beautiful, real websites). A person describes a website, then keeps chatting with you to build and refine it: "make the header darker", "add an about page", "wire up the contact form", "use a more playful font".

You maintain ONE website PROJECT made of multiple files across the whole conversation, and you edit it in place from one turn to the next.

On EVERY turn you must reply in EXACTLY this format:

<a short, friendly message — 1 to 3 sentences — saying what you just built or changed>
${FILES_MARKER}
===FILE: index.html===
<the complete contents of index.html>
===FILE: styles.css===
<the complete contents of styles.css>
===FILE: script.js===
<the complete contents of script.js>
${END_MARKER}

Rules for the message (everything before ${FILES_MARKER}):
- Brief and conversational. No markdown, no code, no bullet lists.
- Describe the change you made, not the whole site.

Rules for the files (everything after ${FILES_MARKER}):
- Output the ENTIRE project — every file, in full — on EVERY turn, even for a tiny tweak. Never send a diff, a snippet, or "...". The workspace replaces the whole project with exactly the files you return, so any file you omit is DELETED.
- Begin each file with a line of the exact form: ===FILE: <relative/path>===  then the file's full contents on the following lines.
- There MUST be a file named "index.html" — it is the site's entry point/home page.
- Split concerns into real files: put CSS in "styles.css" and JS in "script.js" and link them from the HTML (<link rel="stylesheet" href="styles.css"> and <script src="script.js" defer></script>). For multi-page sites, add more .html pages (e.g. "about.html", "contact.html") and link between them with relative hrefs. Shared CSS/JS should be reused across pages, not duplicated.
- Use ONLY plain HTML, CSS, and vanilla JavaScript — no build step, no frameworks that need compiling, no npm. The files must work by opening index.html directly.
- You MAY load fonts/icons from a CDN (e.g. Google Fonts), but the site must still look fine if the CDN fails.
- For images use https://placehold.co or CSS gradients/shapes — never images that need an API key.
- Make it genuinely good: clear visual hierarchy, real sample copy that fits the request (no lorem ipsum), responsive layout (it is shown in a resizable frame), accessible markup, and a cohesive palette and typography.
- When the user asks for a change, KEEP everything else intact and only modify what they asked for, unless they ask for a fresh start.

Never wrap files in markdown code fences. Never write anything after the last file (or after ${END_MARKER}).`;

/**
 * Pull the chat reply and the set of project files out of one model response.
 * Returns { reply, files } where files is [{ path, content }]. Tolerant of a
 * few ways the model might drift from the exact format.
 */
function parseProjectResponse(raw) {
  const text = (raw || '').replace(/\r\n/g, '\n').trim();

  const markerIdx = text.indexOf(FILES_MARKER);
  let reply = '';
  let body = '';

  if (markerIdx !== -1) {
    reply = text.slice(0, markerIdx).trim();
    body = text.slice(markerIdx + FILES_MARKER.length).trim();
  } else {
    // No FILES marker. Maybe the model emitted file headers directly, or just
    // a single HTML document. Try to recover something usable.
    const firstHeader = text.search(/^===FILE:/m);
    if (firstHeader !== -1) {
      reply = text.slice(0, firstHeader).trim();
      body = text.slice(firstHeader).trim();
    } else {
      const lower = text.toLowerCase();
      const docIdx = lower.indexOf('<!doctype');
      const start = docIdx !== -1 ? docIdx : lower.indexOf('<html');
      if (start !== -1) {
        reply = text.slice(0, start).trim();
        let html = text.slice(start).trim();
        html = stripFence(html);
        return { reply: reply || 'Here’s your website.', files: [{ path: 'index.html', content: html }] };
      }
      return { reply: text || 'I wasn’t able to build that — try rephrasing.', files: [] };
    }
  }

  const files = parseFiles(body);

  if (!reply) reply = files.length ? 'Here’s your website.' : 'I wasn’t able to build that — try rephrasing.';
  return { reply, files };
}

// Walk the body line by line, splitting on "===FILE: path===" headers.
function parseFiles(body) {
  const lines = body.split('\n');
  const files = [];
  let current = null;
  let buf = [];

  const flush = () => {
    if (current) {
      let content = buf.join('\n');
      content = stripFence(content).replace(/\s+$/, '') + '\n';
      files.push({ path: current, content });
    }
    buf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const header = trimmed.match(FILE_HEADER);
    if (header) {
      flush();
      current = sanitizePath(header[1]);
      continue;
    }
    if (trimmed === END_MARKER || trimmed === FILES_MARKER) {
      // Terminator (or a stray repeated marker): stop collecting this file.
      flush();
      current = null;
      continue;
    }
    if (current) buf.push(line);
  }
  flush();

  // De-dupe by path (last one wins) and drop empties.
  const byPath = new Map();
  for (const f of files) {
    if (f.path && f.content.trim()) byPath.set(f.path, f);
  }
  return [...byPath.values()];
}

// Keep paths safe and relative: no leading slash, no "..", no backslashes.
function sanitizePath(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

function stripFence(s) {
  return s.replace(/^```[a-zA-Z0-9]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

// --- Provider calls ---------------------------------------------------------
// Each takes the visitor's key + the sanitised conversation and returns the
// model's raw text. On failure they throw an error carrying `.status` and
// `.providerMessage` so the one catch block below can speak for both providers.

async function callAnthropic(apiKey, convo) {
  // Client is built per-request from the visitor's key and discarded.
  const anthropic = new Anthropic({ apiKey });
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    messages: convo,
  });
  const textBlock = message.content.find((block) => block.type === 'text');
  const u = message.usage || {};
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0);
  return { text: textBlock ? textBlock.text : '', tokens };
}

async function callGemini(apiKey, convo) {
  // Gemini uses role "model" instead of "assistant", and a separate
  // system_instruction. thinkingBudget:0 keeps the whole output budget for the
  // files so a multi-page project doesn't get truncated by internal thinking.
  const contents = convo.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          maxOutputTokens: 48000,
          temperature: 1,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );

  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch (e) { /* non-JSON error body */ }
    const err = new Error('Gemini request failed');
    err.status = res.status;
    err.providerMessage = (errBody && errBody.error && errBody.error.message) || '';
    throw err;
  }

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
  const um = data.usageMetadata || {};
  const tokens = um.totalTokenCount || ((um.promptTokenCount || 0) + (um.candidatesTokenCount || 0));
  return { text, tokens };
}

// Render the current project as plain text the agent can read & edit from. We
// attach it to the latest user turn rather than replaying every past version of
// every file (which would burn an enormous number of tokens). Prior assistant
// turns in `convo` are just the short chat replies — enough conversational
// memory without resending old file contents.
function renderCurrentFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const blocks = files
    .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => `===FILE: ${sanitizePath(f.path)}===\n${f.content}`);
  if (!blocks.length) return '';
  return `--- CURRENT PROJECT FILES ---\n${blocks.join('\n')}\n--- END CURRENT PROJECT FILES ---`;
}

// Public plan catalog (no secrets) the UI renders from, so pricing and the
// usage meter always match the server's real numbers.
function publicPlans() {
  return Object.values(PLANS).map((p) => ({
    id: p.id, name: p.name, price: p.price,
    monthlyTokens: p.monthlyTokens,
    overagePer1k: p.overagePer1k,
    allowOverage: p.allowOverage,
    link: p.link,
  }));
}

// Non-secret client config: whether the managed agent is available, the plan
// catalog, and the (public) payment / add-on links. No keys here.
app.get('/api/config', (req, res) => {
  res.json({
    managedAgent: !!SERVER_AI_KEY,
    freeTokens: PLANS.free.monthlyTokens,
    plans: publicPlans(),
    stripeProLink: STRIPE_PRO_LINK,
    stripeStudioLink: STRIPE_STUDIO_LINK,
    courseLink: COURSE_LINK,
    marketingLink: MARKETING_LINK,
    domainSearchLink: DOMAIN_SEARCH_LINK,
  });
});

// Current month's usage + billing snapshot for this anonymous visitor.
app.get('/api/usage', (req, res) => {
  const cid = req.get('x-client-id') || req.ip || 'unknown';
  res.json(Object.assign({ managedAgent: !!SERVER_AI_KEY }, usageSummary(cid)));
});

// Activate a paid plan for this visitor. In production this is the job of a
// VERIFIED Stripe webhook (checkout.session.completed) — do NOT trust the
// client. This stub exists so the billing flow is demonstrable end-to-end; it
// only runs when ALLOW_DEV_BILLING=1.
app.post('/api/activate-plan', (req, res) => {
  if (process.env.ALLOW_DEV_BILLING !== '1') {
    return res.status(403).json({ error: 'Plan activation is handled by the payment webhook in production.' });
  }
  const cid = req.get('x-client-id') || req.ip || 'unknown';
  const plan = (req.body && req.body.plan) || '';
  if (!PLANS[plan]) return res.status(400).json({ error: 'Unknown plan.' });
  planOf.set(cid, plan);
  res.json(usageSummary(cid));
});

app.post('/api/chat', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Wait a bit and try again.' });
  }

  const cid = req.get('x-client-id') || ip;
  const userKey = getUserKey(req);

  // Decide which key powers this request:
  //  - the visitor's own key  -> unlimited, never metered
  //  - else the server's free managed key -> metered against the free quota
  //  - else nothing configured -> ask the visitor for a key
  let apiKey, provider, metered;
  if (userKey) {
    provider = detectProvider(userKey);
    if (!provider) {
      return res.status(401).json({
        error: 'That doesn’t look like a valid key. Use a free Google Gemini key ("AIza…") or an Anthropic key ("sk-ant-…").',
        code: 'BAD_KEY',
      });
    }
    apiKey = userKey;
    metered = false;
  } else if (SERVER_AI_KEY) {
    // Plan-aware metering. Free users hard-stop at their monthly allowance;
    // paid users may exceed it and accrue overage (billed per 1k tokens over).
    const plan = getPlan(cid);
    if (getUsage(cid) >= plan.monthlyTokens && !plan.allowOverage) {
      return res.status(402).json({
        error: 'You’ve used your free monthly tokens. Pick a plan to keep building, or add your own AI key for unlimited use.',
        code: 'QUOTA_EXCEEDED',
        usage: usageSummary(cid),
        upgrade: { pro: STRIPE_PRO_LINK, studio: STRIPE_STUDIO_LINK },
      });
    }
    apiKey = SERVER_AI_KEY;
    provider = detectProvider(SERVER_AI_KEY);
    if (!provider) {
      // Misconfigured server key — fail clearly instead of leaking it upstream.
      return res.status(500).json({ error: 'The free agent is misconfigured on the server.' });
    }
    metered = true;
  } else {
    return res.status(401).json({
      error: 'Add an AI key to start building. It stays in your browser and is used only for your own requests.',
      code: 'NO_KEY',
    });
  }

  const { messages, currentFiles } = req.body || {};

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

  const projectText = renderCurrentFiles(currentFiles);
  if (projectText) {
    lastUser.content =
      `Here are the current files of the website project you produced. Modify them to satisfy my request, ` +
      `keeping everything else intact unless I ask otherwise. Remember to return EVERY file in full.\n\n` +
      `${projectText}\n\n` +
      `My request: ${lastUser.content}`;
  }

  try {
    const result =
      provider === 'gemini'
        ? await callGemini(apiKey, convo)
        : await callAnthropic(apiKey, convo);

    if (metered) addUsage(cid, result.tokens);

    const { reply, files } = parseProjectResponse(result.text);
    res.json({
      reply,
      files,
      usage: metered ? usageSummary(cid) : null,
    });
  } catch (err) {
    // Pull the real reason out of the provider error so the visitor can act on
    // it, instead of hiding everything behind a generic "failed" message.
    const status = err && err.status;
    const apiType = err && err.error && err.error.error && err.error.error.type;
    const apiMsg =
      (err && err.providerMessage) ||
      (err && err.error && err.error.error && err.error.error.message) ||
      '';

    // Log only status/type/message — never the raw error (it can echo request
    // data) and never the key (it travels in a header, not in these fields).
    console.error('AI provider error:', provider, status, apiType, apiMsg);

    // An invalid/expired key. Anthropic returns 401/403; Gemini returns 400
    // with an "API key not valid" message — catch that here, before the
    // generic 400 branch, so it reads as a key problem, not a request problem.
    const badKeyMsg = /api[\s_]?key not valid|api_key_invalid|invalid api key|invalid x-api-key|permission/i;
    if (status === 401 || status === 403 || (status === 400 && badKeyMsg.test(apiMsg))) {
      return res.status(401).json({
        error: 'Your API key was rejected. Check that the key is correct and still active.',
        code: 'KEY_REJECTED',
      });
    }

    // Anthropic only: out of credit / billing not set up. (Gemini's free tier
    // has no credit concept — it never hits this.)
    if (status === 400 && /credit|billing|too low/i.test(apiMsg)) {
      return res.status(402).json({
        error:
          'Your Anthropic account has no credit. Add billing or claim the free trial credit at ' +
          'console.anthropic.com — or switch to a free Google Gemini key instead.',
        code: 'NO_CREDIT',
      });
    }

    if (status === 429) {
      return res.status(429).json({
        error:
          provider === 'gemini'
            ? 'You hit Google’s free-tier limit for now. Wait a minute and try again.'
            : 'Anthropic rate-limited your key. Wait a moment and try again.',
      });
    }

    if (status === 400) {
      // Surface the actual validation message rather than a vague failure.
      return res.status(400).json({
        error: apiMsg ? `The AI provider rejected the request: ${apiMsg}` : 'The request was invalid.',
      });
    }

    if (status === 529 || (status >= 500 && status <= 599)) {
      return res.status(502).json({
        error: 'The AI provider is temporarily overloaded. Wait a moment and try again.',
      });
    }

    // Unknown failure (often a network/timeout reaching the provider). Include
    // any message we have so it isn't a dead end.
    res.status(502).json({
      error: apiMsg
        ? `The AI agent failed: ${apiMsg}`
        : 'The AI agent could not reach the provider. Check your connection and try again.',
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Atelier — AI Website Builder running at http://localhost:${PORT}`);
  console.log('   Bring-your-own-key: visitors use a free Gemini key or an Anthropic key.\n');
});
