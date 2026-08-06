const notesDB = {};

export function getNotes(noteId) {
  return notesDB[noteId] || { noteId, sections: [] };
}

export function appendSection(noteId, section) {
  if (!notesDB[noteId]) {
    notesDB[noteId] = { noteId, sections: [] };
  }
  notesDB[noteId].sections.push(section);
}
