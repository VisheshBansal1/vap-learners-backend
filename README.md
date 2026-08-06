# Learnify Backend

Single Node.js/Express service combining the two previously-separate backends:

| Feature            | Used to live in         | Language (before) |
|---------------------|--------------------------|--------------------|
| AI notes generation | `choose_carrier_backend` | Node.js / Express  |
| Daily tech news      | `news_backend`           | Python / FastAPI   |

Both now run as one Express app, on one port, one deployment.

## Structure

```
learnify-backend/
├── index.js              # App entry point — mounts both feature routers
├── notes/
│   ├── notes.routes.js   # POST /api/notes/generate-note
│   ├── groqClient.js     # Groq API client
│   ├── notesPrompt.js    # Prompt builder (continuity logic)
│   └── notesStore.js     # In-memory notes storage
└── news/
    ├── news.routes.js    # GET /api/news/daily-tech-news
    └── newsService.js    # NewsAPI fetch + keyword filter + cache
```

## Endpoints

| Method | Path                        | Old path (now retired)                                  |
|--------|------------------------------|-----------------------------------------------------------|
| GET    | `/`                          | health check                                               |
| GET    | `/ping`                      | health check                                               |
| POST   | `/api/notes/generate-note`   | `POST /generate-note` on the old notes backend             |
| GET    | `/api/news/daily-tech-news`  | `GET /daily-tech-news` on the old news backend              |

Request/response bodies are unchanged from the originals — only the base URL and path moved (now namespaced under `/api/notes` and `/api/news` so the two features can't collide as more get added).

## Environment variables

Copy `.env.example` to `.env` and fill in:

- `NOTES_MAKER_API` — Groq API key (same one the old `choose_carrier_backend` used)
- `NEWS_API_KEY` — NewsAPI.org key (same one the old `news_backend` used)
- `PORT` — optional locally; Render sets this for you

## Run locally

```bash
npm install
npm run dev      # nodemon, auto-restart
# or
npm start
```

## Deploy (Render, free tier)

1. Push this folder as the root of a repo (or a `backend/` subfolder — set Render's **Root Directory** accordingly).
2. Build command: `npm install`
3. Start command: `npm start`
4. Add the two environment variables above in Render's dashboard.
5. Easiest path: redeploy this to your **existing** `vap-learners-backend` Render service (just add `NEWS_API_KEY` to its env vars) — then you can delete the separate `vap-learners-news-backend` service. The Flutter app has been pointed at `vap-learners-backend`'s URL for both features (see below). If you'd rather deploy to a brand-new URL, just update the one constant in the Flutter app noted below.

## What changed on the notes side

Nothing behaviorally — same Groq model, same prompt/continuity logic, same in-memory store (resets on restart, same as before).

## What changed on the news side

Ported from Python to JavaScript with identical logic (same NewsAPI query, same domain allowlist, same keyword filter, same response shape). The only internal difference: the 6-hour cache is now held in memory instead of a `tech_news_cache.json` file — behaviorally equivalent on Render's free tier, since disk there is just as ephemeral as memory across restarts/redeploys.
