/**
 * boot.js — wiring and start-up. The only module that knows the others exist.
 */
import { $, el, els, notice, setBusy, transcript } from './dom.js';
import { addImages, clearPending } from './images.js';
import { handle } from './events.js';
import { fillEffort, labelDefaultEffort, loadModels, post, send } from './transport.js';
import { openSettings, drawJobList } from './jobs.js';
import './splitter.js';

// --- wiring ----------------------------------------------------------------

els.send.addEventListener('click', send);

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

els.input.addEventListener('input', () => {
  els.input.style.height = 'auto';
  els.input.style.height = `${els.input.scrollHeight}px`;
});

// Paste anywhere on the page, not just the textarea: an image never lands as
// text in the box, it goes to the tray.
document.addEventListener('paste', (e) => {
  const blobs = [...(e.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!blobs.length) return;
  e.preventDefault();
  addImages(blobs);
});

for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    if (type === 'drop') {
      addImages([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
    }
  });
}

// Same stale `pending` as send() had — it threw the moment `clear` was clicked.
els.clearImages.addEventListener('click', clearPending);

els.model.addEventListener('change', async () => {
  await post('/api/model', { model: els.model.value });
  fillEffort(els.model.value);
  await post('/api/effort', { effort: els.effort.value });
});

els.effort.addEventListener('change', () => post('/api/effort', { effort: els.effort.value }));
els.interrupt.addEventListener('click', () => post('/api/interrupt'));

els.cwd.addEventListener('click', async () => {
  const next = prompt('Working directory for this user:', els.cwd.textContent);
  if (!next || next === els.cwd.textContent) return;
  const res = await post('/api/cwd', { cwd: next });
  if (res.ok) els.cwd.textContent = (await res.json()).cwd;
});

els.user.addEventListener('click', async () => {
  if (!confirm('Sign out? Your history is kept.')) return;
  await post('/api/logout');
  location.reload();
});

// --- boot ------------------------------------------------------------------

async function signIn(name) {
  // Errors here must land INSIDE the gate. `notice()` writes to the
  // transcript, which sits behind this overlay — a failed sign-in would
  // report itself somewhere the user cannot see.
  const problem = els.gate.querySelector('.problem') ?? (() => {
    const node = el('p', 'problem');
    els.loginForm.append(node);
    return node;
  })();
  problem.textContent = '';

  let res;
  try {
    res = await post('/api/login', { user: name });
  } catch (err) {
    problem.textContent = `could not reach the server: ${err.message}`;
    return;
  }
  if (!res.ok) {
    problem.textContent = (await res.json().catch(() => ({}))).error ?? 'sign-in failed';
    return;
  }
  location.reload();
}

els.loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  signIn(els.loginName.value);
});

async function boot() {
  const me = await (await fetch('/api/me')).json();

  if (!me.user) {
    els.gate.hidden = false;
    els.loginName.focus();
    for (const name of me.users ?? []) {
      const button = el('button', 'linky', name);
      button.type = 'button';
      button.addEventListener('click', () => signIn(name));
      els.knownUsers.append(button);
    }
    return;
  }

  els.user.textContent = me.user;
  const stream = new EventSource('/api/events');
  stream.onmessage = (e) => handle(JSON.parse(e.data));
  stream.onerror = () => { els.dot.className = 'dot'; };

  loadModels().catch((err) => notice(`model list: ${err.message}`, true));
  els.input.focus();
}

boot();
