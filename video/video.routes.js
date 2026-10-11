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

import express          from "express";
import { v4 as uuidv4 } from "uuid";
import { verifyToken, getDb } from "../middleware/firebase.js";
import { spawnVideoJob, getJobState, subscribeJob, clearJob } from "./videoWorker.js";
import { cloudinaryDelete, videoPublicId, thumbPublicId } from "./cloudinaryHelper.js";

const router = express.Router();
router.use(verifyToken);

const FREE_LIMIT = 5;

const videosCol = (uid)          => getDb().collection("users").doc(uid).collection("videos");
const videoDoc  = (uid, videoId) => videosCol(uid).doc(videoId);

function tsToIso(val) {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate().toISOString();
  return val;
}

async function freeTierRotate(uid) {
  const snap = await videosCol(uid).orderBy("createdAt", "asc").limit(1).get();
  if (snap.empty) return;
  const old   = snap.docs[0];
  const data  = old.data();
  const oldId = data.videoId || old.id;

  // Delete both assets from Cloudinary
  await cloudinaryDelete(videoPublicId(uid, oldId), "video");
  await cloudinaryDelete(thumbPublicId(uid, oldId),  "image");
  await old.ref.delete();
  console.log(`[free-tier] rotated out ${oldId} for user ${uid}`);
}

/* ── POST /api/video/generate ── */
router.post("/generate", async (req, res) => {
  const { topic, difficulty = "intermediate", voice = "english" } = req.body;
  if (!topic?.trim()) return res.status(400).json({ error: "topic is required" });

  const uid = req.uid;

  try {
    const userSnap  = await getDb().collection("users").doc(uid).get();
    const isPremium = userSnap.data()?.isPremium === true;

    if (!isPremium) {
      const countSnap = await videosCol(uid).count().get();
      if ((countSnap.data().count ?? 0) >= FREE_LIMIT) {
        await freeTierRotate(uid);
      }
    }

    const videoId = uuidv4();

    await videoDoc(uid, videoId).set({
      videoId,
      userId:       uid,
      title:        `Tutorial: ${topic.trim()}`,
      topic:        topic.trim(),
      videoUrl:     "",
      thumbnailUrl: "",
      duration:     0,
      fileSize:     0,
      createdAt:    new Date(),
      status:       "processing",
      isPremium,
    });

    spawnVideoJob({ videoId, uid, topic: topic.trim(), difficulty, voice });

    return res.status(200).json({ videoId, message: "Generation started" });
  } catch (e) {
    console.error("❌ /generate error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

/* ── GET /api/video/my-videos ── */
router.get("/my-videos", async (req, res) => {
  try {
    const snap   = await videosCol(req.uid).orderBy("createdAt", "desc").get();
    const videos = snap.docs.map((d) => {
      const data = d.data();
      return { ...data, createdAt: tsToIso(data.createdAt) };
    });
    return res.status(200).json(videos);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* ── GET /api/video/:videoId/status ── */
router.get("/:videoId/status", async (req, res) => {
  const { videoId } = req.params;
  const doc = await videoDoc(req.uid, videoId).get();
  if (!doc.exists) return res.status(404).json({ error: "Video not found" });
  const job = getJobState(videoId) || {};
  return res.status(200).json({
    status:   job.status   ?? "processing",
    progress: job.progress ?? 0,
    message:  job.message  ?? "",
  });
});

/* ── GET /api/video/:videoId/stream (SSE) ── */
router.get("/:videoId/stream", async (req, res) => {
  const { videoId } = req.params;
  const doc = await videoDoc(req.uid, videoId).get();
  if (!doc.exists) return res.status(404).json({ error: "Video not found" });

  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection",        "keep-alive");
  res.flushHeaders();

  const unsub = subscribeJob(videoId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.status === "completed" || event.status === "failed") {
      unsub();
      res.end();
    }
  });

  req.on("close", () => unsub());
});

/* ── GET /api/video/:videoId ── */
router.get("/:videoId", async (req, res) => {
  try {
    const doc = await videoDoc(req.uid, req.params.videoId).get();
    if (!doc.exists) return res.status(404).json({ error: "Not found" });
    const data = doc.data();
    return res.status(200).json({ ...data, createdAt: tsToIso(data.createdAt) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* ── DELETE /api/video/:videoId ── */
router.delete("/:videoId", async (req, res) => {
  const { videoId } = req.params;
  const uid         = req.uid;
  try {
    const docRef = videoDoc(uid, videoId);
    const doc    = await docRef.get();
    if (!doc.exists)               return res.status(404).json({ error: "Not found" });
    if (doc.data().userId !== uid) return res.status(403).json({ error: "Forbidden" });

    await cloudinaryDelete(videoPublicId(uid, videoId), "video");
    await cloudinaryDelete(thumbPublicId(uid, videoId),  "image");
    await docRef.delete();
    clearJob(videoId);

    return res.status(200).json({ deleted: videoId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
