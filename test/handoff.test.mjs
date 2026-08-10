/**
 * Does a handoff survive the process, and does it only ever arrive once?
 *
 * THE FAILURE THIS COVERS is not hypothetical. On 2026-08-10 a restart into a
 * fresh session left the successor with no context at all: the note existed
 * only in the memory of the process being killed, and the copy written by hand
 * went into a file nothing reads. The fix parks the note on disk — which
 * introduces the opposite failure, a note that is delivered on every boot, and
 * a crash loop then pays for the same handoff turn forever.
 *
 * Both halves are the take-once rule, so both halves are checked here.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as store from '../state.mjs';

const fails = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    fails.push(name);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
};

/** A user directory that is not this machine's. */
function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
}

check('a parked handoff comes back with its text', () => {
  const dir = scratch();
  store.parkHandoff(dir, 'what is in flight: nothing', 'restart');
  const taken = store.takeHandoff(dir);
  assert.equal(taken?.text, 'what is in flight: nothing');
  assert.equal(taken.why, 'restart');
});

check('parking a handoff drops the session id', () => {
  const dir = scratch();
  store.write(dir, { sessionId: 'abc-123', model: 'claude-opus-5' });
  store.parkHandoff(dir, 'a note');
  const state = store.read(dir);
  assert.equal(state.sessionId, null, 'a resumed session would be told its history twice');
  assert.equal(state.model, 'claude-opus-5', 'the rest of the state is not collateral');
});

check('a handoff is taken once and once only', () => {
  const dir = scratch();
  store.parkHandoff(dir, 'a note');
  assert.equal(store.takeHandoff(dir)?.text, 'a note');
  assert.equal(store.takeHandoff(dir), null, 'a second boot would re-run the handoff turn');
});

check('an empty handoff is taken and not delivered', () => {
  const dir = scratch();
  store.parkHandoff(dir, '   ');
  assert.equal(store.takeHandoff(dir), null, 'nothing to deliver');
  assert.equal(store.read(dir).handoff, null, 'left parked, it would be retried every boot');
});

check('no handoff parked is not an error', () => {
  const dir = scratch();
  assert.equal(store.takeHandoff(dir), null);
  assert.equal(store.takeHandoff(scratch()), null, 'a directory with no state file at all');
});

check('a torn state file loses the handoff rather than the server', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'state.json'), '{"handoff": {"text": "half a n');
  assert.equal(store.takeHandoff(dir), null);
});

check('the state file is replaced, never truncated in place', () => {
  const dir = scratch();
  store.write(dir, { model: 'a' });
  const before = fs.statSync(path.join(dir, 'state.json')).ino;
  store.write(dir, { model: 'b' });
  const after = fs.statSync(path.join(dir, 'state.json')).ino;
  assert.notEqual(before, after, 'same inode means it was written in place — a crash mid-write loses it all');
});

console.log(fails.length ? `\n${fails.length} failed: ${fails.join(', ')}` : '\nhandoff: all ok');
process.exit(fails.length ? 1 : 0);
