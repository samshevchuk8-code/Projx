# Atelier — AI Website Builder

Describe a website in plain English and an **AI agent builds it for you** — a
real, multi-file project (pages, stylesheets, scripts) you can preview live,
edit by hand, and download. Then keep chatting to refine it: "add an about
page", "make it dark mode", "wire up the contact form". Think Replit, but
focused entirely on shipping beautiful, real websites.

It's three things in one:

1. **The builder** (`/app`) — a workspace with a chat agent, a file explorer, an
   editable code editor, and a live preview.
2. **A marketing campaign site** (`/`) — a full landing page that sells the
   product, with pricing tiers, a course, a marketing toolkit, and a domain
   search.
3. **A monetization layer** — a free token allowance that paywalls once spent
   (HTTP 402), with upgrade plans, add-ons, and a domain flow, all wired to
   configurable payment links.

## How the agent works

It's a conversational loop, not a one-shot generator:

1. **Frontend** (`public/app.html`, `public/app.js`) — chat on the left;
   file explorer + editor/preview on the right. Each message is POSTed to
   `/api/chat` with the conversation and the project's current files.
2. **Backend** (`server.js`) — an Express server with one main route,
   `POST /api/chat`. It sends the short conversation plus the current files to
   the AI provider with a system prompt that makes the agent reply in two parts:
   a one-to-three-sentence chat message, a `===FILES===` sentinel, then the
   **complete set of project files**, each introduced by `===FILE: path===`.
   The server parses that into `{ reply, files }`.
3. **Editing in place** — the current files are sent back with each follow-up,
   so the agent edits the existing project instead of starting over. Your manual
   edits in the code editor are included too, so the agent sees them.
4. **Preview** — the files are assembled into one self-contained document
   (local `<link>`/`<script>` references are inlined) and loaded into a sandboxed
   `<iframe srcdoc>`, which updates after every turn and every edit.
5. **Persistence** — projects are saved in your browser (localStorage). Switch
   between projects, rename, delete — no signup needed.
6. **Export** — download the whole project as a `.zip` (a tiny, dependency-free
   ZIP writer in `public/zip.js`).

## Running it

```bash
npm install
npm start
```

Open http://localhost:3000 for the landing page, or
http://localhost:3000/app.html for the builder.

## Run on Replit

This repo ships with a `.replit` config, so it imports and runs with no setup:

1. In Replit: **Create Repl → Import from GitHub** and paste this repo's URL.
2. Click **Run**. The config installs dependencies and starts the server; the
   webview opens the landing page (add `/app.html` for the builder).
3. *(Optional)* To enable the **free managed AI agent** without committing a key,
   open the **Secrets** tab (lock icon) and add a secret named `SERVER_AI_KEY`
   with a free Google Gemini key (`AIza…`). Add the billing/monetization vars
   (see the table below) as Secrets too if you want them. Leave `SERVER_AI_KEY`
   unset to run in bring-your-own-key mode.
4. Use **Deploy** for a public URL (Autoscale or Reserved VM both work).

## AI keys, the free agent, and credits

There are two ways the agent can be powered:

### 1. Bring-your-own-key (default, unlimited, free to host)

With no configuration, every visitor pastes their **own** AI key in the browser.
Nobody can ever spend *your* credits. Two providers are auto-detected:

| Provider | Key looks like | Cost |
|----------|----------------|------|
| **Google Gemini** (recommended) | `AIza…` | **Free tier** — no card, no expiry. https://aistudio.google.com/apikey |
| **Anthropic (Claude)** | `sk-ant-…` | Pay-as-you-go (new accounts get trial credit). https://console.anthropic.com/settings/keys |

The key is stored **only in that visitor's browser** (`localStorage`), sent as
the `x-anthropic-key` header per request, used once, and **never stored or
logged** server-side.

### 2. Free managed agent + usage-based billing (the freemium model)

Set `SERVER_AI_KEY` and the app offers a **managed agent that needs no key from
the visitor**, powered by your key and **metered, monthly, usage-based**:

- Every visitor starts on the **Free** plan with a monthly token allowance
  (`FREE_TOKEN_QUOTA`). When it's spent, `/api/chat` returns **HTTP 402** and the
  UI shows the **upgrade modal**.
- **Paid plans include a larger monthly allowance.** Pro = `PRO_TOKENS`,
  Studio = `STUDIO_TOKENS`.
- **Overage:** if a *paid* visitor goes over their included allowance, they keep
  building and are billed **only for the overage** — by how much they exceed it,
  at `$/1,000 tokens` (`PRO_OVERAGE_PER_1K`, `STUDIO_OVERAGE_PER_1K`). The Free
  plan has no overage — it hard-stops.
- **Allowances reset every calendar month** (usage is bucketed by `YYYY-MM`).

The live usage meter in the workspace shows `plan · used / included this month`,
and switches to `plan · +N over · $X` once a paid user is in overage.

> **Tip:** a Google Gemini key (`AIza…`) has a permanently free tier, so you can
> run the managed agent at no cost.
>
> **How plans get assigned:** in production, a **verified Stripe webhook** should
> set the visitor's plan after checkout. For local testing, set
> `ALLOW_DEV_BILLING=1` and `POST /api/activate-plan { "plan": "pro" }` (with the
> `x-client-id` header) to simulate a successful purchase.
>
> **Note:** usage + plan are tracked **in-memory**, keyed by an anonymous browser
> id — demo-grade metering that resets on restart, not hardened billing. For
> production, persist usage in a database, set plans from verified Stripe
> webhooks, and report overage to Stripe metered billing.

## Monetization (configurable)

The landing page, builder upgrade modal, and course page all read non-secret
config from `GET /api/config` and wire their buttons to links you provide via
env vars (no payment code or secrets live in this repo):

| Env var | Wires up |
|---------|----------|
| `STRIPE_PRO_LINK` | "Go Pro" buttons |
| `STRIPE_STUDIO_LINK` | "Get Studio" buttons |
| `COURSE_LINK` | Course enrollment |
| `MARKETING_LINK` | Marketing toolkit checkout |
| `DOMAIN_SEARCH_LINK` | Domain search (use `{domain}` as the query placeholder) |

Create Stripe **Payment Links** in the Stripe dashboard for the plans, paste the
URLs here, and the buttons go live. The domain search falls back to a demo
availability check + a registrar link if `DOMAIN_SEARCH_LINK` is unset.

## Your own AI endpoint (API gateway)

The app can expose **your own AI API** — an OpenAI-compatible endpoint at `/v1`,
protected by API keys you issue, backed by the model behind `SERVER_AI_KEY`
(e.g. a free Gemini key). Point any OpenAI SDK/tool at it by changing the base
URL. It needs `SERVER_AI_KEY` set, and auto-enables when it is.

Set the keys callers must present:

```
SERVER_AI_KEY=AIza...                 # the backing model (free Gemini works)
GATEWAY_KEYS=atl_live_yourkey         # comma-separated keys you accept
```

(If you enable it with no `GATEWAY_KEYS`, a random key is generated and printed
to the logs at startup.)

**Endpoints** (all require `Authorization: Bearer <your gateway key>`):

- `GET /v1/models` — list the served model.
- `POST /v1/chat/completions` — OpenAI-compatible chat completion.
- `POST /v1/generate` — simple `{ prompt | messages, system?, max_tokens? }` →
  `{ text, tokens, model }`.

Example:

```bash
curl https://YOUR-HOST/v1/chat/completions \
  -H "Authorization: Bearer atl_live_yourkey" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Write a haiku about the sea."}]}'
```

Use it from the OpenAI SDK by setting `baseURL` to `https://YOUR-HOST/v1` and
`apiKey` to one of your `GATEWAY_KEYS`.

> It's a **gateway**, not a model — it wraps whatever `SERVER_AI_KEY` points to.
> Usage on the gateway draws on that backing key's quota; protect your gateway
> keys and add per-key metering/billing (like the website builder has) before
> exposing it widely.

## API

- `GET /api/config` — non-secret client config (managed-agent on/off, free token
  quota, public payment/add-on links). No keys.
- `GET /api/usage` — current free-tier usage for the anonymous visitor
  (`x-client-id` header).
- `POST /api/chat` — `{ messages, currentFiles }` → `{ reply, files, usage }`.
  Returns `402 QUOTA_EXCEEDED` when the free allowance is spent.

## Configuration (all optional)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | server port |
| `MODEL` | `claude-sonnet-4-6` | Anthropic model |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model |
| `SERVER_AI_KEY` | — | enables the free managed agent |
| `FREE_TOKEN_QUOTA` | `100000` | Free plan tokens / month |
| `PRO_TOKENS` / `STUDIO_TOKENS` | `2000000` / `10000000` | included tokens / month |
| `PRO_OVERAGE_PER_1K` / `STUDIO_OVERAGE_PER_1K` | `0.002` / `0.0015` | $ per 1k tokens over plan |
| `ALLOW_DEV_BILLING` | — | `1` lets `/api/activate-plan` set a plan without payment (testing) |
| `STRIPE_PRO_LINK`, `STRIPE_STUDIO_LINK`, `COURSE_LINK`, `MARKETING_LINK`, `DOMAIN_SEARCH_LINK` | — | monetization links |

Copy `.env.example` to `.env` to set any of these.

## Project structure

```
atelier/
├── server.js              # Express server: agent loop, metering, config/usage APIs
├── package.json
├── .env.example
└── public/
    ├── index.html         # marketing landing page (campaign)
    ├── course.html        # course landing page
    ├── app.html           # the builder workspace
    ├── app.js             # projects, files, editor, preview, chat, metering UI
    ├── zip.js             # dependency-free .zip export
    ├── styles.css         # shared + workspace styles
    └── landing.css        # marketing styles
```

## Deploy

The repo ships with a `Dockerfile`, a `Procfile`, and a Render Blueprint
(`render.yaml`). It runs key-free by default (bring-your-own-key); set the env
vars above to enable the managed agent and monetization. Always serve over HTTPS
in production so any key in transit is protected.

## What's intentionally left as a stub

- **Payments & domain registration** are wired as *configurable links*, not a
  built-in checkout — plug in your own Stripe + registrar accounts via env vars.
- **Usage metering** is in-memory (see the note above). Add a database for real
  billing and persistence across restarts and instances.
- **No accounts.** Projects live in the browser. Add auth + server-side storage
  if you want cross-device projects.
