# Deploy the Vavina backend on Render — step by step

After this, **every AI feature (tutor, roadmap, career guide, notes, quiz generator, video) goes through this one server.**
Your Gemini keys live only here. The Flutter app contains no AI keys.

> Why Docker? Video generation needs `ffmpeg`, Python and some system libraries. Render's plain "Node"
> runtime cannot install those (`apt-get` is not allowed), so videos would fail. The included `Dockerfile` installs everything.

---

## Step 1 — Put the right files in your GitHub repo

Your backend repo root must look like this:

```
index.js            Dockerfile          render.yaml
package.json        package-lock.json   .dockerignore
ai/  middleware/  notes/  news/  video/  python_pipeline/
vavina_learner_video_generator/     <-- copy your Python video folder INTO the repo (new)
```

* Copy the **`vavina_learner_video_generator`** folder into the repo root (it used to sit next to the backend).
* Never commit `.env` (it's in `.gitignore`).
* Commit and push to GitHub.

## Step 2 — Collect your keys (keep them handy)

| Variable | Where to get it |
|---|---|
| `GEMINI_API_KEYS` | https://aistudio.google.com/apikey — create 2–3 keys, **each in a different Google Cloud project** (limits are per project). Join them with commas: `AIza...,AIza...` |
| `NEWS_API_KEY` | newsapi.org |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Cloudinary dashboard → *Settings → API Keys*. Names must be exactly these (no spaces). |
| `FIREBASE_CRED_JSON` | Firebase console → *Project settings → Service accounts → Generate new private key*. Open the JSON, remove line breaks so it is **one line**, paste the whole thing. |

**Cloudinary one-time setup:** *Settings → Upload → Upload presets* → create two presets named exactly
`vavina_videos` and `vavina_thumbnails`. (The Python code uploads with these names.)

## Step 3 — Create the service on Render

> If you already have a service with this name running as **Node**, you can't switch it to Docker.
> Delete the old one (or rename it) first, then create the new one below so you can reuse the same URL
> `https://vap-learners-backend.onrender.com` that the app already points to.

1. Render dashboard → **New +** → **Web Service** → connect your GitHub repo.
2. Fill in:
   * **Name:** `vap-learners-backend`  (this becomes the URL)
   * **Language / Runtime:** **Docker** (Render detects the `Dockerfile`)
   * **Branch:** `main`
   * **Region:** closest to your users (e.g. Singapore for India)
   * **Instance Type:** Free to test. For real use choose **Starter ($7)** — see "Free tier limits" below.
3. Expand **Advanced**:
   * **Health Check Path:** `/ping`
   * **Auto-Deploy:** Yes
4. **Environment Variables** → add every row from Step 2, plus:
   * `MAX_CONCURRENT_VIDEO_JOBS` = `1`   (free instance has 512 MB RAM; one render at a time is safe)
5. Click **Create Web Service**. The first build takes ~5–10 minutes (it installs ffmpeg + Python packages).

*(Shortcut: **New + → Blueprint** reads `render.yaml` and pre-creates all of this; you then just paste the secret values.)*

## Step 4 — Check that it works

Open these in a browser (replace the host if your service has a different name):

1. `https://vap-learners-backend.onrender.com/ping` → `{"status":"ok", ...}`
2. `https://vap-learners-backend.onrender.com/health` → you should see:
   * `"ai": true`, `"notes": true`, `"video": true`, `"firebase": true`
   * `ai.models` listing 7 models, each with `availableKeys` ≥ 1

Anything `false` = that env var is missing or misspelled (check **Environment** tab and the **Logs** tab; the server prints a ✓/✗ list at startup).

## Step 5 — Flutter app

1. Remove old AI keys from the app's `.env` (`AI_TUTOR_API`, `ROADMAP_GENERATOR_API`, `CARRIER_API`, `Quiz_API`, any `GEMINI_*`) — they're no longer used.
2. Only if your Render URL is **not** `https://vap-learners-backend.onrender.com`, add to the app `.env`:
   `BACKEND_URL=https://your-service-name.onrender.com`
3. `flutter clean && flutter pub get && flutter run`

## Free tier limits (important)

* The free instance **sleeps after ~15 min idle** and takes ~40 s to wake. The app pings the server when it opens
  and retries automatically, but the very first AI answer after a long break can still be slow.
  Options: upgrade to Starter (always on), or ping `/ping` every 5 min with a free monitor like UptimeRobot.
* **512 MB RAM** — enough for notes/AI, tight for video rendering. If videos fail with "exited (code 137)" in Logs, it ran out of memory → use Starter or bigger.
* The disk is temporary — fine, because videos are uploaded to Cloudinary and deleted locally.

## Troubleshooting

| Symptom | Fix |
|---|---|
| App says "AI is not configured on the server yet" | `GEMINI_API_KEYS` missing/empty on Render. |
| `/health` shows `"ai": true` but app says "busy" | All models/keys are rate-limited. Add keys from more Google projects. `/health` shows each model's cooldown. |
| App says "session expired" | `FIREBASE_CRED_JSON` wrong (not one line / wrong project). Check Logs for "Firebase Admin init failed". |
| Video says "Video engine file 'utils' is missing" (or `No module named 'utils'`) | The `vavina_learner_video_generator/` folder (with `utils/ script/ engine/ tts/ video/` inside) is not in the deployed repo. Copy it into the backend repo root, commit, push. `/health` shows `"videoEngine": true` when it's found. |
| Video says "Python package 'xyz' is not installed" | Add `xyz` to `vavina_learner_video_generator/requirements.txt` and redeploy. |
| Video fails immediately | `"video": false` in `/health` → Cloudinary vars missing. Or the `vavina_learner_video_generator` folder isn't in the repo. |
| Video fails with exit 137 | Out of memory → bigger instance. |
| Build fails at `pip install` | Your video folder needs extra Python packages → add a `requirements.txt` inside `vavina_learner_video_generator/`; the Dockerfile installs it automatically. |
| Logs show `ModuleNotFoundError` | Same as above — add the missing package to that `requirements.txt`. |
