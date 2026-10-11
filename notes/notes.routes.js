import express from "express";
import { callGroq } from "./groqClient.js";
import { notesPrompt } from "./notesPrompt.js";
import { getNotes, appendSection } from "./notesStore.js";

const router = express.Router();

/* ---------------- CONFIG ---------------- */
const MAX_TOKENS = 800;
const AI_TIMEOUT_MS = 12_000;
const MAX_TOPIC_LENGTH = 200;

/* ---------------- UTILS ---------------- */
function withTimeout(promise, ms) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("AI request timed out")), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

/* ---------------- PREVIOUS TOPIC LOGIC ---------------- */
function buildPreviousTopicTitle(noteId) {
  const notes = getNotes(noteId);
  if (!notes || !Array.isArray(notes.sections)) return "";
  if (notes.sections.length === 0) return "";
  const lastSection = notes.sections[notes.sections.length - 1];
  return lastSection?.topic || "";
}

/* ---------------- ROUTES ---------------- */
// Mounted at /api/notes → full path POST /api/notes/generate-note
router.post("/generate-note", async (req, res) => {
  try {
    const { noteId, topic } = req.body;

    if (!noteId || !topic)
      return res.status(400).json({ error: "noteId and topic are required" });

    if (typeof topic !== "string" || topic.trim() === "")
      return res.status(400).json({ error: "Invalid topic" });

    if (topic.length > MAX_TOPIC_LENGTH)
      return res.status(400).json({ error: "Topic is too long" });

    console.log("🧠 Generating notes for:", topic);

    const previousTopic = buildPreviousTopicTitle(noteId);
    const aiRequest = callGroq(notesPrompt(topic, previousTopic), { maxTokens: MAX_TOKENS });
    const content = await withTimeout(aiRequest, AI_TIMEOUT_MS);

    appendSection(noteId, {
      sectionId: Date.now().toString(),
      topic,
      content,
      source: "groq",
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json(getNotes(noteId));
  } catch (error) {
    console.error("❌ NOTES ERROR:", error.message);
    if (error.message.includes("timed out"))
      return res.status(504).json({ error: "AI took too long to respond" });
    return res.status(500).json({ error: "AI generation failed", details: error.message });
  }
});

export default router;
