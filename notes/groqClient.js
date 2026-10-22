import fetch from "node-fetch";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// FIXED: llama-3.3-70b-versatile does NOT exist on Groq free tier — returns 404.
// Correct free model names:
//   llama3-70b-8192      ← best quality FREE  ✅ use this
//   llama3-8b-8192       ← fastest FREE
//   mixtral-8x7b-32768   ← long context FREE
const MODEL = "llama3-70b-8192";

export async function callGroq(prompt, options = {}) {
  const { maxTokens = 800, timeoutMs = 20_000 } = options;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTES_MAKER_API}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model:       MODEL,
        messages:    [{ role: "user", content: prompt }],
        max_tokens:  maxTokens,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Groq HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (!data?.choices?.length) {
      throw new Error(data?.error?.message || "Groq: no choices returned");
    }

    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error("Groq returned empty content");
    return content;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("AI request timed out. Please try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
