/**
 * video/videoWorker.js
 * ────────────────────
 * Spawns the Python video-generation pipeline as a child process.
 * Node.js reads JSON progress lines from Python's stdout and
 * fans them out to SSE subscribers in real-time.
 *
 * Folder layout expected on disk:
 *   project_root/
 *     backend/                               ← this Node.js server
 *       video/videoWorker.js                 ← this file
 *       python_pipeline/run_generation.py    ← Python bridge
 *     vavina_learner_video_generator/        ← Python pipeline (sibling)
 */

import { spawn }            from "child_process";
import path                 from "path";
import { fileURLToPath }    from "url";
import { getDb }            from "../middleware/firebase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Job registry ──────────────────────────────────────────────────────────────
// { videoId → { status, progress, message, events[], subscribers[] } }
const _jobs = new Map();

export function getJobState(videoId) {
  return _jobs.get(videoId) ?? null;
}

export function clearJob(videoId) {
  _jobs.delete(videoId);
}

// ── SSE subscriber pattern ────────────────────────────────────────────────────
export function subscribeJob(videoId, callback) {
  if (!_jobs.has(videoId)) {
    _jobs.set(videoId, {
      status: "processing", progress: 0,
      message: "", events: [], subscribers: [],
    });
  }
  const job = _jobs.get(videoId);

  // Replay buffered events to new subscriber (handles late connection)
  job.events.forEach((e) => callback(e));

  if (job.status === "completed" || job.status === "failed") return () => {};

  job.subscribers.push(callback);
  return () => {
    job.subscribers = job.subscribers.filter((s) => s !== callback);
  };
}

function _publish(videoId, event) {
  const job = _jobs.get(videoId);
  if (!job) return;
  job.status   = event.status;
  job.progress = event.progress;
  job.message  = event.message;
  job.events.push(event);
  job.subscribers.forEach((s) => { try { s(event); } catch (_) {} });
}

// ── Firestore update helper ───────────────────────────────────────────────────
async function _updateFirestore(uid, videoId, fields) {
  try {
    await getDb()
      .collection("users").doc(uid)
      .collection("videos").doc(videoId)
      .update(fields);
  } catch (e) {
    console.error(`[${videoId.slice(0, 8)}] Firestore update failed:`, e.message);
  }
}

// ── Spawn ─────────────────────────────────────────────────────────────────────
export function spawnVideoJob({ videoId, uid, topic, difficulty, voice }) {
  _jobs.set(videoId, {
    status: "processing", progress: 2,
    message: "Starting generation…",
    events: [], subscribers: [],
  });

  const scriptPath = path.join(__dirname, "..", "python_pipeline", "run_generation.py");

  const child = spawn("python3", [scriptPath], {
    env: {
      ...process.env,
      VIDEO_ID:   videoId,
      USER_ID:    uid,
      TOPIC:      topic,
      DIFFICULTY: difficulty,
      VOICE:      voice,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";

  // ── stdout → JSON progress events ─────────────────────────────────────────
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        const safe  = {
          status:       event.status       ?? "processing",
          progress:     event.progress     ?? 0,
          message:      event.message      ?? "",
          videoUrl:     event.videoUrl,
          thumbnailUrl: event.thumbnailUrl,
          error:        event.error,
        };
        _publish(videoId, safe);

        if (safe.status === "completed" && safe.videoUrl) {
          _updateFirestore(uid, videoId, {
            status:       "completed",
            videoUrl:     safe.videoUrl,
            thumbnailUrl: safe.thumbnailUrl ?? "",
            duration:     event.duration    ?? 0,
            fileSize:     event.fileSize    ?? 0,
          });
        }
        if (safe.status === "failed") {
          _updateFirestore(uid, videoId, { status: "failed" });
        }
      } catch (_) {
        // Non-JSON stdout line (debug prints etc.) — just log
        console.log(`[py:${videoId.slice(0, 8)}]`, trimmed);
      }
    }
  });

  // ── stderr → log only ──────────────────────────────────────────────────────
  child.stderr.on("data", (chunk) => {
    console.error(`[py:${videoId.slice(0, 8)}] STDERR:`, chunk.toString().trim());
  });

  // ── Exit ───────────────────────────────────────────────────────────────────
  child.on("close", (code) => {
    const job = _jobs.get(videoId);
    if (!job) return;
    if (job.status !== "completed") {
      const errEvent = {
        status: "failed", progress: 0,
        message: `Python exited with code ${code}`,
        error:   `Exit code ${code}`,
      };
      _publish(videoId, errEvent);
      _updateFirestore(uid, videoId, { status: "failed" });
    }
    console.log(`[${videoId.slice(0, 8)}] Python process exited (code ${code})`);
  });

  child.on("error", (err) => {
    console.error(`[${videoId.slice(0, 8)}] Failed to spawn Python:`, err.message);
    const errEvent = {
      status: "failed", progress: 0,
      message: "Failed to start video generation process",
      error:   err.message,
    };
    _publish(videoId, errEvent);
    _updateFirestore(uid, videoId, { status: "failed" });
  });

  console.log(`[${videoId.slice(0, 8)}] Python pipeline spawned for: ${topic}`);
}
