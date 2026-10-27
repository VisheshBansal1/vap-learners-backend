/**
 * notes/notesStore.js
 * Short-lived, BOUNDED in-memory history. It is only a fallback: the Flutter app
 * now sends `previousTopic` itself, so the server stays stateless-friendly
 * (Render free instances sleep and lose memory anyway).
 *
 * Limits keep the process from growing forever:
 *   • max 500 notes (least-recently-used evicted)
 *   • max 30 sections per note
 *   • 6 h idle expiry
 */

const MAX_NOTES = 500;
const MAX_SECTIONS = 30;
const TTL_MS = 6 * 60 * 60 * 1000;

const db = new Map(); // noteId → { noteId, sections, touched }

function evict() {
  const now = Date.now();
  for (const [id, n] of db) if (now - n.touched > TTL_MS) db.delete(id);
  while (db.size > MAX_NOTES) db.delete(db.keys().next().value); // oldest inserted/touched first
}

export function getNotes(noteId) {
  const n = db.get(noteId);
  if (!n) return { noteId, sections: [] };
  if (Date.now() - n.touched > TTL_MS) {
    db.delete(noteId);
    return { noteId, sections: [] };
  }
  return { noteId, sections: n.sections };
}

export function appendSection(noteId, section) {
  let n = db.get(noteId);
  if (!n) n = { noteId, sections: [], touched: 0 };
  n.sections.push(section);
  if (n.sections.length > MAX_SECTIONS) n.sections.splice(0, n.sections.length - MAX_SECTIONS);
  n.touched = Date.now();
  db.delete(noteId); // re-insert → becomes most-recently-used
  db.set(noteId, n);
  evict();
}
