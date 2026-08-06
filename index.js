import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import notesRouter from "./notes/notes.routes.js";
import newsRouter from "./news/news.routes.js";

dotenv.config({ quiet: true }); // suppress dotenv's own promotional console output

const app = express();

/* ---------------- MIDDLEWARE ---------------- */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "50kb" }));

/* ---------------- HEALTH / INFO ROUTES ---------------- */
app.get("/", (req, res) => {
  res.send("Learnify API is running");
});

app.get("/ping", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Backend is alive",
  });
});

/* ---------------- FEATURE ROUTES ---------------- */
// Notes generation (Groq AI):  POST /api/notes/generate-note
app.use("/api/notes", notesRouter);

// Daily tech news:             GET  /api/news/daily-tech-news
app.use("/api/news", newsRouter);

/* ---------------- 404 ---------------- */
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

/* ---------------- FALLBACK ERROR HANDLER ---------------- */
app.use((err, req, res, next) => {
  console.error("❌ UNHANDLED ERROR:", err);
  res.status(500).json({ error: "Internal server error" });
});

/* ---------------- SERVER ---------------- */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Learnify API running on port ${PORT}`);
});
