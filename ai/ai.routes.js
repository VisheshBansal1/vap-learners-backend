/**
 * ai/ai.routes.js — ONE place the whole app talks to Gemini.
 *
 *   POST /api/ai/generate   → { text, model }          (roadmaps, career guide, quiz generator, ...)
 *   POST /api/ai/stream     → Server-Sent Events        (AI tutor typing effect)
 *
 * The Gemini keys live ONLY on this server. The app sends its prompt plus its
 * Firebase login token; the waterfall (models x keys) runs here.
 *
 * Body (both routes):
 *   { prompt?: string, messages?: [{role:'user'|'model', text}], system?: string,
 *     temperature?: number, maxTokens?: number, json?: boolean }
 *
 * Stream events:   data: {"t":"text chunk"}   ...   data: {"done":true,"model":"..."}
 *                  data: {"error":"friendly message","kind":"busy|blocked|server","retryAfterSec":30}
 */
import express from "express";
import {
  generate,
  generateStream,
  AiBusyError,
  AiBlockedError,
  GeminiError,
} from "./geminiClient.js";
import { verifyToken } from "../middleware/firebase.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();

// Login required (ALLOW_ANON_AI=true only for local development).
if (process.env.ALLOW_ANON_AI !== "true") router.use(verifyToken);
router.use(
  rateLimit({
    windowMs: 10 * 60_000,
    max: Number(process.env.AI_RATE_LIMIT) || 60,
    message: "You're asking a lot in a short time. Please wait a few minutes and try again.",
  })
);

// Caps stop the endpoint being used as a free general-purpose LLM proxy.
const MAX_PROMPT_CHARS = 14_000;
const MAX_SYSTEM_CHARS = 8_000;
const MAX_MESSAGES = 30;
const MAX_TOKENS_CAP = 4096;

function parseBody(body) {
  const b = body && typeof body === "object" ? body : {};
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

  let messages = [];
  if (Array.isArray(b.messages)) {
    messages = b.messages
      .slice(-MAX_MESSAGES)
      .map((m) => ({
        role: m?.role === "user" ? "user" : "model",
        content: str(m?.text ?? m?.content, MAX_PROMPT_CHARS),
      }))
      .filter((m) => m.content.trim());
  }
  const prompt = str(b.prompt, MAX_PROMPT_CHARS);
  if (!messages.length && !prompt.trim()) return { error: "prompt or messages is required" };

  const temperature = Number.isFinite(+b.temperature) ? Math.min(Math.max(+b.temperature, 0), 1.5) : undefined;
  const maxTokens = Number.isFinite(+b.maxTokens) ? Math.min(Math.max(Math.round(+b.maxTokens), 16), MAX_TOKENS_CAP) : undefined;

  return {
    opts: {
      prompt: prompt.trim() ? prompt : undefined,
      messages,
      system: str(b.system, MAX_SYSTEM_CHARS) || undefined,
      temperature,
      maxTokens,
      json: b.json === true,
    },
  };
}

function describe(err) {
  if (err instanceof AiBusyError) {
    return { status: 503, kind: "busy", error: "The AI is busy right now. Please try again shortly.", retryAfterSec: err.retryAfterSec };
  }
  if (err instanceof AiBlockedError) return { status: 422, kind: "blocked", error: err.message };
  if (err instanceof GeminiError && err.kind === "noKey") {
    return { status: 503, kind: "server", error: "AI is not configured on the server yet." };
  }
  console.error("AI ERROR:", err?.message);
  return { status: 500, kind: "server", error: "AI generation failed. Please try again." };
}

router.post("/generate", async (req, res) => {
  const parsed = parseBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const r = await generate({ ...parsed.opts, totalTimeoutMs: 55_000 });
    return res.status(200).json({ text: r.text, model: r.model });
  } catch (e) {
    const d = describe(e);
    if (d.retryAfterSec) res.setHeader("Retry-After", String(d.retryAfterSec));
    return res.status(d.status).json({ error: d.error, kind: d.kind, retryAfterSec: d.retryAfterSec });
  }
});

router.post("/stream", async (req, res) => {
  const parsed = parseBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  let closed = false;
  res.on("close", () => { closed = true; }); // NOT req: req "close" fires once the request body is read
  const ping = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15_000);

  let model = null;
  const it = generateStream({ ...parsed.opts, onModel: (m) => { model = m; } });
  try {
    for await (const t of it) {
      if (closed) { await it.return?.(); break; } // learner left — stop paying for tokens
      send({ t });
    }
    send({ done: true, model });
  } catch (e) {
    const d = describe(e);
    send({ error: d.error, kind: d.kind, retryAfterSec: d.retryAfterSec });
  } finally {
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  }
});

export default router;
