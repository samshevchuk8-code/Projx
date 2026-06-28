# AI Site Builder

A full-stack app where you **describe a website in plain English and then keep
chatting with an AI agent to tune it** — "make the header darker", "add a
pricing section", "use a more playful font". The agent rebuilds a single,
self-contained HTML page on every turn and shows it in a live preview, with
buttons to open it in a new tab or download the file.

It's **bring-your-own-key**: every visitor enters their own Anthropic API key,
so nobody can ever spend *your* credits. (See "API keys & credits" below.)

## How it works

It's a conversational loop, not a one-shot generator:

1. **Frontend** (`public/`) — a chat panel on the left, a live preview on the
   right. You send a message; it gets added to the conversation and POSTed to
   `/api/chat` along with the website's current HTML.
2. **Backend** (`server.js`) — an Express server with one route,
   `POST /api/chat`. It sends the whole short conversation plus the current
   HTML to the Claude API with a system prompt that tells the agent to reply in
   two parts on every turn:
   - a one-to-three-sentence chat message about what it changed, then
   - a sentinel (`===WEBSITE_HTML===`), then
   - the **complete, updated** HTML document.

   The server splits those two parts and returns `{ reply, html }`.
3. **Tuning** — because the current HTML is sent back with each follow-up
   message, the agent edits the existing site in place instead of starting
   over. Past assistant chat replies are kept as memory; only the latest full
   HTML is resent (so token usage stays sane).
4. **Preview** — the returned HTML is loaded into an `<iframe srcdoc>`, which
   sandboxes it from the rest of the app and updates after every turn.
5. **Open / Download** — the current HTML can be opened in a new browser tab or
   downloaded as `my-website.html`, both done client-side with a `Blob`.

This is the "AI agent" pattern at a practical level: a stateful, multi-turn
conversation where each turn produces a real, usable artifact you can keep
refining.

## Setup

```bash
npm install
```

That's it — the server needs no API key of its own. (`.env` is optional and
only used for `PORT` / `MODEL`; copy `.env.example` to `.env` if you want to
change those.)

## Run it

```bash
npm start
```

Then open http://localhost:3000. On first load it asks for your Anthropic API
key, describe a site, and start tuning it.

## API keys & credits

This app is **bring-your-own-key (BYOK)** so that hosting it publicly can't run
up *your* Anthropic bill:

- On first visit, the app prompts for an Anthropic API key. You can get one at
  https://console.anthropic.com/settings/keys.
- The key is saved **only in that visitor's browser** (`localStorage`) and sent
  as the `x-anthropic-key` header with each request.
- The server uses that key to build a fresh Anthropic client **per request** and
  then discards it. It is **never written to disk, never logged** (error logs
  record only a status code), and the server keeps no key of its own.
- Each visitor therefore spends **their own** credits. Use "Change key" /
  "Remove key" in the header to update or clear it.

> **Heads-up on hosting:** because the browser sends the key to your server,
> which forwards it to Anthropic, always serve this over **HTTPS** in
> production so the key isn't exposed in transit. The server is a thin proxy and
> stores nothing, but it does see the key in memory for the duration of the
> request — that's inherent to any BYOK proxy. If you'd rather the key never
> touch your server at all, you'd move the Anthropic call into the browser, at
> the cost of exposing request internals client-side.

## Deploy it (get a public URL)

The repo ships with deploy configs so you can put it online without extra
setup. **No API keys to configure** — it's bring-your-own-key, so every visitor
supplies their own. All these hosts serve over HTTPS by default.

### Render (one-click)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/samshevchuk8-code/Projx)

`render.yaml` is a Render Blueprint, so the button (or **New → Blueprint** in the
Render dashboard) reads it and provisions everything. It's pinned to the
`claude/ai-website-builder-w547xb` branch; once that's merged to `main` you can
drop the `branch:` line.

### Railway

New Project → Deploy from GitHub repo. Railway auto-detects Node and runs
`npm start` (there's also a `Procfile`). Set the branch to deploy in the
service settings.

### Fly.io / any container host

A `Dockerfile` is included, so:

```bash
fly launch        # detects the Dockerfile; accept the defaults
fly deploy
```

The same image runs on Google Cloud Run, a VPS, or anything that runs
containers. Hosts that inject their own `PORT` (Render, Railway, Cloud Run) are
handled automatically; `server.js` reads `process.env.PORT`.

## Project structure

```
ai-site-builder/
├── server.js           # Express server + Claude API conversation/edit loop
├── package.json
├── .env.example        # copy to .env and add your key
└── public/
    ├── index.html      # chat panel + live preview
    ├── styles.css
    └── app.js          # conversation state, fetch logic, preview, download
```

## Configuration

- **No server-side API key.** Keys come from each visitor's browser (BYOK).
- `PORT` (optional, default `3000`).
- `MODEL` (optional, default `claude-sonnet-4-6`) — the Claude model the agent
  uses. Sonnet is a good speed/quality balance for this; you can point it at a
  more capable model if you want richer output.

## Notes on what's NOT included (on purpose, for a learning project)

- **No database.** Conversations and generated sites aren't saved — refresh the
  page and it's gone. Add persistence (SQLite/Postgres) if you want people to
  come back to past sites.
- **No accounts.** Anyone who can reach the server can use the app, but they
  use *their own* key/credits (BYOK), not yours. There's also a tiny in-memory
  rate limiter (20 requests/minute per IP) in `server.js` as basic abuse
  protection; it resets on restart and won't hold up under real traffic.
- **Deployment is included** (see "Deploy it" above) but kept minimal — a
  Render Blueprint, a Dockerfile, and a Procfile. No autoscaling, CDN, or
  custom-domain setup; add those per your host when you need them.

## Where to go next

- **Streaming**: use `anthropic.messages.stream()` so the page appears
  progressively instead of after one long wait.
- **Real tool use**: give the agent tools (e.g. `validate_html`,
  `fetch_stock_photo`) so it can act over multiple steps before replying.
- **Per-section editing**: let users click a section in the preview and tune
  just that part.
- **Persistence + accounts**: save each conversation so sites can be reopened
  and kept editing later.
