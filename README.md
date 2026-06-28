# AI Site Builder

A small full-stack app where a person describes a website in plain English,
and a Claude-powered "agent" generates a real, complete HTML page — shown in
a live preview, with a button to download the file.

## How it works

1. **Frontend** (`public/`) — a textarea + button. When you click Generate,
   it `fetch()`s `/api/generate` with your description.
2. **Backend** (`server.js`) — an Express server with one route,
   `POST /api/generate`. It takes your prompt, sends it to the Claude API
   with a system prompt instructing it to return ONE self-contained HTML
   file (inline CSS/JS, no external dependencies needed to run), and sends
   that HTML back to the frontend.
3. **Preview** — the returned HTML is loaded into an `<iframe srcdoc>`,
   which sandboxes it from the rest of your app.
4. **Download** — the same HTML string is wrapped in a `Blob` and
   downloaded client-side as `my-website.html`. No extra backend work.

This is the "AI agent" pattern in its simplest form: one call out to a
model with a tightly-scoped system prompt, no tool use or multi-step
planning. That's enough for "describe a site, get a site." If you want it
to feel more like an agent that reasons over multiple steps, see
"Where to go next" below.

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

Then open http://localhost:3000

## Project structure

```
ai-site-builder/
├── server.js           # Express server + Claude API call
├── package.json
├── .env.example         # copy to .env and add your key
└── public/
    ├── index.html       # the page itself
    ├── styles.css
    └── app.js           # fetch logic, preview, download
```

## Notes on what's NOT included (on purpose, for a learning project)

- **No database.** Generated sites aren't saved anywhere — refresh the page
  and it's gone. Add one (e.g. SQLite or Postgres) if you want users to
  come back to past generations.
- **No auth/accounts.** Anyone who can reach the server can generate sites
  and burn your API credits. There's a very basic in-memory rate limiter
  (8 requests/minute per IP) in `server.js` to take the edge off this while
  you're testing locally, but it resets if the server restarts and won't
  hold up with real traffic.
- **No deployment config.** This runs locally. To put it online you'd
  deploy the Node app (Render, Railway, Fly.io, a VPS, etc.) and set
  `ANTHROPIC_API_KEY` as an environment variable there — never commit your
  real key or ship it to the browser.

## Where to go next

- **Streaming**: use `anthropic.messages.stream()` so the HTML appears
  progressively instead of all at once after a long wait.
- **Multi-turn editing**: let the user say "make the header darker" as a
  follow-up, by sending the previous HTML + new instruction back to Claude.
- **Real agent loop**: give Claude tools (e.g. "validate_html",
  "fetch_unsplash_image") and let it call them before returning a final
  answer — this is what turns "one API call" into an actual agent.
- **Persistence**: save generations to a database keyed by a user account,
  so people can come back and edit old sites.
