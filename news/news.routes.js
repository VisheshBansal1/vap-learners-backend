import express from "express";
import { fetchTechNews } from "./newsService.js";

const router = express.Router();

// Mounted at /api/news -> full path GET /api/news/daily-tech-news
router.get("/daily-tech-news", async (req, res) => {
  try {
    const news = await fetchTechNews();

    return res.status(200).json({
      status: "success",
      count: news.length,
      news,
    });
  } catch (error) {
    console.error("❌ NEWS ERROR:", error.message);

    return res.status(500).json({
      error: "Failed to fetch tech news",
      details: error.message,
    });
  }
});

export default router;
