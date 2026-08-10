/**
 * events.js — one SSE event in, one change to the page out.
 */
// `busy` is a live binding from dom.js — reading it without importing it
// threw ReferenceError on every `session` event (ES modules are strict).
import { add, atBottom, busy, el, els, notice, setBusy, transcript } from './dom.js';
import { chime } from './chime.js';
import {
  blockAt, closeLanes, jobBubble, laneContainer, blockElement, makeBlock,
  renderHistory, rememberTurn, resultLine, sectionPanel, toolCard, toolCards,
  userBubble,
} from './transcript.js';
import { renderBeat, setBeat } from './heartbeat.js';
import { renderMarkdown } from './markdown.js';
import { labelDefaultEffort } from './transport.js';

// --- live events -----------------------------------------------------------

export function handle(ev) {
  const stick = atBottom();

  switch (ev.t) {
    case 'hello':
      els.user.textContent = ev.user;
      els.cwd.textContent = ev.cwd;
      if (ev.activeEffort) labelDefaultEffort(ev.activeEffort);
      setBusy(Boolean(ev.busy));
      break;

    case 'history':
      renderHistory(ev.items ?? []);
      break;

    case 'session':
      els.cwd.textContent = ev.cwd;
      setBusy(busy);
      break;

    case 'user':
      closeLanes();
      // An exchange ends where the next one begins. Drawn here rather than
      // after the reply because there is no event meaning "the agent is
      // finished" — `result` ends a run, and rainsmoke3's section arrives
      // after it, so anything drawn on `result` lands in the middle.
      if (transcript.firstChild) add(el('div', 'divider turn'), false);
      add(userBubble(ev.text, ev.images, { at: ev.at }));
      setBusy(true);
      break;

    case 'job':
      // A turn the owner did not start. Same divider, deliberately NOT the
      // same bubble — see jobBubble on why a job may not wear the owner's face.
      closeLanes();
      if (transcript.firstChild) add(el('div', 'divider turn'), false);
      add(jobBubble(ev));
      setBusy(true);
      break;

    case 'turn_start': {
      rememberTurn(ev.model, ev.effort);
      // Build the container now so its stamp carries this turn's own model
      // and effort rather than whatever is selected when the first token lands.
      const container = laneContainer(ev.lane, {
        model: ev.model, effort: ev.effort, at: ev.at,
      });
      // Block indices restart at 0 on every assistant message and the bubble
      // outlives them, so forget the old mapping rather than write this
      // message's first block into the last one's element.
      container.blocks.clear();
      break;
    }

    case 'effort_in_force':
      // What "default" actually resolves to, learned from the SDK.
      labelDefaultEffort(ev.effort);
      break;

    case 'block_start':
      blockElement(ev.lane, ev.index, ev.kind);
      break;

    case 'delta': {
      const block = blockElement(ev.lane, ev.index, ev.kind);
      block.raw += ev.text;
      block.node.textContent = block.raw;
      break;
    }

    case 'block_stop': {
      const block = blockAt(ev.lane, ev.index);
      if (block && block.kind === 'text') renderMarkdown(block.node, block.raw);
      break;
    }

    case 'tool_use':
      toolCards.set(ev.id, toolCard(ev.lane, ev.name, ev.input));
      break;

    case 'tool_result': {
      const card = toolCards.get(ev.id);
      if (!card) break;
      if (ev.isError) card.classList.add('err');
      card.append(el('div', 'body', (ev.text || '').slice(0, 20000)));
      break;
    }

    case 'result':
      setBusy(false);
      closeLanes();
      // The run has ended — not the last delta. See chime.js.
      chime();
      add(resultLine(ev));
      if (ev.isError && ev.text) add(el('div', 'result error', ev.text));
      break;

    case 'section':
      add(sectionPanel(ev));
      break;

    case 'heartbeat':
      setBeat(ev);
      break;

    case 'notice':
      notice(ev.text);
      break;

    case 'error':
      setBusy(false);
      notice(ev.text, true);
      break;
  }

  if (stick) transcript.scrollTop = transcript.scrollHeight;
}

