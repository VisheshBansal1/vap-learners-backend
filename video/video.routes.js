/**
 * video/video.routes.js
 * All routes under /api/video — Firebase token required on every request.
 *
 * POST   /api/video/generate
 * GET    /api/video/my-videos
 * GET    /api/video/:videoId
 * GET    /api/video/:videoId/status
 * GET    /api/video/:videoId/stream   (SSE)
 * DELETE /api/video/:videoId
 */

import express from "express";
import { v4 as uuidv4 } from "uuid";
import { verifyToken, getDb } from "../middleware/firebase.js";
import {
  spawnVideoJob, getJobState, subscribeJob, cancelJob,
  tryReserve, release, activeJobCount, MAX_CONCURRENT,
} from "./videoWorker.js";
import { cloudinaryDelete, videoPublicId, thumbPublicId } from "./cloudinaryHelper.js";

const router = express.Router();
router.use(verifyToken);

const FREE_LIMIT = 5;
const DIFFICULTIES = ["beginner", "intermediate", "advanced"];
const VOICES = ["english", "hindi"];
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const videosCol = (uid) => getDb().collection("users").doc(uid).collection("videos");
const videoDoc = (uid, videoId) => videosCol(uid).doc(videoId);

function tsToIso(val) {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate().toISOString();
  return val;
}

function createdMs(d) {
  const v = d.data().createdAt;
  return typeof v?.toMillis === "function" ? v.toMillis() : new Date(v || 0).getTime();
}

/**
 * Free plan keeps at most FREE_LIMIT videos. Make room by removing a FAILED
 * video first (it's useless), otherwise the oldest finished one. Never touches
 * a video that is still rendering. The server is the only place that rotates —
 * the app used to delete the Firestore record itself first, which left the
 * Cloudinary files orphaned.
 */
async function freeTierRotate(uid) {
  const snap = await videosCol(uid).limit(50).get();
  if (snap.size < FREE_LIMIT) return;

  const docs = snap.docs.filter((d) => !getJobState(d.id) || getJobState(d.id).status !== "processing");
  if (!docs.length) return;
  const failed = docs.filter((d) => d.data().status === "failed").sort((a, b) => createdMs(a) - createdMs(b));
  const victim = failed[0] ?? docs.sort((a, b) => createdMs(a) - createdMs(b))[0];

  const id = victim.data().videoId || victim.id;
  await cloudinaryDelete(videoPublicId(uid, id), "video");
  await cloudinaryDelete(thumbPublicId(uid, id), "image");
  await victim.ref.delete();
  console.log(`[free-tier] rotated out ${id} for user ${uid}`);
}

/** Build a progress event from the persisted record (used when no live job exists). */
async function eventFromDoc(uid, videoId, data) {
  if (data.status === "completed") {
    return {
      status: "completed", progress: 100, message: "Video ready",
      videoUrl: data.videoUrl, thumbnailUrl: data.thumbnailUrl, topic: data.topic,
    };
  }
  if (data.status === "failed") {
    return {
      status: "failed", progress: 0, message: "Generation failed",
      error: data.errorMessage || "Generation failed. Please try again.",
    };
  }
  // "processing" in Firestore but no live job here → the server restarted mid-render.
  const error = "The server restarted while your video was being created. Please try again.";
  await videoDoc(uid, videoId).update({ status: "failed", errorMessage: error }).catch(() => {});
  return { status: "failed", progress: 0, message: "Generation failed", error };
}

/* ── POST /api/video/generate ── */
router.post("/generate", wrap(async (req, res) => {
  const uid = req.uid;
  const topic = String(req.body?.topic ?? "").replace(/\s+/g, " ").trim();
  const difficulty = DIFFICULTIES.includes(req.body?.difficulty) ? req.body.difficulty : "intermediate";
  const voice = VOICES.includes(req.body?.voice) ? req.body.voice : "english";

  if (topic.length < 3) return res.status(400).json({ error: "Please enter a topic (at least 3 characters)." });
  if (topic.length > 200) return res.status(400).json({ error: "Topic is too long (max 200 characters)." });

  if (activeJobCount() >= MAX_CONCURRENT) {
    return res.status(429).json({ error: "The server is busy creating other videos. Please try again in a few minutes." });
  }
  if (!tryReserve(uid)) {
    return res.status(409).json({ error: "You already have a video being created. Please wait for it to finish." });
  }

  try {
    const userSnap = await getDb().collection("users").doc(uid).get();
    const isPremium = userSnap.data()?.isPremium === true;
    if (!isPremium) await freeTierRotate(uid);

    const videoId = uuidv4();
    await videoDoc(uid, videoId).set({
      videoId, userId: uid,
      title: `Tutorial: ${topic}`, topic,
      videoUrl: "", thumbnailUrl: "", duration: 0, fileSize: 0,
      createdAt: new Date(), status: "processing", isPremium,
    });

    spawnVideoJob({ videoId, uid, topic, difficulty, voice }); // releases the reservation
    return res.status(200).json({ videoId, message: "Generation started" });
  } catch (e) {
    release(uid);
    console.error("❌ /generate error:", e.message);
    return res.status(500).json({ error: "Could not start video generation." });
  }
}));

/* ── GET /api/video/my-videos ── */
router.get("/my-videos", wrap(async (req, res) => {
  const snap = await videosCol(req.uid).orderBy("createdAt", "desc").limit(100).get();
  return res.status(200).json(
    snap.docs.map((d) => ({ ...d.data(), createdAt: tsToIso(d.data().createdAt) }))
  );
}));

/* ── GET /api/video/:videoId/status ── */
router.get("/:videoId/status", wrap(async (req, res) => {
  const { videoId } = req.params;
  const doc = await videoDoc(req.uid, videoId).get();
  if (!doc.exists) return res.status(404).json({ error: "Video not found" });

  const job = getJobState(videoId);
  if (job) return res.status(200).json({ ...job, progress: job.progress ?? 0, message: job.message ?? "" });
  return res.status(200).json(await eventFromDoc(req.uid, videoId, doc.data()));
}));

/* ── GET /api/video/:videoId/stream (SSE) ── */
router.get("/:videoId/stream", wrap(async (req, res) => {
  const { videoId } = req.params;
  const doc = await videoDoc(req.uid, videoId).get();
  if (!doc.exists) return res.status(404).json({ error: "Video not found" });

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };

  // No live job (finished earlier, or server restarted): answer from the record and close.
  if (!getJobState(videoId)) {
    send(await eventFromDoc(req.uid, videoId, doc.data()));
    return res.end();
  }

  // Declared BEFORE subscribing: the first event is replayed synchronously and may
  // already be terminal — the old code touched `unsub` before it existed and crashed.
  let unsubscribe = () => {};
  let keepAlive = null;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  res.on("close", finish); // res, not req: req "close" fires when the request body is read, not on disconnect

  const sub = subscribeJob(videoId, (event) => {
    send(event);
    if (event.status === "completed" || event.status === "failed") finish();
  });
  if (!sub || sub.done) return finish();
  unsubscribe = sub.unsubscribe;

  // Proxies (Render, nginx, mobile carriers) drop idle connections — a comment line every 15 s keeps it open.
  keepAlive = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15_000);
}));

/* ── GET /api/video/:videoId ── */
router.get("/:videoId", wrap(async (req, res) => {
  const doc = await videoDoc(req.uid, req.params.videoId).get();
  if (!doc.exists) return res.status(404).json({ error: "Not found" });
  const data = doc.data();
  return res.status(200).json({ ...data, createdAt: tsToIso(data.createdAt) });
}));

/* ── DELETE /api/video/:videoId ── */
router.delete("/:videoId", wrap(async (req, res) => {
  const { videoId } = req.params;
  const uid = req.uid;
  const docRef = videoDoc(uid, videoId);
  const doc = await docRef.get();
  if (!doc.exists) return res.status(404).json({ error: "Not found" });
  if (doc.data().userId !== uid) return res.status(403).json({ error: "Forbidden" });

  cancelJob(videoId); // stops a render still in progress
  await cloudinaryDelete(videoPublicId(uid, videoId), "video");
  await cloudinaryDelete(thumbPublicId(uid, videoId), "image");
  await docRef.delete();
  return res.status(200).json({ deleted: videoId });
}));

export default router;
