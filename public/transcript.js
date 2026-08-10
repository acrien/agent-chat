/**
 * transcript.js — bubbles, lanes, tool cards, and replaying the record.
 *
 * One bubble per reply, not one per assistant message; a single activity slot
 * holding whatever the agent is doing right now; and the sections that belong
 * to systems other than the agent.
 */
import { add, atBottom, el, els, transcript } from './dom.js';
import { renderMarkdown } from './markdown.js';

let lastTurn = { model: null, effort: null };
const toolCards = new Map();       // tool_use_id -> <details>
const lanes = { main: null, sub: null };
let activeLane = null;

export function rememberTurn(model, effort) { lastTurn = { model, effort }; }

// --- lanes and blocks ------------------------------------------------------

/**
 * One bubble per reply, not one per assistant message.
 *
 * A single prompt can cost a dozen assistant messages — think, call a tool,
 * read the result, call another. Stamping each one made the transcript a wall
 * of headers with two lines of answer buried in it. The bubble is opened by the
 * first thing the agent says and stays open until the run ends, so what the
 * reader scrolls through is: my message, its reply, my message, its reply.
 *
 * Lanes still separate a subagent from the main agent, and a lane that speaks
 * closes the other one — otherwise output from the main agent would be appended
 * *above* a subagent that spoke after it, and the transcript would lie about
 * the order things happened in.
 */
export function laneContainer(lane, meta = null) {
  if (activeLane && activeLane !== lane) lanes[activeLane] = null;
  activeLane = lane;
  if (!lanes[lane]) {
    const box = el('div', `msg ${lane === 'sub' ? 'sub' : ''}`);
    // Falls back to the header's current selection only when a turn produced
    // no message_start to read the real model from.
    box.append(stamp(lane === 'sub' ? 'subagent' : 'agent', meta ?? {
      model: lastTurn.model, effort: lastTurn.effort, at: Date.now(),
    }));
    lanes[lane] = { el: add(box), blocks: new Map(), activity: null };
  }
  return lanes[lane];
}

export function closeLanes() {
  lanes.main = lanes.sub = null;
  activeLane = null;
  // Every card these point at belongs to a finished run, so a late result has
  // nowhere to land anyway. Dropping them keeps the map from growing forever.
  toolCards.clear();
}

/**
 * The activity slot: what the agent is doing *right now*, and only that.
 *
 * Thinking and tool calls are how the answer got made, not the answer. One slot
 * at the bottom of the bubble holds the newest of them; the next step overwrites
 * it, and the reply itself clears it. The full record is still on disk in the
 * transcript log — this is about what the page keeps on screen.
 */
export function showActivity(container, node) {
  container.activity?.remove();
  container.activity = node;
  container.el.append(node);
  return node;
}

export function clearActivity(container) {
  container.activity?.remove();
  container.activity = null;
}

export function blockElement(lane, index, kind) {
  const container = laneContainer(lane);
  let block = container.blocks.get(index);
  if (block) return block;
  block = makeBlock(lane, kind);
  container.blocks.set(index, block);
  return block;
}

export function makeBlock(lane, kind) {
  const container = laneContainer(lane);
  if (kind === 'thinking') {
    const details = el('details', 'act');
    details.append(el('summary', null, 'thinking'));
    const body = el('div', 'body');
    details.append(body);
    showActivity(container, details);
    return { node: body, kind, raw: '' };
  }
  // Text is the reply: it evicts whatever the agent was busy with and stays.
  clearActivity(container);
  const node = el('div', 'text');
  container.el.append(node);
  return { node, kind, raw: '' };
}

/** `HH:MM` — a wall clock is what "when did I ask this" means to a reader. */
export function clock(at) {
  if (!at) return '';
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The strip above every bubble: who or what produced it, on what model, at
 * what effort, when. Written once so a user turn and an agent turn cannot
 * drift into two different layouts.
 */
export function stamp(who, { model, effort, at } = {}) {
  const bar = el('div', 'stamp');
  bar.append(el('span', 'who', who));
  if (model) bar.append(el('span', 'tag', model));
  if (effort) bar.append(el('span', 'tag', `effort ${effort}`));
  if (at) bar.append(el('span', 'when', clock(at)));
  return bar;
}

export function userBubble(text, images, meta = {}) {
  const wrap = el('div', 'msg');
  wrap.append(stamp('user', meta));
  const bubble = el('div', 'user');
  if (images?.length) {
    const strip = el('div', 'shots');
    images.forEach((img, i) => {
      const figure = el('figure');
      const picture = el('img');
      picture.src = `/api/image/${encodeURIComponent(img.id)}`;
      picture.alt = `image ${i + 1}`;
      picture.loading = 'lazy';
      figure.append(picture, el('figcaption', null, `image ${i + 1}`));
      strip.append(figure);
    });
    bubble.append(strip);
  }
  if (text) bubble.append(el('div', 'text', text));
  wrap.append(bubble);
  return wrap;
}

export function toolCard(lane, name, input) {
  const card = el('details', 'tool act');
  card.append(el('summary', null, `${name}  ${summarize(input)}`));
  card.append(el('div', 'args', JSON.stringify(input, null, 2)));
  showActivity(laneContainer(lane), card);
  return card;
}

/** A short, readable hint of what a tool call is doing. */
export function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  const key = ['command', 'file_path', 'path', 'pattern', 'url', 'prompt', 'description']
    .find((k) => typeof input[k] === 'string');
  if (!key) return '';
  const value = input[key].replace(/\s+/g, ' ').trim();
  return value.length > 90 ? `${value.slice(0, 90)}…` : value;
}

// --- history replay --------------------------------------------------------

export function renderHistory(items) {
  transcript.textContent = '';
  closeLanes();
  if (!items.length) return;

  let lastKind = null;
  for (const item of items) {
    lastKind = item.k;
    switch (item.k) {
      case 'user':
        closeLanes();
        if (transcript.firstChild) add(el('div', 'divider turn'), false);
        add(userBubble(item.text, item.images, { at: item.at }), false);
        break;
      case 'turn':
        // Replayed turns carry the model and effort they actually ran on, so
        // history shows what produced it, not today's selection. Only the first
        // turn of a reply stamps a header — the rest join the bubble it opened.
        laneContainer(item.lane ?? 'main', {
          model: item.model, effort: item.effort, at: item.at,
        }).blocks.clear();
        break;
      case 'text': {
        const block = makeBlock(item.lane ?? 'main', 'text');
        renderMarkdown(block.node, item.text);
        break;
      }
      case 'thinking': {
        const block = makeBlock(item.lane ?? 'main', 'thinking');
        block.node.textContent = item.text;
        break;
      }
      case 'tool':
        toolCards.set(item.id, toolCard(item.lane ?? 'main', item.name, item.input));
        break;
      case 'tool_result': {
        const card = toolCards.get(item.id);
        if (!card) break;
        if (item.isError) card.classList.add('err');
        card.append(el('div', 'body', (item.text || '').slice(0, 20000)));
        break;
      }
      case 'result':
        closeLanes();
        add(resultLine(item), false);
        break;
      case 'section':
        closeLanes();
        add(sectionPanel(item), false);
        break;
      case 'rm3':
        closeLanes();
        add(sectionPanel(fromLegacyRm3(item)), false);
        break;
    }
  }
  // ONLY AT A BOUNDARY, AND THIS IS THE WHOLE POINT.
  //
  // The server replays the entire record on every connection, so a reconnect
  // DURING a reply lands here with the record ending mid-turn. Closing the lane
  // then finished a bubble the agent had not finished: the live continuation
  // opened a second one, the same answer appeared as two replies from two
  // stamps, and the half-finished tool card in the first was stranded there
  // forever because nothing would ever replace it.
  //
  // So when the record ends mid-turn the lane stays OPEN — live output carries
  // on into the bubble it belongs to — and no marker is drawn, because a note
  // about the transport does not belong inside a sentence.
  const settled = ['result', 'section', 'rm3', 'notice'].includes(lastKind);
  if (settled) {
    add(el('div', 'divider replay', `record replayed · live from ${clock(Date.now())}`), false);
    closeLanes();
  }
  transcript.scrollTop = transcript.scrollHeight;
}

/**
 * A section belonging to something other than the agent.
 *
 * Whatever is hooked up alongside this chat reports here under its own name —
 * rainsmoke3 today, another agent or interface tomorrow — so a reader can tell
 * without thinking about it who is speaking. The shape is the same for all of
 * them (see REPORTERS in server.mjs); nothing here knows what a "detector" is.
 *
 * Shown on every turn, including a clean one. A section that appears only when
 * something is wrong is indistinguishable from one that was never wired up, and
 * the whole point of a summary is knowing it ran.
 */
export function sectionPanel(ev) {
  const rows = ev.rows ?? [];
  const panel = el('div', `section ${rows.length ? '' : 'clean'}`);
  const head = el('div', 'sectionhead');
  head.append(el('span', 'who', ev.source ?? 'attached'));
  head.append(el('span', 'headline', ev.headline ?? ''));
  for (const count of ev.counts ?? []) {
    head.append(el('span', `sev ${count.label}${count.n ? '' : ' zero'}`, `${count.n} ${count.label}`));
  }
  if (ev.at) head.append(el('span', 'when', clock(ev.at)));
  panel.append(head);

  for (const row of rows) {
    const line = el('div', 'sectionrow');
    line.append(el('span', `sev ${row.severity ?? ''}`, row.severity ?? ''));
    line.append(el('span', 'det', row.label ?? ''));
    line.append(el('span', 'sum', row.detail ?? ''));
    panel.append(line);
  }
  return panel;
}

/**
 * Records written before sections were a shared shape, when rainsmoke3 was the
 * only thing reporting. Adapted rather than dropped: old history stays readable.
 */
export function fromLegacyRm3(item) {
  const total = item.total ?? 0;
  return {
    source: 'rainsmoke3',
    at: item.at,
    headline: total ? `${total} ${total === 1 ? 'issue' : 'issues'}` : 'no issues',
    // Legacy records predate `firelane`, so their own keys are the only
    // honest answer — inventing a zero for a category that did not exist
    // when the record was written would be a claim the record never made.
    counts: Object.entries(item.counts ?? {}).map(([label, n]) => ({
      label, n: n ?? 0,
    })),
    rows: (item.findings ?? []).map((f) => ({
      severity: f.severity, label: f.detector, detail: f.summary || f.entry || '',
    })),
  };
}

/**
 * What a turn spent, in two numbers that mean two different things.
 *
 * THE OWNER, 2026-08-09: "one says 15 in, my prompt is more than 15 tokens
 * long, and pretty sure that isn't cached."
 *
 * Correct, and `input_tokens` was the wrong field to call "in". With caching
 * on, a new prompt is not sent as plain input — it is WRITTEN TO CACHE, and
 * lands in `cache_creation_input_tokens`. `input_tokens` is only the remainder
 * that was neither cached nor cacheable, which is a handful of tokens and
 * means nothing to a reader. Measured on three runs:
 *
 *     input_tokens  cache_creation   what was actually new
 *               15         890,575                 890,590
 *               26          15,468                  15,494
 *
 * So NEW is input + cache_creation — everything this turn added — and CACHED
 * is cache_read alone, the context re-sent on each internal call. The first
 * number is what was said; the second is what it cost to remember.
 */
function tokens(usage) {
  if (!usage) return null;
  const brief = (n) => {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return String(n);
  };
  const fresh = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const parts = [`${brief(fresh)} in`, `${brief(usage.output_tokens ?? 0)} out`];
  const reread = usage.cache_read_input_tokens ?? 0;
  if (reread) parts.push(`${brief(reread)} cached`);
  return `tokens: ${parts.join(' · ')}`;
}

export function resultLine(ev) {
  // The measurement, not a price. A dollar figure is tokens multiplied by a
  // list that changes without the run changing — the same turn "costs"
  // something different next month, and nothing about it moved.
  const spent = tokens(ev.usage)
    ?? (ev.costUsd != null ? `$${ev.costUsd.toFixed(4)}` : '—');
  const secs = ev.durationMs != null ? `${(ev.durationMs / 1000).toFixed(1)}s` : '—';
  return el('div', `result ${ev.isError ? 'error' : ''}`,
    `${ev.subtype} · ${ev.turns} turns · ${secs} · ${spent}`);
}



/**
 * The block a lane is streaming into, or undefined.
 *
 * Exists because `events.js` reached into `lanes[x].blocks` directly while both
 * lived in one file — a coupling nothing could see. A module that hands out its
 * internals has no seam; this is the seam.
 */
export function blockAt(lane, index) {
  return lanes[lane]?.blocks.get(index);
}

/** The tool cards a turn has opened, keyed by tool_use_id. */
export { toolCards };
