/**
 * video/cloudinaryHelper.js
 * ─────────────────────────
 * Node.js side: only DELETE is needed here.
 * Uploads are done in Python (cloudinary Python SDK is richer for large files).
 * We use Cloudinary's Admin API (signed) for deletes.
 */

import fetch       from "node-fetch";
import crypto      from "crypto";

const CLOUD = () => process.env.CLOUDINARY_CLOUD_NAME;
const KEY   = () => process.env.CLOUDINARY_API_KEY;
const SEC   = () => process.env.CLOUDINARY_API_SECRET;

/**
 * Build a signed Cloudinary Admin API deletion request.
 * @param {string} publicId  e.g. "vavina/videos/uid_videoId"
 * @param {string} resourceType  "video" | "image"
 */
export async function cloudinaryDelete(publicId, resourceType = "video") {
  if (!CLOUD() || !KEY() || !SEC()) {
    console.warn("Cloudinary credentials missing — skipping delete");
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const toSign    = `public_id=${publicId}&timestamp=${timestamp}${SEC()}`;
  const signature = crypto.createHash("sha1").update(toSign).digest("hex");

  const body = new URLSearchParams({
    public_id:     publicId,
    timestamp,
    api_key:       KEY(),
    signature,
    resource_type: resourceType,
  });

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD()}/${resourceType}/destroy`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    body.toString(),
      }
    );
    const data = await res.json();
    if (data.result !== "ok" && data.result !== "not found") {
      console.warn(`Cloudinary delete ${publicId}:`, data);
    }
  } catch (e) {
    console.warn(`Cloudinary delete failed for ${publicId}:`, e.message);
  }
}

/**
 * Build the Cloudinary public_id for a video or thumbnail.
 * Pattern: vavina/videos/{uid}_{videoId}
 */
export function videoPublicId(uid, videoId)     { return `vavina/videos/${uid}_${videoId}`; }
export function thumbPublicId(uid, videoId)      { return `vavina/thumbnails/${uid}_${videoId}`; }

/**
 * Build the direct streaming URL from a public_id.
 * For videos: .mp4 delivery
 * For thumbnails: .jpg delivery
 */
export function cloudinaryVideoUrl(uid, videoId) {
  const pid = videoPublicId(uid, videoId);
  return `https://res.cloudinary.com/${CLOUD()}/video/upload/${pid}.mp4`;
}
export function cloudinaryThumbUrl(uid, videoId) {
  const pid = thumbPublicId(uid, videoId);
  return `https://res.cloudinary.com/${CLOUD()}/image/upload/${pid}.jpg`;
}
