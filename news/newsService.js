import fetch from "node-fetch";

const BASE_URL = "https://newsapi.org/v2/everything";

// ---------------- CACHE CONFIG ----------------
// In-memory cache (equivalent to the original file-based cache: both reset
// on a process restart on ephemeral hosts like Render, so no behavior is lost).
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let cache = { timestamp: 0, data: null };

// ---------------- STRICT TECH KEYWORDS ----------------
const ALLOWED_KEYWORDS = [
  "artificial intelligence",
  "ai ",
  "machine learning",
  "deep learning",
  "openai",
  "chatgpt",
  "google ai",
  "microsoft ai",
  "software",
  "developer",
  "programming",
  "cloud",
  "saas",
  "startup",
  "cybersecurity",
  "data science",
];

// ---------------- CACHE HELPERS ----------------
function loadCache() {
  if (!cache.data) return null;
  if (Date.now() - cache.timestamp > CACHE_TTL_MS) return null;
  return cache.data;
}

function saveCache(data) {
  cache = { timestamp: Date.now(), data };
}

// ---------------- FILTER LOGIC ----------------
function isStrictlyTechnical(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  return ALLOWED_KEYWORDS.some((keyword) => text.includes(keyword));
}

// ---------------- MAIN FETCH ----------------
export async function fetchTechNews() {
  const NEWS_API_KEY = process.env.NEWS_API_KEY;

  if (!NEWS_API_KEY) return [];

  // 1. Try cache first
  const cached = loadCache();
  if (cached) return cached;

  const params = new URLSearchParams({
    q: "artificial intelligence OR AI OR machine learning OR OpenAI OR ChatGPT OR software OR cloud OR startup",
    domains:
      "techcrunch.com,theverge.com,wired.com,thenextweb.com,arstechnica.com,venturebeat.com,zdnet.com",
    language: "en",
    sortBy: "publishedAt",
    pageSize: "20",
    apiKey: NEWS_API_KEY,
  });

  const res = await fetch(`${BASE_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`NewsAPI HTTP ${res.status}: ${errorText}`);
  }

  const body = await res.json();
  const rawArticles = body.articles || [];

  const filteredArticles = [];

  for (const item of rawArticles) {
    const title = item.title || "";
    const description = item.description || "";

    // HARD FILTER — no tech, no entry
    if (!isStrictlyTechnical(title, description)) continue;

    filteredArticles.push({
      title,
      summary: description,
      source: item.source?.name ?? null,
      url: item.url ?? null,
      publishedAt: item.publishedAt ?? null,
    });
  }

  // 2. Save cache
  saveCache(filteredArticles);

  return filteredArticles;
}
