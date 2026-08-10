/**
 * What a user's session is, written down — and the one part of it that has to
 * outlive the process.
 *
 * WHY THIS IS ITS OWN MODULE. The handoff used to live entirely in memory: the
 * session being cleared wrote the note, and the same process seeded the new
 * session with it. That works for `/clear`, where nothing dies. It cannot work
 * for a RESTART, because the process holding the note is the process being
 * killed — measured here on 2026-08-10, when a restart into a fresh session
 * left the successor with nothing at all and the note was hand-written into a
 * file that nothing on this side reads.
 *
 * So the note goes through the disk, and the take-once rule that makes that
 * safe lives beside the write rather than at the call site.
 */

import fs from 'node:fs';
import path from 'node:path';

function file(dir) {
  return path.join(dir, 'state.json');
}

export function read(dir) {
  try {
    return JSON.parse(fs.readFileSync(file(dir), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Everything this user chose, written so a crash cannot lose it.
 *
 * WRITTEN BESIDE AND RENAMED, NEVER IN PLACE. `writeFileSync` truncates the
 * file and then fills it; a crash, an OOM kill or a power cut in that window
 * leaves a partial file, and `read` treats unparseable JSON as "no state" — so
 * the failure is not a corrupt settings file, it is a SILENT reset of the
 * model, the effort, the working directory and the SDK session id. The agent
 * would come back with no memory of the conversation and nothing would say why.
 * A rename is atomic on POSIX: a reader sees the old file or the new one.
 *
 * fsync before the rename, because rename ordering guarantees nothing about the
 * CONTENT reaching the disk — without it the rename can land and the bytes can
 * not, which is the same empty file by a longer route.
 */
export function write(dir, patch) {
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...read(dir), ...patch };
  const target = file(dir);
  const temporary = `${target}.tmp`;
  const handle = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(handle, JSON.stringify(next, null, 2));
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, target);
  return next;
}

/**
 * Park a handoff for the process that comes next. Nothing else reads it.
 *
 * THE SESSION ID IS CLEARED IN THE SAME WRITE, and that is not tidiness: a
 * successor that resumed the old session AND was handed a note would be told
 * its own history twice, once as memory and once as a summary of that memory.
 * The note exists because the memory is being dropped.
 */
export function parkHandoff(dir, text, why = '') {
  return write(dir, {
    sessionId: null,
    handoff: { text: String(text), at: Date.now(), why: String(why) },
  });
}

/**
 * The parked note, and it can only be taken once.
 *
 * CLEARED BEFORE IT IS RETURNED, which is the whole reason this is a function
 * and not two lines at the call site. The caller is a server booting up; if the
 * note were cleared after the turn it starts, a server that crashes during that
 * turn would hand the same note to the next boot, and a crash loop would then
 * pay for the same handoff turn forever. Losing a handoff to a crash costs one
 * note. Re-reading it on every boot costs a session each time and looks, from
 * the page, exactly like an agent that will not stop talking to itself.
 *
 * A NOTE WITH NO TEXT IS STILL TAKEN. Whatever wrote it is not going to write a
 * better one, and leaving it parked means retrying it on every boot — the same
 * loop, arrived at by way of being careful.
 */
export function takeHandoff(dir) {
  const parked = read(dir).handoff;
  if (!parked) return null;
  write(dir, { handoff: null });
  const text = typeof parked.text === 'string' ? parked.text.trim() : '';
  if (!text) return null;
  return { text, at: Number(parked.at) || 0, why: String(parked.why ?? '') };
}
