import express from "express";
import cors    from "cors";
import dotenv  from "dotenv";
import fs      from "fs";
import path    from "path";
import { fileURLToPath } from "url";

import aiRouter    from "./ai/ai.routes.js";
import notesRouter from "./notes/notes.routes.js";
import newsRouter  from "./news/news.routes.js";
import videoRouter from "./video/video.routes.js";
import { initFirebase } from "./middleware/firebase.js";
import { getAiStatus } from "./ai/geminiClient.js";

dotenv.config({ quiet: true });

initFirebase();

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy → correct client IPs for rate limiting

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "50kb" }));

/* ── HEALTH ── */
// Is the Python video engine (vavina_learner_video_generator/) deployed next to this server?
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hasVideoEngine = () => {
  const dirs = [process.env.VIDEO_PIPELINE_DIR, path.join(__dirname, "vavina_learner_video_generator"),
                path.join(__dirname, "..", "vavina_learner_video_generator")].filter(Boolean);
  return dirs.some((d) => fs.existsSync(path.join(d, "utils")) && fs.existsSync(path.join(d, "script")));
};

const hasCloudinary = () =>
  !!process.env.CLOUDINARY_CLOUD_NAME && !!process.env.CLOUDINARY_API_KEY && !!process.env.CLOUDINARY_API_SECRET;

app.get("/",       (_req, res) => res.send("Vavina Learners API v4 ✓"));
app.get("/ping",   (_req, res) => res.json({ status: "ok", message: "Backend is alive", version: "4.0.0" }));
app.get("/health", (_req, res) => {
  const ai = getAiStatus();
  res.json({
    status: "ok",
    services: {
      ai:         ai.configured,
      notes:      ai.configured,
      news:       !!process.env.NEWS_API_KEY,
      video:      ai.configured && hasCloudinary() && hasVideoEngine(),
      videoEngine: hasVideoEngine(),
      cloudinary: hasCloudinary(),
      firebase:   !!process.env.FIREBASE_CRED_JSON,
    },
    // Which Gemini models are usable right now (no keys are ever exposed)
    ai: { keys: ai.keys, models: ai.models, stats: ai.stats },
  });
});

/* ── ROUTES ── */
app.use("/api/ai",    aiRouter);
app.use("/api/notes", notesRouter);
app.use("/api/news",  newsRouter);
app.use("/api/video", videoRouter);

/* ── 404 / ERROR ── */
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error("❌ UNHANDLED ERROR:", err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: "Internal server error" });
});

// A stray rejected promise should be logged, not take the whole server (and every running render) down.
process.on("unhandledRejection", (reason) => console.error("❌ UNHANDLED REJECTION:", reason));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  const ai = getAiStatus();
  console.log(`\n🚀 Vavina Learners API v4 running on port ${PORT}`);
  console.log(`   Gemini       : ${ai.configured ? `✓ ${ai.keys} key(s), ${ai.models.length} models in waterfall` : "✗ GEMINI_API_KEYS missing"}`);
  console.log(`   News API     : ${process.env.NEWS_API_KEY ? "✓" : "✗ NEWS_API_KEY missing"}`);
  console.log(`   Cloudinary   : ${hasCloudinary() ? "✓" : "✗ CLOUDINARY_* missing"}`);
  console.log(`   Video engine : ${hasVideoEngine() ? "✓" : "✗ vavina_learner_video_generator/ folder not found (videos will fail)"}`);
  console.log(`   Firebase     : ${process.env.FIREBASE_CRED_JSON ? "✓" : "✗ FIREBASE_CRED_JSON missing"}\n`);
});
