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

/**
 * An in-page dialog, because a browser prompt is not this page.
 *
 * THE OWNER, 2026-08-11: "why is it a google popup not a web page popup?"
 * `window.prompt` is chrome the browser draws — it carries no styling, cannot
 * hold more than one field, and on a page that already owns an overlay it
 * reads as something the site did not mean to show. It was a stub, and a stub
 * that ships is a decision nobody made.
 *
 * Resolves with the field values, or null when dismissed. One field named
 * `_confirm` and it is a question rather than a form.
 */
function dialog({ title, lead, fields = [], ok = 'save', danger = false }) {
  return new Promise((resolve) => {
    const back = el('div', 'llmDialogBack');
    const card = el('div', `llmDialog${danger ? ' danger' : ''}`);
    card.append(el('h2', null, title));
    if (lead) card.append(el('p', 'means', lead));

    const inputs = new Map();
    for (const f of fields) {
      const wrap = el('div', 'llmField');
      wrap.append(el('label', null, f.label));
      let node;
      if (f.options) {
        node = el('select', 'llmChoice');
        for (const option of f.options) {
          const o = el('option', null, String(option.label ?? option));
          o.value = String(option.value ?? option);
          node.append(o);
        }
        if (f.value != null) node.value = String(f.value);
      } else {
        node = el('input', f.secret ? 'llmKey' : 'llmText');
        if (f.secret) node.type = 'password';
        node.value = f.value ?? '';
        node.placeholder = f.placeholder ?? '';
        node.spellcheck = false;
        node.autocomplete = 'off';
      }
      if (f.onInput) node.addEventListener('change', () => f.onInput(node.value, inputs));
      inputs.set(f.name, node);
      wrap.append(node);
      if (f.hint) wrap.append(el('span', 'llmHint', f.hint));
      card.append(wrap);
    }

    const err = el('p', 'llmError');
    card.append(err);

    const bar = el('div', 'llmDialogBar');
    const cancel = el('button', 'pill', 'cancel');
    const confirm = el('button', `pill ${danger ? 'cancel' : 'on-off on'}`, ok);
    const close = (value) => { back.remove(); resolve(value); };
    cancel.addEventListener('click', () => close(null));
    confirm.addEventListener('click', () => {
      const out = {};
      for (const [name, node] of inputs) out[name] = node.value;
      close(out);
    });
    bar.append(cancel, confirm);
    card.append(bar);
    back.append(card);
    // Dismissing by the backdrop is a cancel, never a save — a click that
    // lands outside a form must not commit what is in it.
    back.addEventListener('click', (e) => { if (e.target === back) close(null); });
    els.settings.append(back);
    card.querySelector('input, select')?.focus();
    dialog.showError = (text) => { err.textContent = text; };
  });
}

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
async function mayInterrupt(field) {
  if (!['thinking', 'cache', 'url'].includes(field)) return true;
  if (!busy) return true;
  const out = await dialog({
    title: 'a turn is running',
    lead: `Changing ${field} starts a new query and will interrupt the answer `
      + 'being written. The conversation itself is kept — the new query resumes it.',
    ok: 'interrupt and change',
    danger: true,
  });
  return out !== null;
}

/** The reuse offer: recognise a key, never see one. */
async function offerReuse(row) {
  const others = gateways.filter((g) => g.gateway !== row.key?.gateway);
  if (!others.length) return false;
  const out = await dialog({
    title: 'reuse a key you already saved?',
    lead: 'The key is copied on the server — it is never sent to this page.',
    ok: 'reuse it',
    fields: [{
      name: 'gateway',
      label: 'saved keys',
      options: others.map((g) => ({ value: g.gateway, label: `${g.host}  ·  ${g.fingerprint}` })),
    }],
  });
  if (!out) return false;
  const res = await fetch('/api/llms/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: row.url, sameAs: out.gateway }),
  });
  const saved = await res.json();
  if (!res.ok) { notice(saved.error ?? 'could not reuse that key', true); return false; }
  notice(`key reused for ${saved.host}`);
  await draw();
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
  input.addEventListener('focus', async () => {
    if (offered || !row.url || row.key) return;
    offered = true;
    if (await offerReuse(row)) input.blur();
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
    if (!await mayInterrupt(field)) { select.value = String(row[field]); return; }
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
    if (!await mayInterrupt(field)) { input.value = row[field] ?? ''; return; }
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
  if (row.company) head.append(el('span', 'llmCompany', row.company));
  head.append(el('span', 'llmId', row.model));
  if (row.model === current) head.append(el('span', 'pill', 'in use'));
  head.append(el('span', 'llmVia', row.provider ?? row.url ?? ''));
  card.append(head);

  const grid = el('div', 'llmGrid');
  grid.append(textField(row, 'displayName', 'name', row.model));
  grid.append(textField(row, 'company', 'company', 'Alibaba, Moonshot, Anthropic…'));
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

/** What a gateway can be asked for, before there is a row to ask about. */
async function legalFor(model, url, thinking) {
  const res = await fetch('/api/llms/legal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, url, thinking }),
  });
  return res.json();
}

/**
 * Add an llm — every field in one place.
 *
 * THE OWNER, 2026-08-11: "it only asks me for a model name? what is the
 * company name, gateway url, api key, model name (only ask), effort level,
 * thinking on/off?" All of it, and the effort list is narrowed by what the
 * gateway can actually take rather than offered in full and refused later: a
 * url nobody has probed has NO effort ladder, so the control says so instead
 * of showing five levels the turn would reject.
 */
async function addLlm() {
  // Asked first, because everything else depends on it: a gateway url decides
  // which levels are legal, and first-party (blank) decides differently.
  const first = await dialog({
    title: 'add an llm',
    lead: 'The model name is the only required field — it must be spelled exactly as the gateway spells it.',
    ok: 'next',
    fields: [
      { name: 'model', label: 'model name (required)', placeholder: 'qwen3.8-max' },
      { name: 'displayName', label: 'name for the llm', placeholder: 'blank = the model name', hint: 'what the dropdown shows' },
      { name: 'company', label: 'company', placeholder: 'Alibaba, Moonshot, Anthropic…' },
      { name: 'url', label: 'gateway url', placeholder: 'blank = first-party (your own OAuth)' },
    ],
  });
  if (!first?.model?.trim()) return;
  const model = first.model.trim();
  const url = first.url?.trim() || null;

  const legal = await legalFor(model, url, null);
  const second = await dialog({
    title: `${first.displayName?.trim() || model} — how it should run`,
    lead: url
      ? 'This gateway has not been probed, so only what is known to work is offered.'
      : 'First-party: effort narrows automatically when thinking is off.',
    ok: 'add it',
    fields: [
      {
        name: 'thinking', label: 'thinking',
        options: legal.thinking.map((t) => ({ value: t, label: t })),
      },
      {
        name: 'effort', label: 'effort',
        options: legal.effort.length
          ? legal.effort.map((e) => ({ value: e, label: e }))
          : [{ value: '', label: 'this provider has no effort levels' }],
      },
      { name: 'key', label: 'api key', secret: true, placeholder: url ? 'paste a key, or leave blank to reuse one' : 'not needed — first-party uses your OAuth' },
    ],
  });
  if (!second) return;

  const patch = {
    displayName: first.displayName?.trim() || '',
    company: first.company?.trim() || '',
    url,
    thinking: second.thinking || undefined,
  };
  if (second.effort) patch.effort = second.effort;

  const saved = await save(model, patch);
  if (!saved) return;

  if (url && second.key?.trim()) {
    const res = await fetch('/api/llms/key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, key: second.key.trim() }),
    });
    const out = await res.json();
    if (!res.ok) notice(out.error ?? 'the llm was added, but the key was refused', true);
    else notice(`${model} added — key saved for ${out.host}`);
  } else if (url) {
    notice(`${model} added — no key yet, so it will refuse rather than fall back`);
  } else {
    notice(`${model} added`);
  }
  await draw();
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
  add.addEventListener('click', addLlm);
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
