/**
 * video/videoWorker.js
 * ────────────────────
 * Spawns the Python video-generation pipeline as a child process.
 * Node reads JSON progress lines from Python's stdout and fans them out to
 * SSE subscribers in real time.
 *
 * Changes vs. the first version
 *   • finished jobs are evicted after 15 min (the registry used to grow forever)
 *   • a hard timeout kills a stuck Python process (default 25 min)
 *   • "failed" is published exactly once (it used to be sent twice)
 *   • per-user + global concurrency slots (a small instance can't run many renders)
 *   • deleting a video while it renders now kills the process (no orphan uploads)
 *   • error text is truncated and scrubbed of anything that looks like an API key
 *   • subscribing to an unknown job no longer creates a phantom "processing" job
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "../middleware/firebase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JOB_TIMEOUT_MS = Number(process.env.VIDEO_JOB_TIMEOUT_MS) || 25 * 60_000;
const JOB_RETAIN_MS = 15 * 60_000;
const MAX_STDOUT_BUFFER = 1_000_000;
export const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_VIDEO_JOBS) || 2);
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

const _jobs = new Map(); // videoId → job
const _reserved = new Set(); // uids with a start request in flight (double-tap guard)

const isTerminal = (s) => s === "completed" || s === "failed";

/** Remove anything that looks like a secret and keep messages short. */
export function sanitizeError(msg) {
  return String(msg ?? "")
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, "[key]")
    .replace(/gsk_[0-9A-Za-z]{10,}/g, "[key]")
    .replace(/(api[_-]?key|secret|token)=\S+/gi, "$1=[hidden]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

// ── Registry accessors ───────────────────────────────────────────────────────

export function getJobState(videoId) {
  const j = _jobs.get(videoId);
  if (!j) return null;
  const { status, progress, message, error, videoUrl, thumbnailUrl, topic } = j;
  return { status, progress, message, error, videoUrl, thumbnailUrl, topic };
}

export function activeJobCount() {
  let n = _reserved.size;
  for (const j of _jobs.values()) if (!isTerminal(j.status)) n++;
  return n;
}

export function userHasActiveJob(uid) {
  if (_reserved.has(uid)) return true;
  for (const j of _jobs.values()) if (j.uid === uid && !isTerminal(j.status)) return true;
  return false;
}

/** Synchronously claim the user's single generation slot. */
export function tryReserve(uid) {
  if (userHasActiveJob(uid)) return false;
  _reserved.add(uid);
  return true;
}
export function release(uid) {
  _reserved.delete(uid);
}

// ── Subscribe (SSE) ──────────────────────────────────────────────────────────

/**
 * @returns {{unsubscribe:()=>void, done:boolean} | null}  null → no such job in memory.
 * The newest event is replayed immediately (progress only moves forward, so a
 * reconnecting client doesn't need the whole history).
 */
export function subscribeJob(videoId, callback) {
  const job = _jobs.get(videoId);
  if (!job) return null;

  const last = job.events.at(-1);
  if (last) {
    try { callback(last); } catch (_) { /* subscriber went away */ }
  }
  if (isTerminal(job.status)) return { unsubscribe: () => {}, done: true };

  job.subscribers.add(callback);
  return { unsubscribe: () => job.subscribers.delete(callback), done: false };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function publish(job, event) {
  if (isTerminal(job.status)) return; // exactly one terminal event
  job.status = event.status;
  job.progress = event.progress;
  job.message = event.message;
  if (event.error) job.error = event.error;
  if (event.videoUrl) job.videoUrl = event.videoUrl;
  if (event.thumbnailUrl) job.thumbnailUrl = event.thumbnailUrl;
  if (event.topic) job.topic = event.topic;

  job.events.push(event);
  if (job.events.length > 50) job.events.splice(0, job.events.length - 50);
  for (const s of [...job.subscribers]) {
    try { s(event); } catch (_) { job.subscribers.delete(s); }
  }

  if (isTerminal(job.status)) {
    clearTimeout(job.timer);
    job.subscribers.clear();
    const evict = setTimeout(() => _jobs.delete(job.videoId), JOB_RETAIN_MS);
    evict.unref?.();
  }
}

async function updateFirestore(uid, videoId, fields) {
  try {
    await getDb().collection("users").doc(uid).collection("videos").doc(videoId).update(fields);
  } catch (e) {
    // Doc deleted mid-render, or a Firestore blip — never crash the worker.
    console.error(`[${videoId.slice(0, 8)}] Firestore update failed:`, e.message);
  }
}

function fail(job, message, detail) {
  if (isTerminal(job.status)) return;
  const error = sanitizeError(detail || message);
  publish(job, { status: "failed", progress: 0, message, error });
  updateFirestore(job.uid, job.videoId, { status: "failed", errorMessage: error });
}

// ── Cancel / clear ───────────────────────────────────────────────────────────

/** Stop a running render (used when the user deletes a video that is still processing). */
export function cancelJob(videoId) {
  const job = _jobs.get(videoId);
  if (!job) return;
  clearTimeout(job.timer);
  if (job.child && !job.child.killed && !isTerminal(job.status)) {
    job.cancelled = true;
    job.child.kill("SIGTERM");
    setTimeout(() => job.child.kill("SIGKILL"), 5000).unref?.();
  }
  job.subscribers.clear();
  _jobs.delete(videoId);
}
export const clearJob = cancelJob;

// ── Spawn ────────────────────────────────────────────────────────────────────

export function spawnVideoJob({ videoId, uid, topic, difficulty, voice }) {
  const job = {
    videoId, uid, topic,
    status: "processing", progress: 2, message: "Starting generation…",
    events: [], subscribers: new Set(),
    child: null, timer: null, cancelled: false,
    startedAt: Date.now(),
  };
  _jobs.set(videoId, job);
  release(uid); // the job itself now holds the slot

  const scriptPath = path.join(__dirname, "..", "python_pipeline", "run_generation.py");
  const tag = videoId.slice(0, 8);

  const child = spawn(PYTHON_BIN, [scriptPath], {
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      VIDEO_ID: videoId,
      USER_ID: uid,
      TOPIC: topic,
      DIFFICULTY: difficulty,
      VOICE: voice,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;

  job.timer = setTimeout(() => {
    console.error(`[${tag}] timed out after ${Math.round(JOB_TIMEOUT_MS / 60000)} min — killing`);
    fail(job, "Video generation took too long. Please try again.", "timeout");
    child.kill("SIGKILL");
  }, JOB_TIMEOUT_MS);
  job.timer.unref?.();

  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    if (buffer.length > MAX_STDOUT_BUFFER && !buffer.includes("\n")) buffer = "";
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (_) {
        console.log(`[py:${tag}]`, trimmed.slice(0, 300));
        continue;
      }
      if (!event || typeof event !== "object") continue;

      const safe = {
        status: event.status ?? "processing",
        progress: Math.max(0, Math.min(100, Math.round(Number(event.progress) || 0))),
        message: String(event.message ?? "").slice(0, 200),
        videoUrl: event.videoUrl,
        thumbnailUrl: event.thumbnailUrl,
        topic: event.topic,
        error: event.error ? sanitizeError(event.error) : undefined,
      };

      if (safe.status === "failed") {
        fail(job, safe.message || "Video generation failed", safe.error);
      } else if (safe.status === "completed" && safe.videoUrl) {
        publish(job, safe);
        updateFirestore(uid, videoId, {
          status: "completed",
          videoUrl: safe.videoUrl,
          thumbnailUrl: safe.thumbnailUrl ?? "",
          duration: event.duration ?? 0,
          fileSize: event.fileSize ?? 0,
        });
      } else {
        publish(job, { ...safe, status: "processing" });
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    console.error(`[py:${tag}] STDERR:`, sanitizeError(chunk.toString()));
  });

  child.on("close", (code) => {
    clearTimeout(job.timer);
    console.log(`[${tag}] Python process exited (code ${code})`);
    if (job.cancelled) return;
    if (!isTerminal(job.status)) {
      fail(job, "Video generation failed. Please try again.", `Exit code ${code}`);
    }
  });

  child.on("error", (err) => {
    console.error(`[${tag}] Failed to spawn Python (${PYTHON_BIN}):`, err.message);
    fail(job, "Failed to start video generation process", err.message);
  });

  console.log(`[${tag}] Python pipeline spawned for: ${topic}`);
}
