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

guard('the result line reports tokens, not a price', () => {
  handle({ t: 'result', subtype: 'success', turns: 14, durationMs: 322300,
           usage: { input_tokens: 26, cache_read_input_tokens: 12839496, output_tokens: 12507 } });
  const tree = dump(dom.transcript).join('\n');
  assert.match(tree, /tokens: 26 in · 13k out · 12\.8M cached/);
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

guard('the splitter is wired to the grip', () => {
  const grip = document.getElementById('grip');
  const wanted = ['pointerdown', 'pointermove', 'pointerup', 'dblclick'];
  const missing = wanted.filter((k) => typeof grip.handlers[k] !== 'function');
  assert.equal(missing.length, 0, `grip missing handlers: ${missing.join(', ')}`);
});

console.log(fails.length ? `\n${fails.length} failed` : '\nall wired');
process.exit(fails.length ? 1 : 0);
