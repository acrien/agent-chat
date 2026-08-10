/**
 * Does every module still reach the ones it needs?
 *
 * THE QUESTION THIS ANSWERS, and it is not "does it parse". `node --check`
 * passed on the day an edit deleted the heartbeat panel, the jobs page and the
 * splitter, because a shorter file is still a valid file. Splitting one file
 * into nine makes that particular deletion impossible and introduces a new way
 * to fail — a module that imports a name its neighbour never exported — which
 * is silent until the moment the feature is used.
 *
 * So this imports the real entry point, exercises one path through every
 * module, and reads the tree that comes out.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { install, dump } from './dom-shim.mjs';

const { document } = install();

// Importing boot.js pulls in every other module and runs their top level.
// A missing export fails HERE, at import, which is the whole point.
const boot = await import('../public/boot.js');
const { handle } = await import('../public/events.js');
const dom = await import('../public/dom.js');
const { drawJobList, drawJobConfig } = await import('../public/jobs.js');

const fails = [];
/**
 * SYNCHRONOUS ON PURPOSE. The first draft took `fn` and called it without
 * awaiting, so an `async` case threw into a floating promise and this printed
 * `ok` for a test whose assertions never ran. A harness that cannot fail is
 * worse than no harness: it is a green light wired to nothing.
 */
const check = (name, fn) => {
  const out = fn();
  if (out && typeof out.then === 'function') {
    throw new Error(`${name}: check() is synchronous — an async case would report ok without asserting`);
  }
  console.log(`  ok    ${name}`);
};
const guard = (name, fn) => {
  try { check(name, fn); }
  catch (err) { fails.push(name); console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

const now = Math.floor(Date.now() / 1000);
const AT = Date.now();

guard('a user turn and a reply land in one bubble', () => {
  handle({ t: 'user', text: 'do a thing', at: AT });
  handle({ t: 'turn_start', lane: 'main', model: 'claude-opus-5', effort: 'xhigh', at: AT });
  handle({ t: 'block_start', lane: 'main', index: 0, kind: 'text' });
  handle({ t: 'delta', lane: 'main', index: 0, kind: 'text', text: '## Heading\n\nA reply.' });
  handle({ t: 'block_stop', lane: 'main', index: 0 });
  const tree = dump(dom.transcript).join('\n');
  assert.match(tree, /div\.user/, 'no user bubble');
  assert.match(tree, /section\.sec\.ask/, 'markdown module did not render a section');
});

/**
 * A JOB'S TURN MAY NOT WEAR THE OWNER'S FACE. The SDK takes input only as a
 * user message, so a job's question is indistinguishable from the owner's on
 * the wire; if the page drew it as a user bubble, the transcript would show
 * them asking for something they never asked for.
 */
guard('a job turn is not drawn as the owner', () => {
  handle({ t: 'job', name: 'miss_review', label: 'miss review',
           headline: '40 turns to read', at: AT });
  const tree = dump(dom.transcript).join('\n');
  assert.match(tree, /div\.job/, 'no job bubble');
  const owner = (tree.match(/div\.user/g) || []).length;
  assert.equal(owner, 1, `a job turn drew a user bubble (${owner} found, 1 expected)`);
  assert.match(tree, /rainsmoke3 job/, 'the bubble does not say whose turn it is');
});

guard('the result line reports tokens, not a price', () => {
  handle({ t: 'result', subtype: 'success', turns: 14, durationMs: 322300,
           usage: { input_tokens: 26, cache_read_input_tokens: 12839496, output_tokens: 12507 } });
  const tree = dump(dom.transcript).join('\n');
  assert.match(tree, /tokens: 26 in · 13k out · 12\.8M cached/);
});

/**
 * GREEN IS A PROVENANCE, NOT A TOPIC. A heading reading "rainsmoke3 caught two
 * of mine" took the enforcement layer's colour from its wording alone, above a
 * tally that read no issues — the page asserting a source nothing had checked.
 * Only a declared `§§` callout may be green.
 */
guard('writing about rainsmoke3 does not borrow its colour', () => {
  handle({ t: 'block_start', lane: 'main', index: 1, kind: 'text' });
  handle({ t: 'delta', lane: 'main', index: 1, kind: 'text',
           text: '## rainsmoke3 caught two of mine\n\nProse.\n\n§§ Rainsmoke - Dangling (x): y\n' });
  handle({ t: 'block_stop', lane: 'main', index: 1 });
  const tree = dump(dom.transcript).join('\n');
  const green = (tree.match(/section\.sec\.rm3/g) || []).length;
  assert.equal(green, 1, `a heading about rainsmoke3 took its colour (${green} green sections)`);
});

guard('a rainsmoke3 section renders with its severities', () => {
  handle({ t: 'section', source: 'rainsmoke3', at: AT, headline: '1 issue',
           counts: [{ label: 'firelane', n: 1 }],
           rows: [{ severity: 'firelane', label: 'collision', detail: 'a second one' }] });
  assert.match(dump(dom.transcript).join('\n'), /sev\.firelane/);
});

guard('the heartbeat panel renders from a beat', () => {
  handle({ t: 'heartbeat', attached: true, beating: true,
           beat: { at: now - 5, state: 'working', quiet: 0, quiet_needed: 3, poll_seconds: 180,
                   watching: '8063 dirs (inotify)', roots: ['/x'], label: 'pulse check',
                   note: 'work is moving' },
           recent: [{ at: now - 180, state: 'working', label: 'pulse check' }] });
  const panel = dump(document.getElementById('beatBody')).join('\n');
  assert.match(panel, /beatNow/, 'panel did not render');
  assert.match(panel, /\[pulse check\]/, 'log line lost its job label');
});

guard('the jobs page draws both layers', () => {
  const jobs = { jobs: [{ name: 'pulse', label: 'pulse check', does: 'Polls.', enabled: true,
    tunables: [{ name: 'heartbeat_seconds', value: 180, default: 180, low: 30, high: 3600,
                 unit: 'seconds', means: 'How often.', owner_set: true }] }] };
  const page = document.getElementById('settingsBody');
  drawJobList(jobs);
  assert.match(dump(page).join('\n'), /jobRow/, 'job list missing');
  drawJobConfig(jobs, 'pulse');
  assert.match(dump(page).join('\n'), /iCircle/, 'config page missing its (i)');
});

guard('a finished run rings the chime', () => {
  let rang = 0;
  const real = globalThis.AudioContext;
  globalThis.AudioContext = function () {
    rang += 1;
    return { state: 'running', currentTime: 0, close() {},
             createOscillator: () => ({ type: '', frequency: {}, connect: (n) => n, start() {}, stop() {} }),
             createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
                                  connect: (n) => n }) };
  };
  handle({ t: 'result', subtype: 'success', turns: 1, durationMs: 900 });
  globalThis.AudioContext = real;
  assert.equal(rang, 1, 'the run ended and nothing rang');
});

guard('the splitter is wired to the grip', () => {
  const grip = document.getElementById('grip');
  const wanted = ['pointerdown', 'pointermove', 'pointerup', 'dblclick'];
  const missing = wanted.filter((k) => typeof grip.handlers[k] !== 'function');
  assert.equal(missing.length, 0, `grip missing handlers: ${missing.join(', ')}`);
});


/**
 * EVERY CONTROL THE PAGE OWNS, not the ones the author happened to think of.
 *
 * The split left `send()` reading a bare `pending` that had become another
 * module's private state. ES modules are strict, so it threw ReferenceError on
 * the function's first line and the chat could not send a message at all — by
 * Enter or by button. Nothing failed at build time and nothing failed here,
 * because the tests exercised rendering and the break was in a click.
 *
 * So the list is derived from the markup, not from memory: every id the page
 * declares must have a handler behind it, and a new control added to
 * index.html with no wiring fails this without anyone remembering to add a
 * case.
 */
guard('every declared control has a handler behind it', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]);
  // Containers the page writes into rather than listens to. Named, so the
  // exclusion is a decision rather than an oversight.
  const passive = new Set(['transcript', 'beat', 'beatBody', 'beatPulse', 'gate',
                           'knownUsers', 'settings', 'settingsBody', 'settingsTitle',
                           'settingsLead', 'tray', 'trayItems', 'dot', 'loginName',
                           'model', 'effort']);
  const unwired = ids
    .filter((id) => !passive.has(id))
    .filter((id) => Object.keys(document.getElementById(id).handlers).length === 0);
  assert.deepEqual(unwired, [], `controls with no handler: ${unwired.join(', ')}`);
});

await (async () => {
  const name = 'send reaches the tray without touching its internals';
  try {
  let sent = null;
  globalThis.fetch = async (path, init) => {
    sent = { path, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({}) };
  };
  const { send } = await import('../public/transport.js');
  dom.els.input.value = 'hello';
  await send();
  assert.equal(sent?.path, '/api/send', 'send() never reached the server');
  assert.equal(sent.body.text, 'hello');
    console.log(`  ok    ${name}`);
  } catch (err) { fails.push(name); console.log(`  FAIL  ${name}\n        ${err.message}`); }
})();

// The summary is LAST, and stays last. It was in the middle once: two cases
// appended after it never ran, and the file reported `all wired` for them.
console.log(fails.length ? `\n${fails.length} failed` : '\nall wired');
process.exit(fails.length ? 1 : 0);
