import fetch from "node-fetch";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export async function callGroq(prompt, options = {}) {
  const {
    maxTokens = 800,
    timeoutMs = 12_000,
  } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NOTES_MAKER_API}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "user", content: prompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });

    // HTTP errors (401, 429, 500, etc.)
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Groq HTTP ${res.status}: ${errorText}`);
    }

    const data = await res.json();

    // Invalid structure
    if (
      !data ||
      !Array.isArray(data.choices) ||
      data.choices.length === 0
    ) {
      throw new Error(
        data?.error?.message || "Groq response missing choices"
      );
    }

    const content = data.choices[0]?.message?.content;

    if (!content || typeof content !== "string") {
      throw new Error("Groq returned empty content");
    }

    return content;

  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Groq request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
