import express from "express";
import {
  generate,
  AiBusyError,
  AiBlockedError,
  GeminiError,
} from "../ai/geminiClient.js";
import { notesPrompt } from "./notesPrompt.js";
import { getNotes, appendSection } from "./notesStore.js";
import { verifyToken } from "../middleware/firebase.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();

/* ---------------- CONFIG ---------------- */
const MAX_TOKENS = 900;
const MAX_TOPIC_LENGTH = 200;
const MAX_ID_LENGTH = 120;

/* ---------------- GUARDS ----------------
 * The old route was open to the whole internet with CORS "*", so anyone who
 * found the URL could burn the shared AI quota. Now: Firebase login required
 * (set ALLOW_ANON_AI=true only for local development) + a per-user limit. */
if (process.env.ALLOW_ANON_AI !== "true") router.use(verifyToken);
router.use(
  rateLimit({
    windowMs: 10 * 60_000,
    max: 20,
    message: "You've generated a lot of notes in a short time. Please wait a few minutes.",
  })
);

const clean = (v, max) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

/* ---------------- ROUTES ----------------
 * Mounted at /api/notes → POST /api/notes/generate-note
 * Body: { topic, noteId?, previousTopic? }
 * `previousTopic` is sent by the app (the last section of THIS note), so the
 * continuity feature works per-note and survives server restarts. */
router.post("/generate-note", async (req, res) => {
  const topic = clean(req.body?.topic, MAX_TOPIC_LENGTH + 1);
  if (!topic) return res.status(400).json({ error: "topic is required" });
  if (topic.length > MAX_TOPIC_LENGTH) return res.status(400).json({ error: "Topic is too long" });

  const noteId = clean(req.body?.noteId, MAX_ID_LENGTH) || "scratch";
  // Namespaced by user so one learner's history can never leak into another's prompt.
  const storeKey = `${req.uid || "anon"}:${noteId}`;

  let previousTopic = clean(req.body?.previousTopic, MAX_TOPIC_LENGTH);
  if (!previousTopic) {
    const last = getNotes(storeKey).sections.at(-1);
    previousTopic = last?.topic || "";
  }

  try {
    const result = await generate({
      prompt: notesPrompt(topic, previousTopic),
      temperature: 0.4,
      maxTokens: MAX_TOKENS,
      totalTimeoutMs: 40_000,
    });

    const section = {
      sectionId: Date.now().toString(),
      topic,
      content: result.text.trim(),
      source: "gemini",
      model: result.model,
      createdAt: new Date().toISOString(),
    };
    appendSection(storeKey, section);

    // `sections: [section]` keeps older app builds working (they read sections.last.content).
    return res.status(200).json({ noteId, topic, content: section.content, model: result.model, section, sections: [section] });
  } catch (error) {
    if (error instanceof AiBusyError) {
      res.setHeader("Retry-After", String(error.retryAfterSec));
      return res.status(503).json({
        error: "The AI is busy right now. Please try again shortly.",
        retryAfterSec: error.retryAfterSec,
      });
    }
    if (error instanceof AiBlockedError) {
      return res.status(422).json({ error: error.message });
    }
    if (error instanceof GeminiError && error.kind === "noKey") {
      console.error("❌ NOTES: no Gemini key configured");
      return res.status(503).json({ error: "AI is not configured on the server yet." });
    }
    console.error("❌ NOTES ERROR:", error.message);
    return res.status(500).json({ error: "AI generation failed" });
  }
});

export default router;
