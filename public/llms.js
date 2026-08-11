/**
 * llms.js — the config page, where a setting is a thing you can see.
 *
 * THE COMPLAINT THIS IS, 2026-08-11: "there's no way I know the setting of the
 * server if it differs from what I set in the config page."
 *
 * So every control here shows a REAL value. There is no `default` option — the
 * one the effort selector used to carry was the empty string, which stored
 * null, which let the CLI's own `xhigh` decide, which 400'd every turn on a
 * model with thinking off. A control offering "whatever someone else picks" is
 * the defect with a label on it.
 *
 * WHAT IS ILLEGAL IS NOT OFFERED. The row asks the server what is legal for
 * its current thinking and renders only that, so `xhigh` disappears the moment
 * thinking goes off rather than being accepted and rejected later. The server
 * refuses the same combination at the save — one verdict, two readers, which
 * is the rule the model menu already follows.
 *
 * A KEY IS NEVER IN THIS FILE. The input is masked, and "reuse the key from
 * that gateway" sends a NAME, not a secret: the copy happens on the server, so
 * nothing here ever holds a credential to leak.
 */

import { els, el, busy, notice } from './dom.js';

let rows = [];
let gateways = [];

async function load() {
  const data = await (await fetch('/api/llms')).json();
  rows = data.models ?? [];
  gateways = data.keys ?? [];
  return data;
}

async function save(model, patch) {
  const res = await fetch('/api/llms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, patch }),
  });
  const out = await res.json();
  if (!res.ok) {
    // THE SERVER'S OWN REASON, not a sentence written here that could drift
    // from it. It already names what would be legal.
    notice(out.error ?? 'the setting was refused', true);
    return null;
  }
  return out;
}

/**
 * A change that replaces the query is announced before it lands.
 *
 * THE OWNER, 2026-08-11: "change effort mid chat if it doesn't restart the
 * session context, if it does, throw a popup warning says continue or cancel."
 *
 * MEASURED, so the warning is aimed at what is actually at risk: `effort` is a
 * live control request and interrupts nothing. `thinking` and `cache` are
 * query() options, so they need a new query — which RESUMES the session id, so
 * the thread survives. What a new query costs is the answer being written right
 * now, and only when one is. So the question is asked when a turn is running,
 * not when "context would be lost" — context is not lost.
 */
function mayInterrupt(field) {
  if (!['thinking', 'cache', 'url'].includes(field)) return true;
  if (!busy) return true;
  return window.confirm(
    `A turn is running. Changing ${field} starts a new query and will interrupt `
    + `the answer being written. The conversation itself is kept.\n\nContinue?`,
  );
}

/** The reuse popup: recognise a key, never see one. */
function offerReuse(row, input) {
  const others = gateways.filter((g) => g.gateway !== row.key?.gateway);
  if (!others.length) return false;
  const list = others.map((g, i) => `${i + 1}. ${g.host}  (${g.fingerprint})`).join('\n');
  const pick = window.prompt(
    `Reuse a key you already saved?\n\n${list}\n\n`
    + 'Type the number to reuse it here, or Cancel to type a new key.',
  );
  const chosen = others[Number(pick) - 1];
  if (!chosen) return false;
  fetch('/api/llms/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: row.url, sameAs: chosen.gateway }),
  }).then(async (res) => {
    const out = await res.json();
    if (!res.ok) return notice(out.error ?? 'could not reuse that key', true);
    input.value = out.masked;
    notice(`key reused from ${chosen.host}`);
    draw();
  });
  return true;
}

function keyField(row) {
  const wrap = el('div', 'llmField');
  wrap.append(el('label', null, 'api key'));
  const input = el('input', 'llmKey');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  // MASKED WHETHER OR NOT ONE IS SET, so the field never says which gateways
  // have credentials to anyone reading over a shoulder.
  input.value = row.key ? row.key.masked : '';
  input.placeholder = row.key ? '••••••••' : 'paste a key, or reuse one';
  let offered = false;
  input.addEventListener('focus', () => {
    if (offered || !row.url) return;
    offered = true;
    if (offerReuse(row, input)) input.blur();
  });
  input.addEventListener('change', async () => {
    const value = input.value.trim();
    if (!value || value === row.key?.masked) return;
    const res = await fetch('/api/llms/key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: row.url, key: value }),
    });
    const out = await res.json();
    // SCRAMBLED THE MOMENT IT LANDS. The typed value is replaced with the mask
    // so it is not left sitting in the DOM, in a screenshot, or in a form
    // restore after a reload.
    input.value = out.masked ?? '••••••••';
    if (!res.ok) return notice(out.error ?? 'could not save that key', true);
    notice(`key saved for ${out.host}`);
    draw();
  });
  wrap.append(input);
  if (row.key) wrap.append(el('span', 'llmHint', `${row.key.host} · ${row.key.fingerprint}`));
  return wrap;
}

function choiceField(row, field, options, label) {
  const wrap = el('div', 'llmField');
  wrap.append(el('label', null, label));
  const select = el('select', 'llmChoice');
  for (const option of options) {
    const node = el('option', null, String(option));
    node.value = String(option);
    select.append(node);
  }
  select.value = String(row[field]);
  select.disabled = options.length <= 1;
  select.addEventListener('change', async () => {
    if (!mayInterrupt(field)) { select.value = String(row[field]); return; }
    const raw = select.value;
    const value = field === 'cache' ? raw === 'true' : raw;
    const saved = await save(row.model, { [field]: value });
    if (!saved) { select.value = String(row[field]); return; }
    await draw();
  });
  wrap.append(select);
  return wrap;
}

function textField(row, field, label, placeholder) {
  const wrap = el('div', 'llmField');
  wrap.append(el('label', null, label));
  const input = el('input', 'llmText');
  input.value = row[field] ?? '';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.addEventListener('change', async () => {
    if (!mayInterrupt(field)) { input.value = row[field] ?? ''; return; }
    const saved = await save(row.model, { [field]: input.value.trim() || null });
    if (saved) await draw();
  });
  wrap.append(input);
  return wrap;
}

function drawRow(row, current) {
  const card = el('div', `llmRow${row.model === current ? ' current' : ''}`);
  const head = el('div', 'llmHead');
  head.append(el('span', 'name', row.displayName));
  head.append(el('span', 'llmId', row.model));
  if (row.model === current) head.append(el('span', 'pill', 'in use'));
  head.append(el('span', 'llmVia', row.provider ?? row.url ?? ''));
  card.append(head);

  const grid = el('div', 'llmGrid');
  grid.append(textField(row, 'displayName', 'name', row.model));
  grid.append(textField(row, 'url', 'gateway url', 'blank = first-party (your own OAuth)'));
  grid.append(keyField(row));
  // EFFORT IS NARROWED BY THINKING, and the row was given the narrowed list by
  // the same function the save consults. An empty list means the provider has
  // no effort concept at all, and the control disables rather than offering a
  // level the gateway would reject.
  grid.append(choiceField(row, 'thinking', row.legal.thinking, 'thinking'));
  grid.append(choiceField(row, 'effort', row.legal.effort.length ? row.legal.effort : [row.effort], 'effort'));
  grid.append(choiceField(row, 'cache', row.legal.cache, 'prompt cache'));
  card.append(grid);

  if (row.legal.why?.effort) card.append(el('p', 'means', row.legal.why.effort));
  if (row.legal.why?.cache) card.append(el('p', 'means', row.legal.why.cache));
  if (!row.stored.length) {
    card.append(el('p', 'means', 'nothing saved for this model yet — these are resolved defaults, and saving one writes it down.'));
  }
  return card;
}

export async function draw() {
  const data = await load();
  const body = els.settingsBody;
  body.textContent = '';
  els.settingsTitle.textContent = 'llms';
  els.settingsLead.textContent =
    'One config per model. What is set here is what the turn uses — nothing is left for the CLI to choose. Keys live outside every repository and never reach this page.';

  for (const row of rows) body.append(drawRow(row, data.current));

  const add = el('button', 'pill', '+ add an llm');
  add.addEventListener('click', async () => {
    const name = window.prompt('model name, exactly as the gateway spells it');
    if (!name) return;
    const saved = await save(name.trim(), { displayName: '', url: null });
    if (saved) await draw();
  });
  body.append(add);
}

export function openLlms() {
  els.settings.hidden = false;
  draw();
}

// BOUND HERE, like `jobs.js` does with its own opener — the module that owns
// the page owns the control that opens it, so a page cannot be added without
// a way in, and `wiring.test.mjs` can prove the control exists.
els.llmsOpen.addEventListener('click', openLlms);
