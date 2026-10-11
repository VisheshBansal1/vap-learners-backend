# Vavina Learners Backend v3 — Cloudinary Edition

Single Node.js/Express server with Cloudinary for all media storage.

## Storage Architecture

```
Firebase Firestore  → all metadata (user data, video records, notes)
Cloudinary          → all media (videos + thumbnails)
```

## Cloudinary Account

- Cloud name  : wzflnd0t
- Upload presets:
  - vavina_videos      (Unsigned, folder: vavina/videos)
  - vavina_thumbnails  (Unsigned, folder: vavina/thumbnails)

## File Structure

```
backend/
├── index.js
├── package.json
├── .env.example
├── middleware/
│   └── firebase.js              # Firebase Admin + verifyToken
├── notes/
│   ├── notes.routes.js          # POST /api/notes/generate-note
│   ├── groqClient.js            # Groq llama-3.3-70b-versatile
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
| POST | `/api/notes/generate-note` | none | AI notes |
| GET | `/api/news/daily-tech-news` | none | Tech news |
| POST | `/api/video/generate` | 🔒 Firebase | Start generation |
| GET | `/api/video/my-videos` | 🔒 Firebase | List videos |
| GET | `/api/video/:id` | 🔒 Firebase | Single video |
| GET | `/api/video/:id/status` | 🔒 Firebase | Poll progress |
| GET | `/api/video/:id/stream` | 🔒 Firebase | SSE stream |
| DELETE | `/api/video/:id` | 🔒 Firebase | Delete video |

## Environment Variables

| Key | Value |
|-----|-------|
| NOTES_MAKER_API | Groq key |
| GROQ_API_KEY | Groq key (for Python pipeline) |
| NEWS_API_KEY | newsapi.org key |
| CLOUDINARY_CLOUD_NAME | wzflnd0t |
| CLOUDINARY_API_KEY | 939355222738251 |
| CLOUDINARY_API_SECRET | your full secret |
| FIREBASE_CRED_JSON | one-line service account JSON |

## Run Locally

```bash
npm install

# Python deps
pip3 install cloudinary firebase-admin groq edge-tts opencv-python-headless numpy python-dotenv

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
npm install && pip3 install cloudinary firebase-admin groq edge-tts opencv-python-headless numpy python-dotenv && apt-get install -y ffmpeg espeak-ng fonts-dejavu 2>/dev/null || true
```

Start command: `npm start`

Env vars to add in Render dashboard (6 total):
1. NOTES_MAKER_API
2. GROQ_API_KEY
3. NEWS_API_KEY
4. CLOUDINARY_CLOUD_NAME
5. CLOUDINARY_API_KEY
6. CLOUDINARY_API_SECRET
7. FIREBASE_CRED_JSON
