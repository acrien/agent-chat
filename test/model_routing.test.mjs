/**
 * Does selecting a model actually route it?
 *
 * THE DEFECT THIS EXISTS FOR, measured 2026-08-10: the dropdown listed
 * qwen3.8-max and marked it reachable, because "reachable" meant the
 * credentials file had a base_url and a key — while the SDK process had
 * neither, so the name went to Anthropic and the turn died looking like a
 * model failure. The menu and the routing had separate checks, and disagreed.
 *
 * So the invariant under test is that they CANNOT disagree: one function
 * decides both, and every test here holds the two sides against each other.
 *
 * THE NAME. This falsifies routing.mjs and shares no stem with it — the
 * collision gate refused the stem-sharing spelling on 2026-08-10, and the
 * refusal stands: two files named "routing" is the shape that produced the
 * defect this file tests.
 *
 * ORDERING MATTERS. routing.mjs reads RAINSMOKE_LLM_CONFIG at import time, so
 * the env must be set BEFORE the import below. A test that imported first and
 * configured after would measure the wrong file and pass — which is the
 * silent-green this file is about, arriving through the test itself.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-test-'));
const CONFIG = path.join(dir, 'llm_config.json');
// qwen has credentials; moonshot deliberately does not — the golden record
// carries a model for each, so one fixture exercises both verdicts.
fs.writeFileSync(CONFIG, JSON.stringify({
  providers: {
    qwen: { base_url: 'https://gateway.example/apps/anthropic', api_key: 'test-key-123' },
    moonshot: { base_url: null, api_key: null },
  },
}));
process.env.RAINSMOKE_LLM_CONFIG = CONFIG;
// Set so its REMOVAL can be asserted: an ambient ANTHROPIC_API_KEY outranks
// the gateway token and turns every request into a rejection.
process.env.ANTHROPIC_API_KEY = 'would-outrank-the-token';
// And an ambient context window would silently become every gateway model's
// window, overriding the golden record — the same shape, found the day this
// was written because the author's own shell carried one.
process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '999999';

const { providerFor, gatewayModels, readGolden } = await import('../routing.mjs');

const fails = [];
const guard = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { fails.push(name); console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

guard('a first-party model needs no routing', () => {
  assert.equal(providerFor('claude-opus-5'), null);
  assert.equal(providerFor('claude-fable-5'), null);
});

guard('the default is first-party', () => {
  assert.equal(providerFor(null), null);
  assert.equal(providerFor(undefined), null);
  assert.equal(providerFor(''), null);
});

guard('a gateway model carries its provider environment', () => {
  const routed = providerFor('qwen3.8-max');
  assert.ok(routed?.env, 'no env — the model would be named but not routed');
  assert.equal(routed.env.ANTHROPIC_BASE_URL, 'https://gateway.example/apps/anthropic');
  assert.equal(routed.env.ANTHROPIC_AUTH_TOKEN, 'test-key-123');
});

guard('the ambient ANTHROPIC_API_KEY is removed from the child env', () => {
  const routed = providerFor('qwen3.8-max');
  assert.ok(routed?.env);
  assert.ok(!('ANTHROPIC_API_KEY' in routed.env),
    'left in place it outranks the gateway token and every request is rejected');
});

guard('the child env is complete, not a patch', () => {
  // The SDK REPLACES the child environment when one is provided — a partial
  // env would spawn a CLI with no PATH.
  const routed = providerFor('qwen3.8-max');
  assert.ok(routed?.env?.PATH, 'no PATH in the provided env');
});

guard('the context window comes from the golden record', () => {
  const routed = providerFor('qwen3.8-max');
  assert.equal(routed?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000',
    'without it the CLI assumes 200k and auto-compacts a 1M model');
  // A model the record gives no window for must not invent one.
  const older = providerFor('qwen3.7-max');
  assert.ok(older?.env, 'qwen3.7-max lost its routing');
  assert.ok(!('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in older.env));
});

guard('a listed model with no key says so instead of vanishing', () => {
  const routed = providerFor('kimi-k2.5');
  assert.ok(routed, 'the model disappeared — a vanished model is the disappearance');
  assert.ok(!routed.env, 'it claims an env it cannot provide');
  assert.match(String(routed.missing), /moonshot/);
});

guard('the menu and the routing cannot disagree', () => {
  // THE INVARIANT. For every listed model, the menu's "reachable" is exactly
  // the routing's "has an env". Before routing.mjs these were two checks with
  // two answers, and the dropdown selected nothing.
  const menu = gatewayModels();
  assert.ok(menu.length, 'the menu is empty — the golden record did not load');
  for (const m of menu) {
    const routed = providerFor(m.value);
    const routable = Boolean(routed?.env);
    const shown = !m.displayName.includes('(no key)');
    assert.equal(shown, routable,
      `${m.value}: menu says ${shown ? 'reachable' : 'no key'}, routing says ${routable ? 'env' : 'none'}`);
  }
});

guard('the model the defect was reported for actually routes', () => {
  // Asserted on the golden record's own entry so a typo in the name cannot
  // pass quietly while a differently-spelled model routes.
  const golden = readGolden();
  const want = golden.models.find((m) => m.value === 'qwen3.8-max' && !m.retired);
  assert.ok(want, 'qwen3.8-max is not in the golden record');
  assert.ok(providerFor(want.value)?.env, 'the model the owner selected does not route');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} failed: ${fails.join(', ')}` : '\nrouting: all ok');
process.exit(fails.length ? 1 : 0);
