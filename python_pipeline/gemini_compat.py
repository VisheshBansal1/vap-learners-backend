#!/usr/bin/env python3
"""
python_pipeline/gemini_compat.py
────────────────────────────────
Drop-in replacement for the `groq` Python package, backed by Gemini.

Your video pipeline (vavina_learner_video_generator/script/groq_script.py) does
something like:

    from groq import Groq
    client = Groq(api_key=...)
    client.chat.completions.create(model=..., messages=[...], temperature=..., max_tokens=...)

`install_as_groq()` registers THIS module as `groq`, so that file keeps working
WITHOUT edits — but every call now goes through the Gemini model waterfall:
models are tried best → lightest; on 429 / 503 / 404 / bad key the (model, key)
pair is put on a cooldown and the next one is used.

Only the standard library is used (no new pip packages).

ENV: GEMINI_API_KEYS (comma list) | GEMINI_API_KEY | GEMINI_MODELS | GEMINI_BASE_URL
"""

import json
import os
import re
import sys
import time
import types
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

DEFAULT_MODELS = [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
]

HOUR = 3600
COOLDOWN = dict(overload=15, rate_default=20, rate_min=5, rate_max=120,
                daily_cap=6 * HOUR, model_gone=6 * HOUR, bad_key=24 * HOUR)

# ── exceptions (names match the groq package so `except groq.X` keeps working) ──

class APIError(Exception):
    pass

class APIStatusError(APIError):
    def __init__(self, message, status_code=0):
        super().__init__(message)
        self.status_code = status_code

class RateLimitError(APIStatusError):
    pass

class APIConnectionError(APIError):
    pass

class AuthenticationError(APIStatusError):
    pass

class BadRequestError(APIStatusError):
    pass

# ── config / state ─────────────────────────────────────────────────────────────

def _split(v):
    return [s for s in re.split(r"[\s,;]+", v or "") if s]

def load_keys():
    raw = (_split(os.environ.get("GEMINI_API_KEYS")) + _split(os.environ.get("GEMINI_API_KEY"))
           + _split(os.environ.get("NOTES_MAKER_API")) + _split(os.environ.get("GROQ_API_KEY")))
    keys = []
    for k in raw:
        if k.startswith("gsk_") or k == "served-by-gemini":   # Groq key / our own placeholder
            continue
        if k not in keys:
            keys.append(k)
    return keys

def load_models():
    return _split(os.environ.get("GEMINI_MODELS")) or DEFAULT_MODELS

def base_url():
    return os.environ.get("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")

_pair_until = {}     # (model, key_idx) -> epoch seconds
_key_until = {}      # key_idx -> epoch seconds
_no_thinking = set()

def reset_state():
    _pair_until.clear(); _key_until.clear(); _no_thinking.clear()

def _wait(model, i):
    now = time.time()
    return max(0, _key_until.get(i, 0) - now, _pair_until.get((model, i), 0) - now)

def seconds_until_pacific_midnight():
    # Free-tier daily quotas reset at midnight Pacific. PDT (-7) from 2nd Sun Mar → 1st Sun Nov.
    now = datetime.now(timezone.utc)
    def nth_sunday(year, month, n):
        d = datetime(year, month, 1, tzinfo=timezone.utc)
        d += timedelta(days=(6 - d.weekday()) % 7)
        return d + timedelta(weeks=n - 1)
    start = nth_sunday(now.year, 3, 2).replace(hour=10)   # 2am PST = 10:00 UTC
    end = nth_sunday(now.year, 11, 1).replace(hour=9)     # 2am PDT = 09:00 UTC
    offset = -7 if start <= now < end else -8
    local = now + timedelta(hours=offset)
    nxt = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(60, (nxt - local).total_seconds())

def _classify(status, body):
    err = (body or {}).get("error", {}) if isinstance(body, dict) else {}
    msg = err.get("message") or f"HTTP {status}"
    low = msg.lower()
    blob = json.dumps(err.get("details", "")) + msg
    if status == 429:
        if re.search(r"PerDay|per day|RequestsPerDay|daily", blob, re.I):
            return "daily", min(seconds_until_pacific_midnight(), COOLDOWN["daily_cap"]), "pair", msg
        delay = None
        for d in err.get("details", []) or []:
            if isinstance(d, dict) and isinstance(d.get("retryDelay"), str):
                try: delay = float(d["retryDelay"].rstrip("s"))
                except ValueError: pass
        delay = COOLDOWN["rate_default"] if delay is None else delay
        return "rate", min(max(delay, COOLDOWN["rate_min"]), COOLDOWN["rate_max"]), "pair", msg
    if status in (500, 502, 503, 504):
        return "overload", COOLDOWN["overload"], "pair", msg
    if status == 404:
        return "model_gone", COOLDOWN["model_gone"], "pair", msg
    if status == 401 or (status == 400 and re.search(r"api key not valid|api_key_invalid|invalid api key", low)):
        return "bad_key", COOLDOWN["bad_key"], "key", msg
    if status == 403:
        if re.search(r"api key|consumer|suspended|denied access|blocked|billing", low) and "model" not in low:
            return "bad_key", COOLDOWN["bad_key"], "key", msg
        return "model_gone", COOLDOWN["model_gone"], "pair", msg
    if status == 400 and "thinking" in low:
        return "thinking", 0, "none", msg
    return "bad_request", 0, "none", msg

# ── core call ──────────────────────────────────────────────────────────────────

def _contents(messages):
    system, out = [], []
    for m in messages:
        text = str(m.get("content") or "").strip()
        if not text:
            continue
        role = m.get("role")
        if role == "system":
            system.append(text); continue
        role = "user" if role == "user" else "model"
        if out and out[-1]["role"] == role:
            out[-1]["parts"][0]["text"] += "\n\n" + text
        else:
            out.append({"role": role, "parts": [{"text": text}]})
    while out and out[0]["role"] != "user":
        out.pop(0)
    return "\n\n".join(system), out

def _body(model, messages, temperature, max_tokens, json_mode, use_thinking):
    system, contents = _contents(messages)
    gc = {"maxOutputTokens": (max_tokens or 1024) + 2048}   # thinking tokens share this budget
    if temperature is not None:
        gc["temperature"] = temperature
    if json_mode:
        gc["responseMimeType"] = "application/json"
    if use_thinking and model.startswith("gemini-3") and model not in _no_thinking:
        gc["thinkingConfig"] = {"thinkingLevel": "low"}
    body = {"contents": contents, "generationConfig": gc}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    return body

def _post(model, key, body, timeout):
    req = urllib.request.Request(
        f"{base_url()}/models/{model}:generateContent",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: payload = json.loads(e.read().decode())
        except Exception: payload = None
        return e.code, payload

def generate(messages, temperature=0.4, max_tokens=1024, json_mode=False,
             attempt_timeout=60, total_timeout=150):
    keys, models = load_keys(), load_models()
    if not keys:
        raise AuthenticationError("No Gemini API key configured — set GEMINI_API_KEYS.", 401)
    deadline = time.time() + total_timeout
    last = "no attempt made"

    for pass_no in range(2):
        soonest = float("inf")
        for model in models:
            for i, key in enumerate(keys):
                w = _wait(model, i)
                if w > 0:
                    soonest = min(soonest, w); continue
                if time.time() >= deadline:
                    raise RateLimitError(f"AI timed out. Last error: {last}", 429)
                use_thinking = True
                for _ in range(2):
                    try:
                        status, data = _post(model, key,
                            _body(model, messages, temperature, max_tokens, json_mode, use_thinking),
                            max(5, min(attempt_timeout, deadline - time.time())))
                    except Exception as e:      # timeout / DNS / reset
                        _pair_until[(model, i)] = time.time() + COOLDOWN["overload"]
                        last = f"{model}: {type(e).__name__}"
                        print(f"[gemini] {last}", file=sys.stderr); break
                    if status == 200:
                        cand = ((data or {}).get("candidates") or [{}])[0]
                        parts = (cand.get("content") or {}).get("parts") or []
                        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
                        if (data or {}).get("promptFeedback", {}).get("blockReason"):
                            raise BadRequestError("Prompt was blocked by safety filters.", 400)
                        if text.strip():
                            return text, model
                        _pair_until[(model, i)] = time.time() + 5
                        last = f"{model}: empty ({cand.get('finishReason')})"; break
                    kind, cd, scope, msg = _classify(status, data)
                    last = f"{model}: {status} {kind}"
                    if kind == "thinking" and use_thinking:
                        _no_thinking.add(model); use_thinking = False; continue
                    if kind == "bad_request":
                        raise BadRequestError(f"Gemini rejected the request: {msg}", status)
                    if scope == "key": _key_until[i] = time.time() + cd
                    else: _pair_until[(model, i)] = time.time() + cd
                    print(f"[gemini] {model} key#{i} → {status} {kind}; cooling {int(cd)}s", file=sys.stderr)
                    break
        budget = deadline - time.time()
        if pass_no == 0 and soonest != float("inf") and soonest <= min(8, budget - 1):
            time.sleep(soonest + 0.05); continue
        break
    raise RateLimitError(f"All Gemini models are busy. Last error: {last}", 429)

# ── Groq-compatible surface ────────────────────────────────────────────────────

class _NS(types.SimpleNamespace):
    pass

def _response(text, model):
    return _NS(model=model, choices=[_NS(index=0, finish_reason="stop",
               message=_NS(role="assistant", content=text))])

class _Completions:
    def create(self, model=None, messages=None, temperature=None, max_tokens=None,
               response_format=None, stream=False, **_ignored):
        json_mode = isinstance(response_format, dict) and response_format.get("type") == "json_object"
        text, used = generate(messages or [], temperature=0.4 if temperature is None else temperature,
                              max_tokens=max_tokens or 1024, json_mode=json_mode)
        if stream:   # callers that stream just get everything as one chunk
            chunk = _NS(model=used, choices=[_NS(index=0, finish_reason="stop",
                        delta=_NS(role="assistant", content=text))])
            return iter([chunk])
        return _response(text, used)

class _Chat:
    def __init__(self):
        self.completions = _Completions()

class Groq:
    """Accepts (and ignores) the usual Groq constructor arguments."""
    def __init__(self, api_key=None, **_ignored):
        self.chat = _Chat()

AsyncGroq = Groq

def install_as_groq():
    """Make `import groq` / `from groq import Groq` resolve to this module."""
    sys.modules["groq"] = sys.modules[__name__]
    if not os.environ.get("GROQ_API_KEY"):   # some scripts assert the variable exists
        os.environ["GROQ_API_KEY"] = "served-by-gemini"
