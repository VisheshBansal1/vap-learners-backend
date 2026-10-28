/**
 * Run with:  npm test      (node --test)
 * Uses a local mock of the Gemini REST API — no network, no real keys.
 */
import { test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  generate,
  generateStream,
  resetAiState,
  getAiStatus,
  toContents,
  classifyFailure,
  msUntilPacificMidnight,
  AiBusyError,
  AiBlockedError,
  GeminiError,
} from "../ai/geminiClient.js";

// ── mock server ──────────────────────────────────────────────────────────────
let server;
let calls = [];
let script = () => ({ status: 200, body: okBody("default") });

const okBody = (text, extra = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", ...extra }],
});
const errBody = (code, status, message, details) => ({ error: { code, status, message, details } });

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const m = req.url.match(/\/models\/([^:]+):(?:stream)?[Gg]enerateContent/);
      const call = {
        model: m?.[1],
        key: req.headers["x-goog-api-key"],
        body: raw ? JSON.parse(raw) : null,
      };
      calls.push(call);
      const r = script(call, calls.length);
      if (r.sse) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        return res.end(r.sse.map((t) => `data: ${JSON.stringify(typeof t === "string" ? okBody(t) : t)}\n\n`).join(""));
      }
      res.writeHead(r.status, { "Content-Type": "application/json", ...(r.headers || {}) });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1beta`;
});

after(() => server.close());

beforeEach(() => {
  calls = [];
  resetAiState();
  process.env.GEMINI_MODELS = "m1,m2,m3";
  process.env.GEMINI_API_KEYS = "AIzaKEY_A";
  delete process.env.GEMINI_API_KEY;
  delete process.env.NOTES_MAKER_API;
  delete process.env.GROQ_API_KEY;
  script = () => ({ status: 200, body: okBody("default") });
});

// ── tests ────────────────────────────────────────────────────────────────────

test("uses the first (best) model when it works", async () => {
  script = (c) => ({ status: 200, body: okBody(`from ${c.model}`) });
  const r = await generate({ prompt: "hi" });
  assert.equal(r.text, "from m1");
  assert.equal(r.model, "m1");
  assert.deepEqual(calls.map((c) => c.model), ["m1"]);
});

test("429 per-minute on m1 → falls to m2, and m1 is skipped on the NEXT request", async () => {
  script = (c) =>
    c.model === "m1"
      ? { status: 429, body: errBody(429, "RESOURCE_EXHAUSTED", "quota", [{ retryDelay: "30s" }]) }
      : { status: 200, body: okBody(`from ${c.model}`) };

  const r1 = await generate({ prompt: "a" });
  assert.equal(r1.model, "m2");
  assert.deepEqual(calls.map((c) => c.model), ["m1", "m2"]);

  calls = [];
  const r2 = await generate({ prompt: "b" });
  assert.equal(r2.model, "m2");
  assert.deepEqual(calls.map((c) => c.model), ["m2"], "m1 must not be called while cooling down");
});

test("daily quota 429 puts the model on a long cooldown", async () => {
  script = (c) =>
    c.model === "m1"
      ? {
          status: 429,
          body: errBody(429, "RESOURCE_EXHAUSTED", "exceeded", [
            { violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
          ]),
        }
      : { status: 200, body: okBody("ok") };
  await generate({ prompt: "x" });
  const m1 = getAiStatus().models.find((m) => m.model === "m1");
  assert.equal(m1.availableKeys, 0);
  assert.ok(m1.coolingDownFor > 60, `expected long cooldown, got ${m1.coolingDownFor}s`);
});

test("404 (model gone) and 503 (overloaded) both fall through to the next model", async () => {
  script = (c) => {
    if (c.model === "m1") return { status: 404, body: errBody(404, "NOT_FOUND", "model not found") };
    if (c.model === "m2") return { status: 503, body: errBody(503, "UNAVAILABLE", "overloaded") };
    return { status: 200, body: okBody("from m3") };
  };
  const r = await generate({ prompt: "x" });
  assert.equal(r.model, "m3");
  assert.deepEqual(calls.map((c) => c.model), ["m1", "m2", "m3"]);
});

test("multiple keys: second key is tried on the SAME (better) model before degrading", async () => {
  process.env.GEMINI_API_KEYS = "AIzaKEY_A, AIzaKEY_B";
  script = (c) =>
    c.key === "AIzaKEY_A"
      ? { status: 429, body: errBody(429, "RESOURCE_EXHAUSTED", "q", [{ retryDelay: "40s" }]) }
      : { status: 200, body: okBody(`from ${c.model}`) };
  const r = await generate({ prompt: "x" });
  assert.equal(r.model, "m1");
  assert.equal(r.keyIndex, 1);
  assert.deepEqual(calls.map((c) => `${c.model}:${c.key}`), ["m1:AIzaKEY_A", "m1:AIzaKEY_B"]);
});

test("invalid key is disabled for every model, not retried per model", async () => {
  process.env.GEMINI_API_KEYS = "AIzaBAD, AIzaGOOD";
  script = (c) =>
    c.key === "AIzaBAD"
      ? { status: 400, body: errBody(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.") }
      : { status: 200, body: okBody("ok") };
  await generate({ prompt: "x" });
  calls = [];
  await generate({ prompt: "y" });
  assert.ok(calls.every((c) => c.key === "AIzaGOOD"), "bad key must be skipped entirely afterwards");
});

test("all models exhausted → AiBusyError with retryAfterSec", async () => {
  script = () => ({ status: 429, body: errBody(429, "RESOURCE_EXHAUSTED", "q", [{ retryDelay: "45s" }]) });
  await assert.rejects(
    () => generate({ prompt: "x", totalTimeoutMs: 8000 }),
    (e) => e instanceof AiBusyError && e.retryAfterSec >= 5 && e.retryAfterSec <= 60
  );
  assert.equal(calls.length, 3, "each model tried exactly once");
});

test("thinkingConfig rejected (400) → retried once on the same model without it", async () => {
  script = (c) => {
    if (c.body.generationConfig.thinkingConfig)
      return { status: 400, body: errBody(400, "INVALID_ARGUMENT", "Unsupported thinking level for this model") };
    return { status: 200, body: okBody("ok") };
  };
  // use a gemini-3 name so thinkingConfig is sent
  process.env.GEMINI_MODELS = "gemini-3.9-test,m2";
  const r = await generate({ prompt: "x" });
  assert.equal(r.model, "gemini-3.9-test");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.generationConfig.thinkingConfig);
  assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined);
  // and it is remembered:
  calls = [];
  await generate({ prompt: "again" });
  assert.equal(calls[0].body.generationConfig.thinkingConfig, undefined);
});

test("safety block throws AiBlockedError and does NOT waterfall", async () => {
  script = () => ({ status: 200, body: { promptFeedback: { blockReason: "SAFETY" }, candidates: [] } });
  await assert.rejects(() => generate({ prompt: "x" }), AiBlockedError);
  assert.equal(calls.length, 1);
});

test("empty answer cut off by MAX_TOKENS → tries the next model", async () => {
  script = (c) =>
    c.model === "m1"
      ? { status: 200, body: { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] } }
      : { status: 200, body: okBody("full answer") };
  const r = await generate({ prompt: "x" });
  assert.equal(r.model, "m2");
});

test("genuine 400 (bad request) is surfaced immediately, no waterfall", async () => {
  script = () => ({ status: 400, body: errBody(400, "INVALID_ARGUMENT", "Request contains an invalid argument.") });
  await assert.rejects(() => generate({ prompt: "x" }), (e) => e instanceof GeminiError && e.kind === "badRequest");
  assert.equal(calls.length, 1);
});

test("'thought' parts are not returned to the user", async () => {
  script = () => ({
    status: 200,
    body: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "secret reasoning", thought: true }, { text: "Answer." }] } }] },
  });
  assert.equal((await generate({ prompt: "x" })).text, "Answer.");
});

test("request shape: system → systemInstruction, json → responseMimeType, headroom added, key in header", async () => {
  await generate({ prompt: "hello", system: "Be brief", json: true, maxTokens: 500, temperature: 0.1 });
  const c = calls[0];
  assert.equal(c.body.systemInstruction.parts[0].text, "Be brief");
  assert.equal(c.body.generationConfig.responseMimeType, "application/json");
  assert.equal(c.body.generationConfig.maxOutputTokens, 500 + 2048);
  assert.equal(c.body.generationConfig.temperature, 0.1);
  assert.equal(c.key, "AIzaKEY_A");
});

test("no key configured → clear error; Groq-style keys are ignored", async () => {
  delete process.env.GEMINI_API_KEYS;
  process.env.NOTES_MAKER_API = "gsk_old_groq_key";
  await assert.rejects(() => generate({ prompt: "x" }), (e) => e.kind === "noKey");
  process.env.NOTES_MAKER_API = "AIzaLegacyNamedButGemini";
  assert.equal((await generate({ prompt: "x" })).text, "default");
});

test("toContents: assistant→model, merges same-role runs, drops leading model turns and blanks", () => {
  const c = toContents([
    { role: "assistant", content: "stray greeting" },
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "  " },
    { role: "assistant", content: "c" },
    { role: "user", content: "d" },
  ]);
  assert.deepEqual(c.map((x) => x.role), ["user", "model", "user"]);
  assert.equal(c[0].parts[0].text, "a\n\nb");
});

test("classifyFailure + Pacific-midnight helper behave sanely", () => {
  assert.equal(classifyFailure(503, null).kind, "overload");
  assert.equal(classifyFailure(404, null).kind, "modelGone");
  assert.equal(classifyFailure(401, null).scope, "key");
  const ms = msUntilPacificMidnight(new Date("2026-10-25T10:00:00Z")); // 03:00 PDT → 21h left
  assert.ok(Math.abs(ms - 21 * 3600_000) < 2000, `got ${ms}`);
});

// ── streaming ────────────────────────────────────────────────────────────────

async function collect(it) {
  let out = "";
  for await (const t of it) out += t;
  return out;
}

test("stream: yields chunks in order and reports the model", async () => {
  script = () => ({ sse: ["Hel", "lo ", "world"] });
  let model = null;
  const text = await collect(generateStream({ prompt: "x", onModel: (m) => (model = m) }));
  assert.equal(text, "Hello world");
  assert.equal(model, "m1");
});

test("stream: 429 before the first chunk fails over to the next model", async () => {
  script = (c) =>
    c.model === "m1"
      ? { status: 429, body: errBody(429, "RESOURCE_EXHAUSTED", "q", [{ retryDelay: "30s" }]) }
      : { sse: ["from m2"] };
  assert.equal(await collect(generateStream({ prompt: "x" })), "from m2");
  assert.deepEqual(calls.map((c) => c.model), ["m1", "m2"]);
});

test("stream: safety block throws AiBlockedError", async () => {
  script = () => ({ sse: [{ promptFeedback: { blockReason: "SAFETY" } }] });
  await assert.rejects(() => collect(generateStream({ prompt: "x" })), AiBlockedError);
});

test("stream: empty stream moves on to the next model", async () => {
  script = (c) => (c.model === "m1" ? { sse: [] } : { sse: ["ok"] });
  assert.equal(await collect(generateStream({ prompt: "x" })), "ok");
});

test("stream: everything exhausted -> AiBusyError", async () => {
  script = () => ({ status: 503, body: errBody(503, "UNAVAILABLE", "busy") });
  await assert.rejects(() => collect(generateStream({ prompt: "x" })), AiBusyError);
});
