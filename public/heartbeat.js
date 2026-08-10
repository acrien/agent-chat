/**
 * heartbeat.js — what the out-of-band poller is doing, beside the transcript.
 */
import { el, els } from './dom.js';

// --- heartbeat panel -------------------------------------------------------

/**
 * What the heartbeat is doing, beside the transcript rather than inside it.
 *
 * Fed by `t: 'heartbeat'`, which the server sends when the state CHANGES — not
 * on a timer. The one thing that ticks here is the age of the last beat, and it
 * ticks locally: the page has the timestamp and a clock, so counting seconds
 * costs nothing and needs no traffic.
 */
let beatState = null;

/** `HH:MM:SS` — beats land minutes apart, so minutes alone would collide. */
export function tick(at) {
  return new Date(at * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function ago(seconds) {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
}

/** As many beats as fit a glance; the record keeps the rest. */
const BEAT_ROWS = 40;

/**
 * THE FIELDS THIS ROW HAS A SHAPE FOR. Everything else in an entry is rendered
 * generically rather than dropped — see `streamRow`.
 *
 * The operational fields are here not because they are uninteresting but
 * because they already have a home in the facts list above, and repeating
 * `watching=8067 dirs` on all forty rows would bury the sentences.
 */
const ROW_SHAPED = new Set([
  'at', 'state', 'label', 'job', 'note', 'detail',
  'changed', 'quiet', 'quiet_needed', 'poll_seconds', 'watching', 'roots',
  'turn', 'key', 'pid', 'cwd',
]);

/**
 * ONE STREAM, ONE RENDERER, AND THE RENDERER DROPS NOTHING.
 *
 * THE OWNER, 2026-08-10: "there should be a stream, all emitters dump into
 * there, renderer renders all in there, so in the future we add more
 * messages/jobs, we don't need to worry about rendering vs etc."
 *
 * WHAT THIS FIXES IS A CLASS, NOT A FIELD. The previous version named the
 * three fields it drew — time, source, state — so `note` was dropped, and the
 * failure was silent: `restart in 30s — countdown started` displayed as the
 * single word `scheduled`, and every layer beneath was working perfectly. That
 * is not a bug about notes. Any field a future job adds would vanish the same
 * way, and nothing anywhere would report it, because a renderer that ignores a
 * field looks exactly like an emitter that never sent one.
 *
 * So the shape is inverted. The row draws what it has a shape for, and then
 * draws EVERYTHING ELSE as key=value. A new job emitting `{pid: 4177}` shows
 * up with no change here. The list above is not a filter on what may be shown
 * — it is a list of what already has a better place to be shown.
 *
 * `detail` is the structured half: an emitter with more to say than a sentence
 * puts it there, and it renders as pairs rather than as JSON nobody reads.
 */
export function streamRow(row) {
  const line = el('div', `row ${row.state ?? ''}`);
  line.append(el('span', 't', tick(row.at)));
  // WHICH JOB SAID IT. Beats written before jobs existed carry no label and
  // fall back rather than rendering a blank bracket.
  line.append(el('span', 'src', `[${row.label ?? row.job ?? 'heartbeat'}]`));
  line.append(el('span', 's', row.state ?? '?'));
  // WHAT IT ACTUALLY SAID. The state is one word chosen so a panel can colour
  // it; the note is the sentence the job wrote.
  if (row.note) line.append(el('span', 'n', row.note));

  const extra = [];
  for (const [key, value] of Object.entries(row.detail ?? {})) extra.push([key, value]);
  for (const [key, value] of Object.entries(row)) {
    if (!ROW_SHAPED.has(key) && value != null && value !== '') extra.push([key, value]);
  }
  for (const [key, value] of extra) {
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    line.append(el('span', 'x', `${key}=${text.length > 80 ? `${text.slice(0, 80)}…` : text}`));
  }
  return line;
}

export function secondsSince(at) {
  return at ? Date.now() / 1000 - at : 0;
}

export function renderBeat() {
  const body = els.beatBody;
  body.textContent = '';

  if (!beatState?.attached) {
    els.beatPulse.className = 'pulse stopped';
    body.append(el('div', 'beatNow', 'not running'));
    body.append(el('div', 'beatNote', 'nothing has beaten for this directory yet.'));
    const how = el('pre');
    how.append(el('code', null, 'python3 ops/heartbeat.py <cwd>'));
    body.append(how);
    return;
  }

  const beat = beatState.beat ?? {};
  // A beat that stopped arriving outranks whatever the last one said it was
  // doing: "working" from four minutes ago is not what the panel is for.
  const state = beatState.beating ? (beat.state ?? 'quiet') : 'stopped';
  els.beatPulse.className = `pulse ${state}`;

  const now = el('div', 'beatNow');
  now.append(el('span', 'state', state));
  now.append(document.createTextNode(' · '));
  now.append(el('span', 'age', ago(secondsSince(beat.at))));
  body.append(now);

  body.append(el('div', 'beatNote', state === 'stopped'
    ? 'the beats stopped — the poller is not running, or it hung.'
    : (beat.note ?? '')));

  const facts = el('dl', 'beatFacts');
  const fact = (term, value) => {
    facts.append(el('dt', null, term));
    facts.append(el('dd', null, value));
  };
  if (beat.poll_seconds) fact('polls', `every ${beat.poll_seconds}s`);
  if (beat.quiet != null) fact('quiet', `${beat.quiet} of ${beat.quiet_needed ?? '?'} polls`);
  // The unit comes with the value: appending " files" here made the label read
  // "8063 dirs (inotify) files" the moment the poller counted something else.
  if (beat.watching != null) fact('watching', String(beat.watching));
  for (const root of beat.roots ?? []) fact('root', root);
  body.append(facts);

  const recent = (beatState.recent ?? []).slice(-BEAT_ROWS).reverse();
  if (!recent.length) return;
  // TWO SECTIONS, BECAUSE THEY ARE TWO MACHINES. Interleaving them by time
  // would read as one stream, and the owner would have to check every row's
  // label to know which box it happened on — a provenance you have to look up
  // is a provenance the eye gets wrong. The pod's rows are contained the same
  // way the pod's mistakes are.
  const here = recent.filter((r) => !r.pod);
  const pod = recent.filter((r) => r.pod);
  if (here.length) {
    const log = el('div', 'beatLog');
    for (const row of here) log.append(streamRow(row));
    body.append(log);
  }
  if (pod.length) {
    const podLog = el('div', 'beatLog podLog');
    podLog.append(el('div', 'podHead', 'lab pod — aelimain'));
    for (const row of pod) podLog.append(streamRow(row));
    body.append(podLog);
  }
}

/**
 * Re-say the age once a second, and nothing else. Redrawing the whole panel on
 * a timer would fight the log's scroll position and rebuild a list nobody asked
 * to change — only the field that is a function of the clock is updated, plus
 * the pulse, on the one transition a clock can cause: beats going silent.
 */
setInterval(() => {
  if (!beatState?.attached || !beatState.beat) return;
  const seconds = secondsSince(beatState.beat.at);
  const every = beatState.beat.poll_seconds ?? 0;
  const beating = every > 0 ? seconds <= every * 3 : false;
  if (beating !== beatState.beating) {
    beatState = { ...beatState, beating };
    renderBeat();
    return;
  }
  const age = els.beatBody.querySelector('.age');
  if (age) age.textContent = ago(seconds);
}, 1000);



/**
 * Hand the panel a new reading.
 *
 * `events.js` assigned `beatState` directly when both lived in one file. A
 * module whose state is written from outside cannot promise anything about it
 * — including that a render follows a change, which is the one thing this
 * module exists to guarantee.
 */
export function setBeat(next) {
  beatState = next;
  renderBeat();
}
