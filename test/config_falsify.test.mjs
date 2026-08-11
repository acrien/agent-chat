/**
 * Does a setting you made survive, and does a secret stay put?
 *
 * THE COMPLAINT, 2026-08-11: "there's no way I know the setting of the server
 * if it differs from what I set in the config page."
 *
 * THE DEFECT IT NAMED. The page's effort option spelled `default` had the
 * empty string as its value; that stored `effort: null`; and the CLI's own
 * persisted `effortLevel` — `xhigh`, never chosen by anyone — filled the gap.
 * On Claude Opus 5 with thinking disabled that pair is a 400, so every turn
 * failed on a setting nobody picked and nobody could see. A stored null does
 * not mean "no value"; it means "something invisible will choose".
 *
 * THE SECOND HALF IS THE SECRETS, and it is a different question with a
 * different failure. `~/.agent-chat/` sits inside a git repo at `/home/aeli`
 * whose remote is this project's own GitHub repo, tracking zero files with no
 * `.gitignore`. A key written there is one `git add -A` from being published.
 * So these two live apart, and the tests below hold them apart.
 *
 * ORDERING MATTERS. Both stores read their paths at import time, so the
 * fixtures are set BEFORE the import. A test that imported first and
 * configured after would measure the real files — including the owner's real
 * keys — which is a worse bug than the one it was checking for.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmcfg-'));
process.env.RM_LLM_SETTINGS = path.join(dir, 'llms.json');
process.env.RM_LLM_KEYS = path.join(dir, 'keys', 'keys.json');
process.env.RAINSMOKE_LLM_CONFIG = path.join(dir, 'absent.json');

const { settingsFor, saveSettings, legalFor, allSettings } = await import('../router/llm_settings.mjs');
const keys = await import('../router/keys.mjs');
const { routeTurn } = await import('../router/turn_route.mjs');

const fails = [];
const guard = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { fails.push(name); console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

// --- settings: no field is ever null --------------------------------------

guard('every field resolves to a real value, never null', () => {
  const s = settingsFor('claude-opus-5');
  for (const field of ['displayName', 'effort', 'thinking']) {
    assert.ok(s[field] !== null && s[field] !== undefined, `${field} came back empty`);
  }
  assert.equal(typeof s.cache, 'boolean', 'cache is not a decision');
  // ...and it says whether YOU set it, or it was resolved for you.
  assert.deepEqual(s.stored, [], 'nothing was stored, so nothing may claim to be');
});

guard('a stored setting survives a re-read — this is what a restart does', () => {
  saveSettings('claude-opus-5', { effort: 'high', thinking: 'disabled' });
  const s = settingsFor('claude-opus-5');
  assert.equal(s.effort, 'high');
  assert.equal(s.thinking, 'disabled');
  assert.ok(s.stored.includes('effort'), 'the setting does not know it was chosen');
  // A second reader gets the same answer — the file IS the state.
  assert.equal(JSON.parse(fs.readFileSync(process.env.RM_LLM_SETTINGS, 'utf8')).models['claude-opus-5'].effort, 'high');
});

guard('an illegal combination is refused, with the reason', () => {
  // Claude Opus 5: thinking off is accepted only at effort `high` or below.
  let refused = null;
  try { saveSettings('claude-opus-5', { thinking: 'disabled', effort: 'xhigh' }); }
  catch (err) { refused = err.message; }
  assert.ok(refused, 'the 400-producing pair was stored happily');
  assert.match(refused, /xhigh/);
  assert.match(refused, /Legal:/, 'refused without saying what would be legal');
});

guard('the page and the save read one verdict', () => {
  const off = legalFor('claude-opus-5', { thinking: 'disabled' });
  assert.ok(!off.effort.includes('xhigh'), 'the page would offer what the save refuses');
  assert.ok(off.effort.includes('high'));
  const on = legalFor('claude-opus-5', { thinking: 'adaptive' });
  assert.ok(on.effort.includes('xhigh'), 'the cap leaked into a case it does not apply to');
});

guard('a provider with no effort ladder offers none', () => {
  assert.deepEqual(legalFor('qwen3.8-max', { thinking: 'disabled' }).effort, []);
});

// --- the router uses what you stored --------------------------------------

guard('a configured model carries YOUR setting into the turn', () => {
  saveSettings('claude-opus-5', { effort: 'high', thinking: 'disabled' });
  const r = routeTurn({ model: 'claude-opus-5' });
  assert.equal(r.options.effort, 'high');
  assert.deepEqual(r.options.thinking, { type: 'disabled' });
});

guard('an UNconfigured model does not have a choice invented for it', () => {
  // `settingsFor` always resolves a value; treating that as a decision would
  // be inventing one and reporting it as the owner's.
  const r = routeTurn({ model: 'claude-fable-5' });
  assert.ok(!('effort' in r.options), 'a resolved default was reported as a choice');
});

guard('an explicit argument still outranks the stored setting', () => {
  const r = routeTurn({ model: 'claude-opus-5', effort: 'low' });
  assert.equal(r.options.effort, 'low');
});

// --- keys: outside the repo, and they stay there --------------------------

guard('a key is written 0600, in a directory outside every repository', () => {
  keys.saveKey('https://gw.example/apps/anthropic', 'secret-key-A');
  const mode = fs.statSync(process.env.RM_LLM_KEYS).mode & 0o777;
  assert.equal(mode, 0o600, `key file is mode ${mode.toString(8)}`);
  assert.ok(!process.env.RM_LLM_KEYS.includes('/projects/'), 'keys are inside a source tree');
});

guard('describe() can identify a key and cannot use one', () => {
  const shown = keys.describe();
  assert.ok(shown.length, 'nothing to describe');
  const blob = JSON.stringify(shown);
  assert.ok(!blob.includes('secret-key-A'), 'the secret is in what the page renders');
  assert.ok(shown[0].fingerprint && shown[0].fingerprint.length === 8, 'no way to tell two keys apart');
  assert.ok(!('key' in shown[0]), 'the raw key rode along');
  // NOT the last four characters — that hands over four characters for free.
  assert.ok(!'secret-key-A'.endsWith(shown[0].fingerprint), 'the fingerprint is a slice of the secret');
});

guard('reuse copies the key without it leaving the store', () => {
  const out = keys.reuseKey('https://gw.example/apps/anthropic', 'https://gw.example/apps/anthropic/v2');
  assert.ok(!JSON.stringify(out).includes('secret-key-A'), 'reuse handed the secret back');
  assert.equal(keys.keyFor('https://gw.example/apps/anthropic/v2'), 'secret-key-A');
  assert.equal(out.reusedFrom, keys.gatewayId('https://gw.example/apps/anthropic'));
});

guard('a gateway is one account, however the url is spelled', () => {
  assert.equal(
    keys.gatewayId('https://gw.example/apps/anthropic/'),
    keys.gatewayId('https://gw.example/apps/anthropic'),
    'a trailing slash would store the same account twice',
  );
  assert.equal(keys.keyFor('https://gw.example/apps/anthropic/'), 'secret-key-A');
});

// --- a declared url routes, and says so when it cannot --------------------

guard('a declared url with a stored key routes to it', () => {
  saveSettings('my-own-llm', { url: 'https://gw.example/apps/anthropic', effort: 'low' });
  const r = routeTurn({ model: 'my-own-llm' });
  assert.equal(r.reachable, true);
  assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://gw.example/apps/anthropic');
  assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, 'secret-key-A');
});

guard('a declared url with NO key says so instead of falling back', () => {
  saveSettings('keyless-llm', { url: 'https://other.example/anthropic' });
  const r = routeTurn({ model: 'keyless-llm' });
  assert.equal(r.reachable, false, 'a keyless gateway reported itself routable');
  assert.match(String(r.missing), /no key stored/);
  // AND it must not inherit somebody else's credential.
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in r.env), 'it borrowed a token from elsewhere');
});

guard('the settings file holds no secrets — it is the one that syncs', () => {
  const text = fs.readFileSync(process.env.RM_LLM_SETTINGS, 'utf8');
  assert.ok(!text.includes('secret-key-A'), 'a key is in the file that goes to the pod');
  assert.ok(text.includes('gw.example'), 'the gateway url should travel; only the key must not');
});

guard('allSettings lists what the page will show', () => {
  const rows = allSettings(['claude-opus-5']);
  assert.ok(rows.find((r) => r.model === 'my-own-llm'), 'a configured model vanished from the list');
  assert.ok(rows.every((r) => r.effort !== undefined), 'a row would render an empty control');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} failed: ${fails.join(', ')}` : '\nconfig: all ok');
process.exit(fails.length ? 1 : 0);
