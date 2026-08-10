/**
 * transport.js — POSTs out, and the model/effort selectors they drive.
 */
import { el, els, notice } from './dom.js';
import { clearPending, pendingImages } from './images.js';

let models = [];

// --- transport -------------------------------------------------------------

export async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    notice(info.error ?? `${path} failed`, true);
  }
  return res;
}

let effortInForce = null;

/**
 * Say what "default" resolves to, rather than leaving it a blank.
 *
 * The level is only knowable once the SDK reports it — `supportedModels()`
 * lists which levels a model allows, not which is active, and the init
 * response carries none. So the label fills in after the first turn instead
 * of asserting a number nothing measured.
 */
export function labelDefaultEffort(level) {
  effortInForce = level ?? effortInForce;
  const fallback = els.effort.querySelector('option[value=""]');
  if (fallback) fallback.textContent = effortInForce ? `default (${effortInForce})` : 'default';
}

export function fillEffort(modelValue) {
  const info = models.find((m) => m.value === modelValue);
  const levels = info?.supportsEffort ? (info.supportedEffortLevels ?? []) : [];
  els.effort.textContent = '';
  const fallback = el('option', null, 'default');
  fallback.value = '';
  els.effort.append(fallback);
  labelDefaultEffort(null);
  for (const level of levels) {
    const option = el('option', null, level);
    option.value = level;
    els.effort.append(option);
  }
  // A model without effort support has nothing to choose.
  els.effort.disabled = levels.length === 0;
}

export async function loadModels() {
  const data = await (await fetch('/api/models')).json();
  models = data.models ?? [];
  els.model.textContent = '';
  for (const m of models) {
    // Name the model the row actually resolves to. "Default (recommended)"
    // does not tell you which LLM you are talking to; the resolved id does.
    const resolved = m.resolvedModel && m.resolvedModel !== m.value ? ` — ${m.resolvedModel}` : '';
    const option = el('option', null, `${m.displayName || m.value}${resolved}`);
    option.value = m.value;
    option.title = m.description ?? '';
    els.model.append(option);
  }
  if (data.current) els.model.value = data.current;
  fillEffort(els.model.value);
  if (data.effort) els.effort.value = data.effort;
  if (data.activeEffort) labelDefaultEffort(data.activeEffort);
}

export async function send() {
  // The tray is asked for, not reached into. It was a bare `pending` here
  // until 2026-08-09 — a module-level variable that survived the file split
  // as three references to a name this module no longer has. ES modules are
  // strict, so the first read threw ReferenceError and `send()` failed on
  // its opening line: Enter did nothing, and neither did the send button.
  const tray = pendingImages();
  const text = els.input.value.trim();
  if (!text && tray.length === 0) return;

  const images = tray.map(({ mediaType, data }) => ({ mediaType, data }));
  els.input.value = '';
  els.input.style.height = 'auto';
  clearPending();          // empties the tray and redraws it
  await post('/api/send', { text, images });
}

