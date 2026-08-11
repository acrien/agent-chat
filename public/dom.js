/**
 * dom.js — the handles and helpers every other module needs.
 *
 * SPLIT OUT OF ONE 1,420-LINE FILE, 2026-08-09, after an edit to the turn-cost
 * display deleted the heartbeat panel, the jobs page and the window splitter:
 * they sat in the same file and the edit was a span, so it took everything
 * between two markers. Nothing here can reach any of those now, because
 * "everything between two markers" no longer spans three subjects.
 *
 * THE ONE PLACE THE DOM IS NAMED. Every element the page owns is looked up
 * here and nowhere else, so a renamed id breaks in one file rather than in
 * whichever module happened to query it.
 */

const $ = (id) => document.getElementById(id);
const transcript = $('transcript');

const els = {
  gate: $('gate'), loginForm: $('loginForm'), loginName: $('loginName'), knownUsers: $('knownUsers'),
  dot: $('dot'), user: $('user'), cwd: $('cwd'), model: $('model'), effort: $('effort'),
  interrupt: $('interrupt'), input: $('input'), send: $('send'),
  tray: $('tray'), trayItems: $('trayItems'), clearImages: $('clearImages'),
  beat: $('beat'), beatPulse: $('beatPulse'), beatBody: $('beatBody'),
  beatHide: $('beatHide'), beatShow: $('beatShow'),
  split: document.querySelector('.split'), grip: $('grip'),
  settings: $('settings'), settingsBody: $('settingsBody'),
  settingsTitle: $('settingsTitle'), settingsLead: $('settingsLead'),
  settingsOpen: $('settingsOpen'), settingsClose: $('settingsClose'),
  llmsOpen: $('llmsOpen'),
};

function atBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
}
function add(node, stick = atBottom()) {
  transcript.append(node);
  if (stick) transcript.scrollTop = transcript.scrollHeight;
  return node;
}
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** Chrome that says whether a run is in flight. */
export let busy = false;
export function setBusy(value) {
  busy = value;
  els.interrupt.disabled = !value;
  els.dot.className = `dot ${value ? 'busy' : 'live'}`;
}

/** A one-line message in the transcript. Here because three modules need it. */
export function notice(text, isError = false) {
  add(el('div', `notice ${isError ? 'error' : ''}`, text));
}

export { $, transcript, els, atBottom, add, el };
