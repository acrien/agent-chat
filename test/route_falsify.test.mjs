/**
 * Does a route ever inherit a decision nobody made?
 *
 * THE DEFECT THIS EXISTS FOR, measured 2026-08-11 from the live server log:
 *
 *     [session acrien-gmail.com] model=opus[1m] effort=(default) thinking={"type":"disabled"}
 *       session error (acrien-gmail.com): rate_limit
 *
 * The dropdown worked. The query respawned. The request still went to the
 * Alibaba gateway, because `server.mjs` had loaded provider.env into its own
 * `process.env`, `providerFor` returned null for a first-party name, and the
 * SDK's default child env is `{...process.env}` — the poisoned one.
 *
 * THE OLD TEST ASSERTED THE DEFECT. `model_routing.test.mjs` opens with
 * "a first-party model needs no routing" and asserts `providerFor('claude-opus-5')
 * === null`. It passed on the day the site was serving opus out of qwen's
 * quota. A green invariant that names the bug is worse than no test, so the
 * first case below asserts the opposite and the rest hold the line.
 *
 * ORDERING MATTERS. The registry reads its file paths at import time, so the
 * fixtures and the deliberately-poisoned ambient environment are both set
 * BEFORE the import. A test that imported first and configured after would
 * measure the wrong thing and pass — silent-green arriving through the test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-test-'));
// qwen has credentials; moonshot is declared and deliberately has none, so one
// fixture exercises both verdicts — the golden record carries a model for each.
fs.writeFileSync(path.join(dir, 'llm_config.json'), JSON.stringify({
  providers: {
    qwen: { base_url: 'https://gateway.example/apps/anthropic', api_key: 'test-key-123' },
    moonshot: { base_url: null, api_key: null },
  },
}));
process.env.RAINSMOKE_LLM_CONFIG = path.join(dir, 'llm_config.json');
process.env.RM_ROUTER_PROVIDERS = path.join(dir, 'providers.json');   // absent on purpose

// THE POISONED AMBIENT ENVIRONMENT — this is production's, reproduced. Every
// one of these was in the real server's process.env when opus went to qwen.
const AMBIENT = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/nobody',
  ANTHROPIC_BASE_URL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'gateway-token-from-provider-env',
  ANTHROPIC_MODEL: 'qwen3.8-max',
  ANTHROPIC_SMALL_FAST_MODEL: 'qwen3.8-max',
  ANTHROPIC_API_KEY: 'would-outrank-the-gateway-token',
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
};
Object.assign(process.env, AMBIENT);

const { routeTurn, menu } = await import('../router/turn_route.mjs');
const { providers, declaredVars, ROUTED_VARS } = await import('../router/provider_registry.mjs');
const { TURNS_FOR_EFFORT } = await import('../router/capability_table.mjs');

const fails = [];
const guard = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { fails.push(name); console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

guard('a first-party route refuses the ambient gateway', () => {
  // THE ONE THAT WAS BROKEN. Opus, on a process carrying a qwen gateway.
  const r = routeTurn({ model: 'claude-opus-5', source: AMBIENT });
  assert.equal(r.provider, 'anthropic');
  assert.ok(!('ANTHROPIC_BASE_URL' in r.env), 'the gateway url survived — opus would be served by qwen');
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in r.env), 'the gateway token survived');
  assert.ok(!('ANTHROPIC_MODEL' in r.env), 'an ambient model override survived');
});

guard('the default is first-party and equally clean', () => {
  for (const model of [null, undefined, '']) {
    const r = routeTurn({ model, source: AMBIENT });
    assert.equal(r.provider, 'anthropic', `${String(model)} did not resolve first-party`);
    assert.ok(!('ANTHROPIC_BASE_URL' in r.env), `${String(model)} inherited the gateway`);
  }
});

guard('there is no null verdict — every route carries an env', () => {
  for (const model of [null, 'claude-opus-5', 'qwen3.8-max', 'kimi-k2.5']) {
    const r = routeTurn({ model, source: AMBIENT });
    assert.ok(r.env && typeof r.env === 'object', `${String(model)} returned no environment`);
  }
});

guard('a gateway route carries its provider environment', () => {
  const r = routeTurn({ model: 'qwen3.8-max', source: AMBIENT });
  assert.equal(r.provider, 'qwen');
  assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://gateway.example/apps/anthropic');
  assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, 'test-key-123');
  // and NOT the ambient one it was told to ignore
  assert.ok(!r.env.ANTHROPIC_BASE_URL.includes('aliyuncs'), 'the ambient gateway won over the declared one');
});

guard('the child env is complete, not a patch', () => {
  // The SDK REPLACES the child environment when one is provided — a partial
  // env spawns a CLI with no PATH.
  for (const model of [null, 'qwen3.8-max']) {
    const r = routeTurn({ model, source: AMBIENT });
    assert.equal(r.env.PATH, '/usr/bin:/bin', `${String(model)} lost PATH`);
    assert.equal(r.env.HOME, '/home/nobody', `${String(model)} lost HOME`);
  }
});

guard('an ambient ANTHROPIC_API_KEY never survives into any route', () => {
  // Left in place it outranks the gateway token and every request is rejected,
  // and the turn comes back empty reading as a model failure.
  for (const model of [null, 'claude-opus-5', 'qwen3.8-max']) {
    const r = routeTurn({ model, source: AMBIENT });
    assert.ok(!('ANTHROPIC_API_KEY' in r.env), `${String(model)} kept the ambient api key`);
  }
});

guard('the context window comes from the record, never from ambient', () => {
  const q = routeTurn({ model: 'qwen3.8-max', source: AMBIENT });
  assert.equal(q.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000', 'the record\'s 1M window was lost');
  // A model the record gives no window must not inherit one — the ambient
  // value would silently become its window, which is the 2026-08-10 finding.
  const older = routeTurn({ model: 'qwen3.7-max', source: AMBIENT });
  assert.ok(!('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in older.env), 'an ambient window leaked into a model with none');
  const opus = routeTurn({ model: 'claude-opus-5', source: AMBIENT });
  assert.ok(!('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in opus.env), 'an ambient window leaked into a first-party model');
});

guard('an effort the provider has no ladder for is dropped AND reported', () => {
  const r = routeTurn({ model: 'qwen3.8-max', effort: 'xhigh', source: AMBIENT });
  assert.ok(!('effort' in r.options), 'an effort qwen cannot take was sent');
  const said = r.dropped.find((d) => d.what === 'effort');
  assert.ok(said, 'the effort vanished with no witness — the silence this router exists to end');
  assert.equal(said.asked, 'xhigh');
  assert.match(said.why, /no effort levels/);
});

guard('an effort the provider declares survives', () => {
  const r = routeTurn({ model: 'claude-opus-5', effort: 'xhigh', source: AMBIENT });
  assert.equal(r.options.effort, 'xhigh');
  assert.equal(r.dropped.length, 0);
});

guard('effort becomes a turn ceiling where there is no ladder', () => {
  // THE EFFORT-EQUIVALENT. Measured: replies are 0.7% of spend and turns drive
  // the rest, so the level the user picked is honoured as a turn ceiling.
  const r = routeTurn({ model: 'qwen3.8-max', effort: 'low', source: AMBIENT });
  assert.equal(r.options.maxTurns, TURNS_FOR_EFFORT.low);
  // `max` means spend what it takes — a ceiling nobody chose is the failure.
  const m = routeTurn({ model: 'qwen3.8-max', effort: 'max', source: AMBIENT });
  assert.ok(!('maxTurns' in m.options), 'max invented a ceiling nobody asked for');
  // An explicit ceiling outranks the derived one.
  const x = routeTurn({ model: 'qwen3.8-max', effort: 'low', maxTurns: 3, source: AMBIENT });
  assert.equal(x.options.maxTurns, 3);
});

guard('thinking is one switch, honoured in the form the provider was probed for', () => {
  const q = routeTurn({ model: 'qwen3.8-max', thinking: 'disabled', source: AMBIENT });
  assert.deepEqual(q.options.thinking, { type: 'disabled' }, 'the Anthropic form was not sent to a gateway probed for it');
  const a = routeTurn({ model: 'claude-opus-5', thinking: 'adaptive', source: AMBIENT });
  assert.deepEqual(a.options.thinking, { type: 'adaptive' });
  // Unprobed is not the same as unsupported: send nothing, and say why.
  const k = routeTurn({ model: 'kimi-k2.5', thinking: 'disabled', source: AMBIENT });
  assert.ok(!('thinking' in k.options), 'a thinking form nobody probed was sent anyway');
  assert.ok(k.dropped.find((d) => d.what === 'thinking'), 'the drop was silent');
});

guard('thinking off caps effort, and the cap is stated not assumed', () => {
  // THE DEFECT, from a real turn 2026-08-11:
  //   400 output_config.effort 'xhigh' is not supported when thinking is
  //   disabled on this model. Use effort 'high' or below, or enable thinking.
  // The router had sent NO effort — the CLI's persisted `effortLevel` chose,
  // out of sight. Leaving a field unset does not mean the turn has no value
  // for it, which is this router's own thesis applied one layer up.
  const off = routeTurn({ model: 'claude-opus-5', thinking: 'disabled', source: AMBIENT });
  assert.equal(off.options.effort, 'high', 'nothing was stated, so the CLI still decides');
  assert.ok(off.dropped.find((d) => d.what === 'effort'), 'the cap was applied silently');

  // An explicit choice at or below the cap is honoured untouched.
  const low = routeTurn({ model: 'claude-opus-5', thinking: 'disabled', effort: 'low', source: AMBIENT });
  assert.equal(low.options.effort, 'low');
  assert.equal(low.dropped.length, 0);

  // Thinking ON has no such constraint — the cap must not leak into it.
  const on = routeTurn({ model: 'claude-opus-5', thinking: 'adaptive', effort: 'xhigh', source: AMBIENT });
  assert.equal(on.options.effort, 'xhigh', 'the cap was applied where it does not apply');

  // A provider with no effort ladder is unaffected by an effort cap.
  const q = routeTurn({ model: 'qwen3.8-max', thinking: 'disabled', source: AMBIENT });
  assert.ok(!('effort' in q.options), 'an effort was invented for a provider that has none');
});

guard('caching off is a declared variable, not a silence', () => {
  const off = routeTurn({ model: 'claude-opus-5', cache: false, source: AMBIENT });
  assert.equal(off.env.DISABLE_PROMPT_CACHING, '1');
  const on = routeTurn({ model: 'claude-opus-5', cache: true, source: AMBIENT });
  assert.ok(!('DISABLE_PROMPT_CACHING' in on.env), 'caching was disabled on a provider that serves it');
  // A provider whose caching was never probed does not get relied on for it.
  const k = routeTurn({ model: 'kimi-k2.5', cache: true, source: AMBIENT });
  assert.equal(k.env.DISABLE_PROMPT_CACHING, '1');
  assert.ok(k.dropped.find((d) => d.what === 'promptCache'), 'an unverified cache was assumed silently');
});

guard('a declared model with no key says so instead of vanishing', () => {
  const r = routeTurn({ model: 'kimi-k2.5', source: AMBIENT });
  assert.equal(r.reachable, false, 'a keyless provider reported itself routable');
  assert.match(String(r.missing), /moonshot/);
  // It still carries a complete env — unroutable is not un-runnable-into.
  assert.equal(r.env.PATH, '/usr/bin:/bin');
  assert.ok(!('ANTHROPIC_BASE_URL' in r.env), 'a keyless route inherited the ambient gateway');
});

guard('the menu and the routing cannot disagree — first-party included', () => {
  const rows = menu({ sdkModels: [{ value: 'claude-opus-5', displayName: 'Opus 5', supportedEffortLevels: ['low', 'high'] }] });
  assert.ok(rows.length > 1, 'the menu is empty — no source loaded');
  for (const row of rows) {
    const route = routeTurn({ model: row.value, source: AMBIENT });
    assert.equal(row.reachable, route.reachable, `${row.value}: menu and route disagree on reachability`);
    assert.equal(row.reachable, !row.displayName.includes('(no key)'), `${row.value}: the label contradicts the verdict`);
  }
  const opus = rows.find((r) => r.value === 'claude-opus-5');
  assert.deepEqual(opus.capabilities.effort.levels, ['low', 'high'], 'the SDK\'s per-model levels were ignored');
});

guard('the strip list covers every variable any declared provider sets', () => {
  // A provider variable that is set but never stripped is the original defect
  // arriving through a new provider. Derived, so it cannot be forgotten.
  const owned = declaredVars();
  for (const p of providers().values()) {
    for (const k of Object.keys(p.env)) {
      assert.ok(owned.has(k), `${p.name} sets ${k}, which nothing strips`);
    }
  }
  for (const v of ROUTED_VARS) assert.ok(owned.has(v), `${v} is routed but not owned`);
});

guard('the ambient variables a route refused are reported', () => {
  const r = routeTurn({ model: 'claude-opus-5', source: AMBIENT });
  // Silently dropping a person's exported gateway is the same shape as
  // silently inheriting it: a decision with no witness.
  for (const v of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    assert.ok(r.ambient.includes(v), `${v} was removed without saying so`);
  }
});

// --- does EVERYTHING actually go through it? ------------------------------
//
// The router being correct and the server using it are different claims, and
// only the first one has been tested so far. These read server.mjs itself:
// a bypass is a source fact, so it is checked against the source.

const SERVER = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

guard('there is exactly one place a query is constructed', () => {
  // THE FUNNEL IS THE MECHANISM. Every reconfiguration path — the dropdown,
  // /clear, /restart, thinking, caching, cwd, the mid-turn provider swap —
  // ends at `start()`, so routing them individually was never the job. Routing
  // the one spawn site is. A second `query({` would be a second spawn path
  // that could be built without a route, which is how the last one happened.
  const sites = SERVER.match(/\bquery\(\{/g) ?? [];
  assert.equal(sites.length, 1, `${sites.length} query() sites — the funnel is broken`);
});

guard('the spawn site is routed, and its env is never left to inherit', () => {
  const start = SERVER.slice(SERVER.indexOf('  start({ fresh'), SERVER.indexOf('async consume('));
  assert.ok(start.includes('routeTurn({'), 'start() spawns without asking the router');
  assert.ok(/options\.env = route\.env/.test(start), 'start() does not set options.env from the route');
  // The defect in one line: `if (routed?.env)` made the env conditional, and
  // the branch that skipped it is the one that served opus out of qwen.
  assert.ok(!/if \(\w*\??\.?env\) options\.env/.test(start), 'options.env is set conditionally again');
});

guard('every respawn path goes through start()', () => {
  // Named so the list is auditable rather than a count: each of these is a
  // control on the page or an API route the owner can reach.
  for (const [what, marker] of [
    ['/clear', 'finishClear'],
    ['/restart', 'handOffAndRestart'],
    ['the model dropdown', 'setModelRouted'],
    ['the thinking switch', "url === '/api/thinking'"],
    ['the cache switch', "url === '/api/cache'"],
    ['the cwd picker', 'setCwd'],
  ]) {
    assert.ok(SERVER.includes(marker), `${what} is gone — ${marker} not found`);
  }
  // swapQuery and restart are the two funnels those controls reach start() by.
  for (const fn of ['swapQuery(', 'restart() {']) {
    assert.ok(SERVER.includes(fn), `${fn} is gone — a control now spawns its own way`);
  }
});

guard('nothing in the server writes process.env', () => {
  // The original defect, made unrepresentable. `loadProviderEnv` mutated the
  // process environment at startup and every later turn inherited it.
  const writes = SERVER.match(/process\.env\[[^\]]+\]\s*=|process\.env\.\w+\s*=(?!=)/g) ?? [];
  assert.deepEqual(writes, [], `server.mjs assigns process.env: ${writes.join(', ')}`);
  // A DECLARATION OR A CALL, NOT A MENTION. The comment where the loader used
  // to sit names it on purpose — that note is why nobody re-adds it — and the
  // first draft of this assertion failed on its own tombstone.
  assert.ok(!/(?:function|const|let)\s+loadProviderEnv|loadProviderEnv\s*\(/.test(SERVER),
    'the provider-env loader is declared or called again');
});

guard('the superseded routing module is gone, not merely unused', () => {
  assert.ok(!SERVER.includes("from './routing.mjs'"), 'server.mjs still imports routing.mjs');
  assert.ok(!fs.existsSync(new URL('../routing.mjs', import.meta.url)),
    'routing.mjs still exists — two sites would name one thing again');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} failed: ${fails.join(', ')}` : '\nrouter: all ok');
process.exit(fails.length ? 1 : 0);
