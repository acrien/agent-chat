/**
 * splitter.js — the handle between the transcript and the heartbeat panel.
 */
import { els } from './dom.js';

// --- the splitter ----------------------------------------------------------

/**
 * Drag the handle to resize; double-click to reset.
 *
 * The width lives on `.split` as a custom property and in localStorage, so it
 * is one number in one place. Stored in pixels rather than a fraction: a panel
 * is sized for the text in it, and a fraction would resize it every time the
 * window changed. Pointer events cover mouse, touch and pen with one path, and
 * `setPointerCapture` keeps the drag alive when the pointer outruns the handle.
 */
const BEAT_MIN = 200;
const BEAT_DEFAULT = '20rem';

export function setBeatWidth(px) {
  const most = Math.max(BEAT_MIN, window.innerWidth - 320);
  const width = Math.round(Math.min(Math.max(px, BEAT_MIN), most));
  els.split.style.setProperty('--beat-w', `${width}px`);
  try { localStorage.setItem('beatWidth', String(width)); } catch { /* private mode */ }
}

els.grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  els.grip.setPointerCapture(e.pointerId);
  els.grip.classList.add('dragging');
  document.body.classList.add('resizing');
});

els.grip.addEventListener('pointermove', (e) => {
  if (!els.grip.hasPointerCapture(e.pointerId)) return;
  // Measured from the right edge of the split, so the panel tracks the pointer
  // exactly rather than drifting by the handle's own width.
  setBeatWidth(els.split.getBoundingClientRect().right - e.clientX);
});

for (const done of ['pointerup', 'pointercancel']) {
  els.grip.addEventListener(done, (e) => {
    els.grip.releasePointerCapture?.(e.pointerId);
    els.grip.classList.remove('dragging');
    document.body.classList.remove('resizing');
  });
}

els.grip.addEventListener('dblclick', () => {
  els.split.style.setProperty('--beat-w', BEAT_DEFAULT);
  try { localStorage.removeItem('beatWidth'); } catch { /* private mode */ }
});

try {
  const saved = Number(localStorage.getItem('beatWidth'));
  if (saved > 0) setBeatWidth(saved);
} catch { /* private mode: the default stands */ }

