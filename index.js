import express from "express";
import cors    from "cors";
import dotenv  from "dotenv";

import notesRouter from "./notes/notes.routes.js";
import newsRouter  from "./news/news.routes.js";
import videoRouter from "./video/video.routes.js";
import { initFirebase } from "./middleware/firebase.js";

dotenv.config({ quiet: true });

initFirebase();

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "50kb" }));

/* ── HEALTH ── */
app.get("/",      (_req, res) => res.send("Vavina Learners API v3 ✓"));
app.get("/ping",  (_req, res) => res.json({ status: "ok", message: "Backend is alive", version: "3.0.0" }));
app.get("/health", (_req, res) => res.json({
  status: "ok",
  services: {
    notes:      !!process.env.NOTES_MAKER_API,
    news:       !!process.env.NEWS_API_KEY,
    video:      !!process.env.GROQ_API_KEY && !!process.env.CLOUDINARY_CLOUD_NAME,
    cloudinary: !!process.env.CLOUDINARY_CLOUD_NAME && !!process.env.CLOUDINARY_API_KEY,
    firebase:   !!process.env.FIREBASE_CRED_JSON,
  },
}));

/* ── ROUTES ── */
app.use("/api/notes", notesRouter);
app.use("/api/news",  newsRouter);
app.use("/api/video", videoRouter);

/* ── 404 / ERROR ── */
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error("❌ UNHANDLED ERROR:", err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Vavina Learners API v3 running on port ${PORT}`);
  console.log(`   Notes API    : ${process.env.NOTES_MAKER_API      ? "✓" : "✗ NOTES_MAKER_API missing"}`);
  console.log(`   News API     : ${process.env.NEWS_API_KEY          ? "✓" : "✗ NEWS_API_KEY missing"}`);
  console.log(`   Groq Key     : ${process.env.GROQ_API_KEY          ? "✓" : "✗ GROQ_API_KEY missing"}`);
  console.log(`   Cloudinary   : ${process.env.CLOUDINARY_CLOUD_NAME ? "✓" : "✗ CLOUDINARY_CLOUD_NAME missing"}`);
  console.log(`   Firebase     : ${process.env.FIREBASE_CRED_JSON    ? "✓" : "✗ FIREBASE_CRED_JSON missing"}\n`);
});
