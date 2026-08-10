/**
 * chime.js — a sound when a reply finishes.
 *
 * THE OWNER, 2026-08-09: "when you are in a long reply, I go and do some
 * exercise, so I want to come back as soon as you are done."
 *
 * SYNTHESISED, NOT A FILE. An audio asset is a request that can 404, a byte
 * range that can fail to decode, and one more thing to keep in the repo — for
 * two notes. WebAudio makes them from nothing, so the sound cannot be missing.
 *
 * IT PLAYS ON `result`, WHICH IS THE RUN ENDING — not on the last text delta.
 * A reply can stream its final paragraph and then spend a minute on tool calls,
 * and a chime at the wrong end of that is worse than none: it teaches you to
 * come back and wait.
 *
 * MUTED BY A KEY YOU CAN SET, because a sound nobody can turn off is a sound
 * that gets the whole page muted instead:  localStorage.chime = 'off'
 */

const KEY = 'chime';

export function muted() {
  try { return localStorage.getItem(KEY) === 'off'; } catch { return false; }
}

export function setMuted(off) {
  try { localStorage.setItem(KEY, off ? 'off' : 'on'); } catch { /* private mode */ }
}

/**
 * Two short notes, rising. Rising because it means "done" rather than
 * "something is wrong" — a falling pair reads as an error in every interface
 * that has ever used one.
 */
export function chime() {
  if (muted()) return;
  let audio;
  try {
    audio = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return;                    // no audio on this device is not this page's problem
  }
  // A page that has never been interacted with cannot play sound; by the time
  // a reply has finished, the owner has typed, so the context is unlocked.
  if (audio.state === 'suspended') audio.resume?.();

  const at = audio.currentTime;
  for (const [i, hz] of [660, 880].entries()) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    // Shaped, not switched: a square edge on a sine is a click, and the click
    // is the part that makes a notification sound cheap.
    const start = at + i * 0.13;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
    osc.connect(gain).connect(audio.destination);
    osc.start(start);
    osc.stop(start + 0.24);
  }
  setTimeout(() => audio.close?.(), 900);
}
