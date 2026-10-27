/**
 * middleware/rateLimit.js
 * Tiny in-memory sliding-window limiter (no extra dependency).
 * Protects the shared free Gemini quota from one user (or script) using it all.
 */

export function rateLimit({ windowMs = 10 * 60_000, max = 15, keyFn, message } = {}) {
  const hits = new Map(); // key → number[] (timestamps)

  // Sweep idle keys so the map can't grow forever.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      if (!arr.length || arr[arr.length - 1] < cutoff) hits.delete(k);
    }
  }, Math.max(30_000, windowMs / 2));
  sweep.unref?.();

  return function limiter(req, res, next) {
    const key = (keyFn ? keyFn(req) : req.uid || req.ip) || "anon";
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => t > now - windowMs);

    if (arr.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: message || "You're going a little fast — please wait a moment and try again.",
        retryAfterSec: retryAfter,
      });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}
