/**
 * video/supabaseHelper.js
 * ───────────────────────
 * Thin REST wrapper for Supabase Storage DELETE.
 * Uploads are handled by the Python pipeline directly.
 * We use raw fetch here to avoid adding supabase-js to Node deps.
 */

import fetch from "node-fetch";

function headers() {
  return {
    apikey:         process.env.SUPABASE_KEY,
    Authorization:  `Bearer ${process.env.SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Delete a file from Supabase Storage.
 * @param {string} filePath  e.g. "uid/videoId.mp4"
 * @param {string} bucket    "videos" | "thumbnails"
 */
export async function supabaseDelete(filePath, bucket) {
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/${bucket}/${filePath}`;
  try {
    const res = await fetch(url, { method: "DELETE", headers: headers() });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`Supabase DELETE ${bucket}/${filePath} → ${res.status}: ${body}`);
    }
  } catch (e) {
    console.warn(`Supabase DELETE failed ${bucket}/${filePath}:`, e.message);
  }
}
