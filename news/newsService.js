import fetch from "node-fetch";

const BASE_URL     = "https://newsapi.org/v2/everything";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let cache = { timestamp: 0, data: null };

const ALLOWED_KEYWORDS = [
  "artificial intelligence", "ai ", "machine learning", "deep learning",
  "openai", "chatgpt", "google ai", "microsoft ai", "software",
  "developer", "programming", "cloud", "saas", "startup",
  "cybersecurity", "data science",
];

function loadCache() {
  if (!cache.data) return null;
  if (Date.now() - cache.timestamp > CACHE_TTL_MS) return null;
  return cache.data;
}

function saveCache(data) {
  cache = { timestamp: Date.now(), data };
}

function isStrictlyTechnical(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  return ALLOWED_KEYWORDS.some((kw) => text.includes(kw));
}

export async function fetchTechNews() {
  const NEWS_API_KEY = process.env.NEWS_API_KEY;
  if (!NEWS_API_KEY) return [];

  const cached = loadCache();
  if (cached) return cached;

  const params = new URLSearchParams({
    q: "artificial intelligence OR AI OR machine learning OR OpenAI OR ChatGPT OR software OR cloud OR startup",
    domains: "techcrunch.com,theverge.com,wired.com,thenextweb.com,arstechnica.com,venturebeat.com,zdnet.com",
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

  const filteredArticles = rawArticles
    .filter((item) => isStrictlyTechnical(item.title || "", item.description || ""))
    .map((item) => ({
      title:       item.title || "",
      summary:     item.description || "",
      source:      item.source?.name ?? null,
      url:         item.url ?? null,
      publishedAt: item.publishedAt ?? null,
    }));

  saveCache(filteredArticles);
  return filteredArticles;
}
