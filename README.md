# Vavina Learners Backend v4 — Gemini + Cloudinary

Single Node.js/Express server. AI runs on **Google Gemini with an automatic model waterfall**; Cloudinary stores media.

## Storage Architecture

```
Firebase Firestore  → all metadata (user data, video records, notes)
Cloudinary          → all media (videos + thumbnails)
```

## Cloudinary Account

- Upload presets:
  - vavina_videos      (Unsigned, folder: vavina/videos)
  - vavina_thumbnails  (Unsigned, folder: vavina/thumbnails)

## File Structure

```
backend/
├── index.js
├── package.json
├── .env.example
├── ai/
│   └── geminiClient.js          # Gemini waterfall (models × keys, cooldowns)
├── middleware/
│   ├── firebase.js              # Firebase Admin + verifyToken
│   └── rateLimit.js             # per-user limiter
├── test/geminiClient.test.js    # npm test
├── notes/
│   ├── notes.routes.js          # POST /api/notes/generate-note
│   ├── notesPrompt.js
│   └── notesStore.js
├── news/
│   ├── news.routes.js           # GET /api/news/daily-tech-news
│   └── newsService.js           # NewsAPI + 6h cache
├── video/
│   ├── video.routes.js          # All /api/video/* endpoints
│   ├── videoWorker.js           # Spawns Python, reads stdout
│   └── cloudinaryHelper.js      # Cloudinary DELETE + URL builders
└── python_pipeline/
    └── run_generation.py        # Full pipeline → uploads to Cloudinary
```

## All Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | none | Services status |
| POST | `/api/notes/generate-note` | 🔒 Firebase | AI notes (body: `topic`, `noteId?`, `previousTopic?`) |
| GET | `/api/news/daily-tech-news` | none | Tech news |
| POST | `/api/video/generate` | 🔒 Firebase | Start generation |
| GET | `/api/video/my-videos` | 🔒 Firebase | List videos |
| GET | `/api/video/:id` | 🔒 Firebase | Single video |
| GET | `/api/video/:id/status` | 🔒 Firebase | Poll progress |
| GET | `/api/video/:id/stream` | 🔒 Firebase | SSE stream |
| DELETE | `/api/video/:id` | 🔒 Firebase | Delete video |

## AI waterfall

Models are tried best → lightest; every API key is tried on each model.
A model/key that hits a rate limit, is overloaded, missing, or invalid is put on a
cooldown and skipped on the next request, so users never wait on a known-bad option.

`gemini-3.8-flash → 3.6-flash → 3.5-flash-lite → 3.1-flash-lite → 3-flash-preview → 2.5-flash → 2.5-flash-lite`

* Free-tier limits are **per Google Cloud project, per model** — a waterfall already
  multiplies capacity, and keys from *different projects* multiply it again.
* Override the chain with `GEMINI_MODELS`. Paid-only models (e.g. `gemini-4-argon`)
  can be put first if billing is enabled.
* `GET /health` shows which models are currently available (never exposes keys).

## Environment Variables

| Key | Value |
|-----|-------|
| GEMINI_API_KEYS | one or more Gemini keys, comma separated (aistudio.google.com/apikey) |
| NEWS_API_KEY | newsapi.org key |
| CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET | exact names, no spaces |
| FIREBASE_CRED_JSON | one-line service account JSON |
| MAX_CONCURRENT_VIDEO_JOBS | optional, default 2 |

The old `NOTES_MAKER_API` / `GROQ_API_KEY` are no longer needed (Groq keys `gsk_…` are ignored).

## Run Locally

```bash
npm install

# Python deps
pip3 install cloudinary firebase-admin edge-tts opencv-python-headless numpy python-dotenv

# System deps (Linux)
sudo apt-get install -y ffmpeg espeak-ng fonts-dejavu

# macOS
brew install ffmpeg

cp .env.example .env
# Edit .env — fill in CLOUDINARY_API_SECRET and FIREBASE_CRED_JSON

npm run dev
```

## Deploy on Render

Build command:
```
npm install && pip3 install cloudinary firebase-admin edge-tts opencv-python-headless numpy python-dotenv && apt-get install -y ffmpeg espeak-ng fonts-dejavu 2>/dev/null || true
```

Start command: `npm start`

Env vars to add in Render dashboard:
1. GEMINI_API_KEYS
2. NEWS_API_KEY
3. CLOUDINARY_CLOUD_NAME
4. CLOUDINARY_API_KEY
5. CLOUDINARY_API_SECRET
6. FIREBASE_CRED_JSON
