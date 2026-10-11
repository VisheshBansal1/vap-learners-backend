import admin from "firebase-admin";

let _db = null;

// ── Init (call once in index.js) ──────────────────────────────────────────────
export function initFirebase() {
  if (admin.apps.length > 0) return;

  const credJson = process.env.FIREBASE_CRED_JSON;
  if (!credJson) {
    console.warn("⚠️  FIREBASE_CRED_JSON not set — video endpoints will return 401");
    return;
  }

  try {
    const cred = JSON.parse(credJson);
    admin.initializeApp({ credential: admin.credential.cert(cred) });
    _db = admin.firestore();
    console.log("✓ Firebase Admin initialised");
  } catch (e) {
    console.error("✗ Firebase Admin init failed:", e.message);
  }
}

// ── Firestore accessor ────────────────────────────────────────────────────────
export function getDb() {
  if (!_db) throw new Error("Firestore not initialised — check FIREBASE_CRED_JSON");
  return _db;
}

// ── Express auth middleware ───────────────────────────────────────────────────
// Attaches req.uid; used on every /api/video route.
export async function verifyToken(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }
  const token = header.slice(7);
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: `Token invalid: ${e.message}` });
  }
}
