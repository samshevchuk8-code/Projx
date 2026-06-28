# AI Site Builder

A full-stack app where you **describe a website in plain English and then keep
chatting with an AI agent to tune it** — "make the header darker", "add a
pricing section", "use a more playful font". The agent rebuilds a single,
self-contained HTML page on every turn and shows it in a live preview, with
buttons to open it in a new tab or download the file.

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
cp .env.example .env
```

Open `.env` and add your real Anthropic API key (get one at
https://console.anthropic.com/settings/keys):

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Run it

```bash
npm start
```

Then open http://localhost:3000, describe a site, and start tuning it.

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

- `ANTHROPIC_API_KEY` (required) — your Anthropic key.
- `PORT` (optional, default `3000`).
- `MODEL` (optional, default `claude-sonnet-4-6`) — the Claude model the agent
  uses. Sonnet is a good speed/quality balance for this; you can point it at a
  more capable model if you want richer output.

## Notes on what's NOT included (on purpose, for a learning project)

- **No database.** Conversations and generated sites aren't saved — refresh the
  page and it's gone. Add persistence (SQLite/Postgres) if you want people to
  come back to past sites.
- **No auth/accounts.** Anyone who can reach the server can use your API
  credits. There's a tiny in-memory rate limiter (20 requests/minute per IP) in
  `server.js` to take the edge off while testing locally, but it resets on
  restart and won't hold up under real traffic.
- **No deployment config.** This runs locally. To put it online, deploy the
  Node app (Render, Railway, Fly.io, a VPS, etc.) and set `ANTHROPIC_API_KEY`
  as an environment variable there — never commit your real key or ship it to
  the browser.

## Where to go next

- **Streaming**: use `anthropic.messages.stream()` so the page appears
  progressively instead of after one long wait.
- **Real tool use**: give the agent tools (e.g. `validate_html`,
  `fetch_stock_photo`) so it can act over multiple steps before replying.
- **Per-section editing**: let users click a section in the preview and tune
  just that part.
- **Persistence + accounts**: save each conversation so sites can be reopened
  and kept editing later.
