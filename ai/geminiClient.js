/**
 * ai/geminiClient.js
 * ──────────────────
 * Single entry point for every Gemini call made by the Node backend.
 *
 * WATERFALL
 *   Models are tried best → lightest. For each model every API key is tried.
 *   When a (model, key) pair fails it is put on a cooldown so the NEXT request
 *   skips it instantly instead of paying for another failing round-trip:
 *
 *     429 per-minute quota   → cooldown for the retryDelay Google returns
 *     429 per-day quota      → cooldown until the quota resets (capped at 6h,
 *                              then it is probed again — a probe is one cheap 429)
 *     500 / 503 / 504 / net  → short cooldown (15s)
 *     404 / 403 on a model   → model unavailable for this key for 6h
 *     401 / invalid key      → key disabled for 24h
 *     SAFETY block           → NOT retried (every model would block the same prompt)
 *     400 on thinkingConfig  → retried once on the same model without it
 *
 * We use the stable, stateless `generateContent` endpoint (still fully
 * supported by Google) so nothing a student types is stored server-side.
 *
 * ENV
 *   GEMINI_API_KEYS   comma / space / newline separated list (recommended —
 *                     keys from DIFFERENT Google Cloud projects multiply the
 *                     free quota because limits are per project)
 *   GEMINI_API_KEY    single key (also accepted)
 *   GEMINI_MODELS     optional override of the model chain, comma separated
 *   GEMINI_BASE_URL   optional (tests)
 */

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Free-tier text models, best → lightest.
// Source: ai.google.dev/gemini-api/docs/pricing + /deprecations (checked 25 Oct 2026).
//  • 3.5-flash / 3.7-flash are NOT listed: Google aliases them to 3.6 / 3.8, so they
//    would share the same quota and add nothing.
//  • The 2.5 models still work but are now limited to projects that already used
//    them — they sit at the end and are skipped automatically (404/403) if refused.
//  • gemini-4-argon / gemini-3.1-pro are paid-only → add via GEMINI_MODELS if you bill.
export const DEFAULT_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

const MIN = 60_000;
const HOUR = 60 * MIN;

const COOLDOWN = {
  overload: 15_000,
  rateDefault: 20_000,
  rateMin: 5_000,
  rateMax: 2 * MIN,
  dailyCap: 6 * HOUR,
  modelGone: 6 * HOUR,
  badKey: 24 * HOUR,
};

// ── errors ───────────────────────────────────────────────────────────────────

export class GeminiError extends Error {
  constructor(message, { status = 0, kind = "unknown" } = {}) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.kind = kind;
  }
}

/** Every model/key is cooling down or failed. Safe to show a friendly message. */
export class AiBusyError extends Error {
  constructor(message, { retryAfterSec = 30, attempts = [] } = {}) {
    super(message);
    this.name = "AiBusyError";
    this.retryAfterSec = retryAfterSec;
    this.attempts = attempts;
  }
}

/** The prompt itself was refused (safety). Retrying other models will not help. */
export class AiBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiBlockedError";
  }
}

// ── config ───────────────────────────────────────────────────────────────────

function splitList(v) {
  return String(v || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadKeys() {
  const raw = [
    ...splitList(process.env.GEMINI_API_KEYS),
    ...splitList(process.env.GEMINI_API_KEY),
    // Old variable names — only used if they already hold a Gemini key.
    ...splitList(process.env.NOTES_MAKER_API),
    ...splitList(process.env.GROQ_API_KEY),
  ];
  const keys = [];
  for (const k of raw) {
    if (k.startsWith("gsk_")) continue; // a Groq key — useless here
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

function loadModels() {
  const custom = splitList(process.env.GEMINI_MODELS);
  return custom.length ? custom : DEFAULT_MODELS;
}

const baseUrl = () => (process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

// ── cooldown state (per process) ─────────────────────────────────────────────

const pairState = new Map(); // `${model}|${keyIdx}` → { until, reason }
const keyState = new Map(); //  keyIdx → { until, reason }
const noThinking = new Set(); // models that rejected thinkingConfig
const stats = { calls: 0, ok: 0, fail: 0, byModel: {} };

const pairId = (model, i) => `${model}|${i}`;

function coolPair(model, i, ms, reason) {
  pairState.set(pairId(model, i), { until: Date.now() + ms, reason });
}

function pairWait(model, i) {
  const now = Date.now();
  const k = keyState.get(i);
  const p = pairState.get(pairId(model, i));
  return Math.max(0, (k?.until ?? 0) - now, (p?.until ?? 0) - now);
}

export function resetAiState() {
  pairState.clear();
  keyState.clear();
  noThinking.clear();
  stats.calls = stats.ok = stats.fail = 0;
  stats.byModel = {};
}

/** Safe-to-expose snapshot for /health (no keys). */
export function getAiStatus() {
  const keys = loadKeys();
  const models = loadModels();
  return {
    configured: keys.length > 0,
    keys: keys.length,
    models: models.map((m) => {
      const waits = keys.map((_, i) => pairWait(m, i));
      const available = waits.filter((w) => w === 0).length;
      return {
        model: m,
        availableKeys: available,
        coolingDownFor: available === 0 && waits.length ? Math.ceil(Math.min(...waits) / 1000) : 0,
      };
    }),
    stats: { ...stats },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ms until the next midnight in Pacific time (when free-tier RPD quotas reset). */
export function msUntilPacificMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
  return Math.max(60_000, 24 * HOUR - elapsed);
}

function parseRetryDelayMs(errBody, headers) {
  const details = errBody?.error?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (typeof d?.retryDelay === "string") {
        const s = parseFloat(d.retryDelay);
        if (Number.isFinite(s)) return Math.ceil(s * 1000);
      }
    }
  }
  const ra = Number(headers?.get?.("retry-after"));
  return Number.isFinite(ra) && ra > 0 ? ra * 1000 : null;
}

function isDailyQuota(errBody) {
  const text = JSON.stringify(errBody?.error?.details ?? "") + (errBody?.error?.message ?? "");
  return /PerDay|per day|RequestsPerDay|daily/i.test(text);
}

/** Turn an HTTP failure into a decision. */
export function classifyFailure(status, body, headers) {
  const msg = body?.error?.message || `HTTP ${status}`;
  const lower = String(msg).toLowerCase();

  if (status === 429) {
    if (isDailyQuota(body)) {
      const ms = Math.min(msUntilPacificMidnight(), COOLDOWN.dailyCap);
      return { kind: "daily", cooldown: ms, scope: "pair", msg };
    }
    const ms = parseRetryDelayMs(body, headers) ?? COOLDOWN.rateDefault;
    return {
      kind: "rate",
      cooldown: Math.min(Math.max(ms, COOLDOWN.rateMin), COOLDOWN.rateMax),
      scope: "pair",
      msg,
    };
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return { kind: "overload", cooldown: COOLDOWN.overload, scope: "pair", msg };
  }
  if (status === 404) {
    return { kind: "modelGone", cooldown: COOLDOWN.modelGone, scope: "pair", msg };
  }
  if (status === 401 || (status === 400 && /api key not valid|api_key_invalid|invalid api key/i.test(msg))) {
    return { kind: "badKey", cooldown: COOLDOWN.badKey, scope: "key", msg };
  }
  if (status === 403) {
    // Key problems vs. "this project may not use this model".
    if (/api key|consumer|suspended|denied access|has been blocked|billing/i.test(lower) && !/model/i.test(lower)) {
      return { kind: "badKey", cooldown: COOLDOWN.badKey, scope: "key", msg };
    }
    return { kind: "modelGone", cooldown: COOLDOWN.modelGone, scope: "pair", msg };
  }
  if (status === 400 && /thinking/i.test(lower)) {
    return { kind: "thinking", cooldown: 0, scope: "none", msg };
  }
  return { kind: "badRequest", cooldown: 0, scope: "none", msg };
}

// ── request building ─────────────────────────────────────────────────────────

const isGemini3 = (m) => /^gemini-3/.test(m);

/** Normalise any chat history into Gemini's contents[] (user first, alternating). */
export function toContents(messages) {
  const out = [];
  for (const m of messages) {
    const text = String(m.content ?? m.text ?? "").trim();
    if (!text) continue;
    const role = m.role === "user" ? "user" : "model"; // assistant / model → model
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.parts[0].text += "\n\n" + text;
    } else {
      out.push({ role, parts: [{ text }] });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function buildBody(model, opts, useThinking) {
  const { system, messages, temperature, maxTokens, json } = opts;
  const generationConfig = {
    temperature,
    // Thinking tokens count against this limit — leave headroom or answers get cut.
    maxOutputTokens: maxTokens + 2048,
  };
  if (json) generationConfig.responseMimeType = "application/json";
  if (useThinking && isGemini3(model) && !noThinking.has(model)) {
    generationConfig.thinkingConfig = { thinkingLevel: "low" }; // "low" is valid on every 3.x model
  }
  const body = { contents: toContents(messages), generationConfig };
  if (system && system.trim()) body.systemInstruction = { parts: [{ text: system.trim() }] };
  return body;
}

function extractText(data) {
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("")
    : "";
  return { text, finishReason: cand?.finishReason, blockReason: data?.promptFeedback?.blockReason };
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}  [opts.prompt]       single user message (or use messages)
 * @param {Array<{role:string,content:string}>} [opts.messages]
 * @param {string}  [opts.system]
 * @param {number}  [opts.temperature=0.4]
 * @param {number}  [opts.maxTokens=800]   answer budget (thinking headroom is added)
 * @param {boolean} [opts.json=false]      ask for application/json
 * @param {number}  [opts.attemptTimeoutMs=25000]
 * @param {number}  [opts.totalTimeoutMs=50000]
 * @returns {Promise<{text:string, model:string, keyIndex:number, attempts:object[]}>}
 */
export async function generate(opts = {}) {
  const keys = loadKeys();
  if (!keys.length) {
    throw new GeminiError(
      "No Gemini API key configured. Set GEMINI_API_KEYS (or GEMINI_API_KEY) on the server.",
      { kind: "noKey" }
    );
  }
  const models = loadModels();
  const o = {
    system: opts.system,
    messages: opts.messages?.length ? opts.messages : [{ role: "user", content: opts.prompt ?? "" }],
    temperature: opts.temperature ?? 0.4,
    maxTokens: opts.maxTokens ?? 800,
    json: !!opts.json,
  };
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 25_000;
  const deadline = Date.now() + (opts.totalTimeoutMs ?? 50_000);
  const attempts = [];
  const startedAt = Date.now();
  stats.calls++;

  for (let pass = 0; pass < 2; pass++) {
    let soonest = Infinity;

    for (const model of models) {
      for (let i = 0; i < keys.length; i++) {
        const wait = pairWait(model, i);
        if (wait > 0) {
          soonest = Math.min(soonest, wait);
          continue;
        }
        if (Date.now() >= deadline) {
          stats.fail++;
          throw new AiBusyError("AI is taking too long right now. Please try again.", { retryAfterSec: 15, attempts });
        }

        let useThinking = true;
        for (let tries = 0; tries < 2; tries++) {
          const remaining = deadline - Date.now();
          const t0 = Date.now();
          try {
            const res = await fetch(`${baseUrl()}/models/${model}:generateContent`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": keys[i] },
              body: JSON.stringify(buildBody(model, o, useThinking)),
              signal: AbortSignal.timeout(Math.max(1000, Math.min(attemptTimeoutMs, remaining))),
            });

            if (!res.ok) {
              let body = null;
              try { body = await res.json(); } catch { /* non-JSON error page */ }
              const d = classifyFailure(res.status, body, res.headers);

              if (d.kind === "thinking" && useThinking) {
                noThinking.add(model); // remember, retry once without it
                useThinking = false;
                continue;
              }
              attempts.push({ model, key: i, status: res.status, kind: d.kind, ms: Date.now() - t0 });

              if (d.kind === "badRequest") {
                // Our prompt/config is wrong — other models will say the same.
                stats.fail++;
                throw new GeminiError(`Gemini rejected the request: ${d.msg}`, { status: res.status, kind: "badRequest" });
              }
              if (d.scope === "key") keyState.set(i, { until: Date.now() + d.cooldown, reason: d.kind });
              else coolPair(model, i, d.cooldown, d.kind);
              console.warn(`[gemini] ${model} key#${i} → ${res.status} ${d.kind}; cooling ${Math.round(d.cooldown / 1000)}s`);
              break; // next key / model
            }

            const data = await res.json();
            const { text, finishReason, blockReason } = extractText(data);

            if (blockReason || (!text && finishReason === "SAFETY")) {
              stats.fail++;
              throw new AiBlockedError("That request couldn't be processed. Try rephrasing it.");
            }
            if (!text.trim()) {
              // MAX_TOKENS while "thinking", RECITATION, or an empty candidate.
              attempts.push({ model, key: i, status: 200, kind: `empty:${finishReason || "none"}`, ms: Date.now() - t0 });
              coolPair(model, i, 5_000, "empty");
              break;
            }

            stats.ok++;
            stats.byModel[model] = (stats.byModel[model] || 0) + 1;
            attempts.push({ model, key: i, status: 200, kind: "ok", ms: Date.now() - t0 });
            console.log(`[gemini] ok ${model} key#${i} ${Date.now() - t0}ms (tries: ${attempts.length}, total ${Date.now() - startedAt}ms)`);
            return { text, model, keyIndex: i, finishReason, attempts };
          } catch (err) {
            if (err instanceof AiBlockedError || err instanceof GeminiError) throw err;
            const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
            attempts.push({ model, key: i, status: 0, kind: timedOut ? "timeout" : "network", ms: Date.now() - t0 });
            coolPair(model, i, COOLDOWN.overload, timedOut ? "timeout" : "network");
            console.warn(`[gemini] ${model} key#${i} → ${timedOut ? "timeout" : "network error"}: ${err?.message}`);
            break;
          }
        }
      }
    }

    // Everything is cooling down. A short cooldown is worth waiting for.
    const budget = deadline - Date.now();
    if (soonest !== Infinity && soonest <= Math.min(8_000, budget - 1_000) && pass === 0) {
      await sleep(soonest + 50);
      continue;
    }
    break;
  }

  stats.fail++;
  const allWaits = models.flatMap((m) => keys.map((_, i) => pairWait(m, i))).filter((w) => w > 0);
  const retryAfterSec = allWaits.length ? Math.max(5, Math.ceil(Math.min(...allWaits) / 1000)) : 30;
  throw new AiBusyError("The AI is very busy right now. Please try again in a minute.", { retryAfterSec, attempts });
}

/**
 * Streaming variant: `for await (const chunk of generateStream({...}))`.
 * Failover happens only BEFORE the first chunk arrives — once text has been
 * sent to the learner we cannot silently switch models, so a mid-answer drop
 * is thrown to the caller.
 * Closing the iterator (client disconnected) aborts the upstream request.
 */
export async function* generateStream(opts = {}) {
  const keys = loadKeys();
  if (!keys.length) {
    throw new GeminiError("No Gemini API key configured. Set GEMINI_API_KEYS on the server.", { kind: "noKey" });
  }
  const models = loadModels();
  const o = {
    system: opts.system,
    messages: opts.messages?.length ? opts.messages : [{ role: "user", content: opts.prompt ?? "" }],
    temperature: opts.temperature ?? 0.7,
    maxTokens: opts.maxTokens ?? 2048,
    json: false,
  };
  const connectMs = opts.connectTimeoutMs ?? 25_000;
  const idleMs = opts.idleTimeoutMs ?? 30_000;
  const deadline = Date.now() + (opts.totalConnectMs ?? 45_000);
  const startedAt = Date.now();
  stats.calls++;

  for (let pass = 0; pass < 2; pass++) {
    let soonest = Infinity;
    for (const model of models) {
      for (let i = 0; i < keys.length; i++) {
        const wait = pairWait(model, i);
        if (wait > 0) { soonest = Math.min(soonest, wait); continue; }
        if (Date.now() >= deadline) {
          stats.fail++;
          throw new AiBusyError("AI is taking too long right now. Please try again.", { retryAfterSec: 15 });
        }

        let useThinking = true;
        for (let tries = 0; tries < 2; tries++) {
          const ctrl = new AbortController();
          let timer = setTimeout(() => ctrl.abort(), connectMs);
          let gotText = false;
          let blocked = false;
          try {
            let res;
            try {
              res = await fetch(`${baseUrl()}/models/${model}:streamGenerateContent?alt=sse`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": keys[i] },
                body: JSON.stringify(buildBody(model, o, useThinking)),
                signal: ctrl.signal,
              });
            } catch (err) {
              coolPair(model, i, COOLDOWN.overload, "network");
              console.warn(`[gemini] stream ${model} key#${i} -> ${err?.name === "AbortError" ? "timeout" : "network error"}`);
              break;
            }

            if (!res.ok) {
              let body = null;
              try { body = await res.json(); } catch { /* non-JSON */ }
              const d = classifyFailure(res.status, body, res.headers);
              if (d.kind === "thinking" && useThinking) { noThinking.add(model); useThinking = false; continue; }
              if (d.kind === "badRequest") {
                stats.fail++;
                throw new GeminiError(`Gemini rejected the request: ${d.msg}`, { status: res.status, kind: "badRequest" });
              }
              if (d.scope === "key") keyState.set(i, { until: Date.now() + d.cooldown, reason: d.kind });
              else coolPair(model, i, d.cooldown, d.kind);
              console.warn(`[gemini] stream ${model} key#${i} -> ${res.status} ${d.kind}; cooling ${Math.round(d.cooldown / 1000)}s`);
              break;
            }

            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), idleMs); };
            arm();
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                arm();
                buf += dec.decode(value, { stream: true });
                let nl;
                while ((nl = buf.indexOf("\n")) >= 0) {
                  const line = buf.slice(0, nl).trim();
                  buf = buf.slice(nl + 1);
                  if (!line.startsWith("data:")) continue;
                  const payload = line.slice(5).trim();
                  if (!payload || payload === "[DONE]") continue;
                  let data;
                  try { data = JSON.parse(payload); } catch { continue; }
                  if (data?.promptFeedback?.blockReason) { blocked = true; break; }
                  const { text } = extractText(data);
                  if (text) {
                    gotText = true;
                    yield text;
                  }
                }
                if (blocked) break;
              }
            } catch (err) {
              if (gotText || err instanceof GeminiError) throw err; // can't switch mid-answer
              coolPair(model, i, COOLDOWN.overload, "stream");
              break;
            }

            if (blocked) { stats.fail++; throw new AiBlockedError("That request couldn't be processed. Try rephrasing it."); }
            if (gotText) {
              stats.ok++;
              stats.byModel[model] = (stats.byModel[model] || 0) + 1;
              console.log(`[gemini] ok(stream) ${model} key#${i} total ${Date.now() - startedAt}ms`);
              opts.onModel?.(model);
              return;
            }
            coolPair(model, i, 5_000, "empty"); // empty stream -> next model
            break;
          } finally {
            clearTimeout(timer);
            ctrl.abort(); // no-op if finished; stops upstream if the consumer left early
          }
        }
      }
    }
    const budget = deadline - Date.now();
    if (soonest !== Infinity && soonest <= Math.min(8_000, budget - 1_000) && pass === 0) {
      await sleep(soonest + 50);
      continue;
    }
    break;
  }

  stats.fail++;
  const waits = models.flatMap((m) => keys.map((_, i) => pairWait(m, i))).filter((w) => w > 0);
  const retryAfterSec = waits.length ? Math.max(5, Math.ceil(Math.min(...waits) / 1000)) : 30;
  throw new AiBusyError("The AI is very busy right now. Please try again in a minute.", { retryAfterSec });
}

/** Convenience: returns just the text. */
export async function generateText(prompt, opts = {}) {
  return (await generate({ ...opts, prompt })).text;
}
