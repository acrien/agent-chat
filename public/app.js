/**
 * agent-chat front end.
 *
 * One SSE stream in, POSTs out. Text and thinking arrive as deltas and are
 * appended to a live element; tool calls arrive already finalized; history is
 * replayed once on connect. Model output is written with textContent only —
 * never innerHTML — so nothing the agent or a tool result emits can inject
 * markup into this page.
 *
 * Pasted images live in a numbered tray, independent of where they were pasted
 * in the typing order, and are always sent ahead of the text. That is the whole
 * point of the tray: "image 2" means the same thing here, in the request, and
 * to the model.
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
};

/** Long edge of the current high-resolution vision tier. */
const MAX_EDGE = 2576;
const MAX_BYTES = 3_500_000;
const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 10;

let busy = false;
let models = [];
/** Model/effort reported for the turn now streaming — see `turn_start`. */
let lastTurn = { model: null, effort: null };
let pending = [];                  // the numbered tray, in send order
const toolCards = new Map();       // tool_use_id -> <details>
const lanes = { main: null, sub: null };
/** Which lane owns the open bubble at the bottom — see `laneContainer`. */
let activeLane = null;

// --- dom helpers -----------------------------------------------------------

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

/**
 * Render the agent's markdown as structure.
 *
 * The model writes markdown, so a page that shows it verbatim is showing the
 * source of a document instead of the document: `**` and backticks as literal
 * noise, list items as ordinary sentences, headings indistinguishable from
 * body text. What it reads like is a wall — every line weighted the same, with
 * nothing for the eye to catch on.
 *
 * Structure is what fixes that, and it is nearly free vertically: a bold run,
 * a bullet's hanging indent and a heading's weight are all things you can see
 * without scrolling past them. Rendering markup even *removes* characters.
 * Spacing is deliberately not the tool being used here — it was the expensive
 * one, and it is the one already spent.
 *
 * Everything goes in via textContent and createElement — never innerHTML — so
 * nothing the agent or a tool result emits can inject markup into this page.
 * Links are the one thing carrying a URL, and only http(s) survives the check.
 */
const FENCE = /^\s{0,3}```/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBER = /^(\s*)(\d+)[.)]\s+(.*)$/;
const ROW = /^\s*\|(.+)\|\s*$/;
const DIVIDER = /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/;
/* A LABELLED CALLOUT, DECLARED RATHER THAN GUESSED.

   This was `/^[A-Z][A-Z0-9 ]{2,23}:/` — three or more capitals and a colon —
   which is a guess about what a line MEANS from how it happens to be spelled.
   It would open a section on "TODO: fix" and on "NASA: founded 1958", and it
   would silently stop working the day a label was written in title case.

   But this text is our own output. There is no need to infer the intent of a
   line when the line can simply state it, so the marker is explicit.

   IT IS DELIBERATELY NOT MADE OF COMMON CHARACTERS. `#-` was the first choice
   and it is the kind of thing that turns up for real: a shell comment, a diff
   marker, a decorated heading in someone's notes. A marker that CAN collide
   will, and the failure is silent — a quoted line becomes a section, or worse,
   the raw marker prints on the page. `§§` is two section signs: it appears in
   legal citation, essentially never in code or console output, and never twice
   in a row by accident. The label is untouched either way, so rainsmoke3's
   gate still finds `PREVENTION:` inside it.

       §§ Rainsmoke; Prevention (progress: no change under cwd): the answer

   The label may CONTAIN a colon inside parentheses, which is why it is not
   simply "everything up to the first colon": rainsmoke3 names the rule that
   fired and what it caught, and both belong in the label rather than in the
   body. A parenthesised run is matched whole, so the colon that ends the
   label is the first one outside brackets. */
const CALLOUT = /^\s{0,3}§§[ \t]*((?:[^:\n(]|\([^)\n]*\))+):[ \t]*([\s\S]*)$/;
/* A marked line that carries no terminator. The marker still says what it is,
   so the marker still comes off — leaking it onto the page is the one outcome
   worse than an unstyled line, because it shows the reader our syntax. */
const MARKER = /^\s{0,3}§§[ \t]*/;
const CALLOUT_LEVEL = 2;   // closes and is closed by an h2, which is what it is

function renderMarkdown(target, text) {
  target.textContent = '';
  blocks(target, text.split('\n'));
}

/**
 * ONE RULE, AND IT IS A DECLARATION.
 *
 * This was a list of patterns — prevention, unrepresentable, rm3, heartbeat,
 * finding, severity — which is a list of the things rainsmoke3 happened to say
 * BY THE DATE IT WAS WRITTEN. Every detector added after it would have arrived
 * uncoloured, and nothing would have reported that: the tab would simply be the
 * wrong colour, on the one class of message whose whole point is being
 * identifiable as not the agent's own voice. A list of today's names is a list
 * that is wrong from tomorrow.
 *
 * So the rule is the attribution itself. Anything rainsmoke3 surfaces is
 * labelled `Rainsmoke; …` at the point it is written, and that prefix — not
 * its subject, not its vocabulary — is what makes it green. A detector shipped
 * next year needs no entry here, because there are no entries here.
 */
/* NO WORD BOUNDARY. `rainsmoke\b` does not match "Rainsmoke3" — the boundary
   needs a non-word character after "rainsmoke", and a digit is a word
   character. So the project's own name, spelled the way it is spelled
   everywhere else, resolved to the agent's colour. A prefix is what was meant
   and a prefix is what it now says. */
const RAINSMOKE = /^\s*rainsmoke/i;

function roleOf(label) {
  return RAINSMOKE.test(label) ? 'rm3' : 'ask';
}

/**
 * One pass over lines, each branch consuming the whole block it recognises.
 *
 * Headings OPEN A SECTION and everything after them is nested inside it, so a
 * heading's rail runs the height of what it covers and its content is indented
 * under it. A deeper heading nests again; a heading at the same level or
 * shallower closes back to its own depth. Flat markdown carries that structure
 * implicitly — every reader infers it — and inferring it is exactly the work
 * the wall of text was making them do.
 */
function blocks(target, lines) {
  const open = [];                       // [{level, node}], innermost last
  const into = () => (open.length ? open[open.length - 1].node : target);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    if (FENCE.test(line)) {
      // The info string is the language the model said it was writing. It was
      // being thrown away; it is the one label a code block can carry that the
      // code itself does not already say.
      const info = line.replace(/^\s*```/, '').trim().split(/\s+/)[0];
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i += 1;                                    // the closing fence, if it came
      const fence = el('div', 'fence');
      if (info) fence.append(el('span', 'lang', info));
      const pre = el('pre');
      pre.append(el('code', null, body.join('\n')));
      fence.append(pre);
      into().append(fence);
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      while (open.length && open[open.length - 1].level >= level) open.pop();
      const section = el('section', `sec ${roleOf(heading[2])}`);
      into().append(section);              // BEFORE the push: it belongs to the
      open.push({ level, node: section });  // section above it, not to itself
      inline(section.appendChild(el(`h${level}`)), heading[2]);
      i += 1;
      continue;
    }

    if (RULE.test(line)) { into().append(el('hr')); i += 1; continue; }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)[1]);
      const quote = el('blockquote');
      blocks(quote, body);
      into().append(quote);
      continue;
    }

    if (BULLET.test(line) || NUMBER.test(line)) { i = list(into(), lines, i); continue; }

    if (ROW.test(line) && i + 1 < lines.length && DIVIDER.test(lines[i + 1])) {
      i = table(into(), lines, i);
      continue;
    }

    // Anything else is a paragraph: everything up to a blank line or a block.
    const body = [];
    while (i < lines.length && lines[i].trim() && !starts(lines[i])) body.push(lines[i++]);
    if (!body.length) body.push(lines[i++]);     // a block opener we cannot pair
    const text = body.join('\n');

    // A LABELLED CALLOUT OPENS A SECTION, exactly as a heading does.
    //
    // `PREVENTION:` is the case that forced this. rainsmoke3's gate matches it
    // anywhere in the reply (rm3/prevention.py:74 searches for the word, not a
    // line start), so it cannot be written as a heading — and the rail, which
    // only applied to `#` headings, skipped the one block on the page most
    // worth finding. `§§` marks it instead: declared, not detected.
    const callout = text.match(CALLOUT);
    if (callout) {
      while (open.length && open[open.length - 1].level >= CALLOUT_LEVEL) open.pop();
      const section = el('section', `sec ${roleOf(callout[1])}`);
      into().append(section);
      open.push({ level: CALLOUT_LEVEL, node: section });
      section.appendChild(el('h4', 'label', callout[1]));
      if (callout[2].trim()) inline(section.appendChild(el('p')), callout[2]);
      continue;
    }
    // A marked line that did not parse as a callout — no terminating colon.
    // The marker is still stripped: it is our syntax, and the reader should
    // never see it. THE ARBITRARY CAP THAT USED TO LIVE HERE is why this
    // matters — an 80-character limit silently rejected an 84-character label
    // and printed the raw `#-` on the page. The cap guarded against a sentence
    // being mistaken for a label, which the marker had already made impossible.
    // A PARAGRAPH THAT ENDS IN A COLON IS INTRODUCING SOMETHING, not making a
    // statement. It reads as ordinary prose while behaving as a caption for
    // whatever follows, so the reader gets a sentence that seems to stop short.
    // Marked on the last character, never on the words, so it holds for any
    // lead-in and needs no vocabulary to keep up to date.
    const body_ = text.replace(MARKER, '');
    inline(into().appendChild(el('p', body_.trimEnd().endsWith(':') ? 'lead' : null)), body_);
  }
}

/** Does this line open a block, and so end the paragraph before it? */
function starts(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line)
    || QUOTE.test(line) || BULLET.test(line) || NUMBER.test(line)
    // A callout opens a block, so it ends the paragraph above it rather than
    // being swallowed into one.
    || CALLOUT.test(line);
}

/**
 * A list, and any list nested inside it.
 *
 * Nesting is read from indentation: a deeper item belongs to the item above it,
 * which is the only thing the model's own indentation can mean.
 */
function list(target, lines, start) {
  const first = lines[start].match(BULLET) ?? lines[start].match(NUMBER);
  const ordered = !lines[start].match(BULLET);
  const depth = first[1].length;
  const box = el(ordered ? 'ol' : 'ul');
  let i = start;

  while (i < lines.length) {
    const match = lines[i].match(BULLET) ?? lines[i].match(NUMBER);
    if (!match) {
      // A wrapped continuation line belongs to the item it is under.
      if (lines[i].trim() && box.lastChild && lines[i].search(/\S/) > depth) {
        box.lastChild.append(document.createTextNode(`\n${lines[i].trim()}`));
        i += 1;
        continue;
      }
      break;
    }
    if (match[1].length < depth) break;
    if (match[1].length > depth) {
      if (!box.lastChild) break;
      i = list(box.lastChild, lines, i);
      continue;
    }
    if (!!lines[i].match(BULLET) === ordered) break;   // a different kind of list
    inline(box.appendChild(el('li')), match[3]);
    i += 1;
  }

  target.append(box);
  return i;
}

/** A pipe table, which is a shape prose cannot carry. */
function table(target, lines, start) {
  const cells = (line) => line.match(ROW)[1].split('|').map((c) => c.trim());
  const box = el('table');
  const head = el('tr');
  for (const cell of cells(lines[start])) inline(head.appendChild(el('th')), cell);
  box.append(head);

  let i = start + 2;
  while (i < lines.length && ROW.test(lines[i])) {
    const row = el('tr');
    for (const cell of cells(lines[i])) inline(row.appendChild(el('td')), cell);
    box.append(row);
    i += 1;
  }
  target.append(box);
  return i;
}

/** `code` first: whatever it holds is text, not markup to look inside. */
const SPANS = /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*(\S[\s\S]*?)\*|_(\S[\s\S]*?)_|\[([^\]\n]*)\]\(([^)\s]+)\)/g;

function inline(target, text) {
  let at = 0;
  for (const m of text.matchAll(SPANS)) {
    if (m.index > at) target.append(document.createTextNode(text.slice(at, m.index)));
    at = m.index + m[0].length;
    if (m[2] != null) target.append(el('code', null, m[2]));
    else if (m[3] != null) target.append(el('strong', null, m[3]));
    else if (m[4] != null) target.append(el('strong', null, m[4]));
    else if (m[5] != null) target.append(el('em', null, m[5]));
    else if (m[6] != null) target.append(el('em', null, m[6]));
    else target.append(link(m[7], m[8]));
  }
  if (at < text.length) target.append(document.createTextNode(text.slice(at)));
  return target;
}

/**
 * Only http(s) becomes a link. A `javascript:` or `data:` href is a script the
 * page would run on click, and the agent does not get to write one of those.
 */
function link(label, href) {
  if (!/^https?:\/\//i.test(href)) return document.createTextNode(`${label} (${href})`);
  const anchor = el('a', null, label || href);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function setBusy(value) {
  busy = value;
  els.interrupt.disabled = !value;
  els.dot.className = `dot ${value ? 'busy' : 'live'}`;
}

// --- images: normalize ------------------------------------------------------

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Bring an arbitrary pasted blob into something the API accepts.
 *
 * Two independent reasons to re-encode: the type may not be one of the four
 * the API takes, or the image may be larger than the model can use — anything
 * past the vision tier's long edge is downscaled server-side anyway, so
 * sending it whole just costs upload time and tokens.
 */
async function normalize(blob) {
  const oversize = blob.size > MAX_BYTES;
  if (SENDABLE.has(blob.type) && !oversize) {
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (bitmap && Math.max(bitmap.width, bitmap.height) <= MAX_EDGE) {
      bitmap.close?.();
      return { mediaType: blob.type, data: await toBase64(blob) };
    }
    bitmap?.close?.();
  }

  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  // PNG keeps screenshot text crisp; photos would balloon, so fall back.
  let out = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  if (!out || out.size > MAX_BYTES) {
    out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  }
  return { mediaType: out.type, data: await toBase64(out) };
}

// --- images: the numbered tray ---------------------------------------------

let dragFrom = null;

function drawTray() {
  els.tray.hidden = pending.length === 0;
  els.trayItems.textContent = '';

  pending.forEach((img, index) => {
    const chip = el('div', 'chip');
    chip.draggable = true;

    const thumb = el('img');
    thumb.src = `data:${img.mediaType};base64,${img.data}`;
    thumb.alt = `image ${index + 1}`;
    chip.append(thumb);
    chip.append(el('span', 'num', String(index + 1)));

    const remove = el('button', 'x', '×');
    remove.title = 'remove';
    remove.addEventListener('click', () => {
      pending.splice(index, 1);
      drawTray();
    });
    chip.append(remove);

    chip.addEventListener('dragstart', (e) => {
      dragFrom = index;
      e.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag without payload.
      e.dataTransfer.setData('text/plain', String(index));
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => {
      dragFrom = null;
      chip.classList.remove('dragging');
    });
    chip.addEventListener('dragover', (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      chip.classList.add('over');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('over'));
    chip.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();          // do not let the composer treat this as a file drop
      chip.classList.remove('over');
      if (dragFrom === null || dragFrom === index) return;
      const [moved] = pending.splice(dragFrom, 1);
      pending.splice(index, 0, moved);
      drawTray();                   // renumbering falls out of redrawing from the array
    });

    els.trayItems.append(chip);
  });
}

async function addImages(blobs) {
  for (const blob of blobs) {
    if (pending.length >= MAX_IMAGES) {
      notice(`at most ${MAX_IMAGES} images per message`, true);
      break;
    }
    try {
      pending.push(await normalize(blob));
      drawTray();
    } catch (err) {
      notice(`could not read that image: ${err.message}`, true);
    }
  }
}

function notice(text, isError = false) {
  add(el('div', `notice ${isError ? 'error' : ''}`, text));
}

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
function laneContainer(lane, meta = null) {
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

function closeLanes() {
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
function showActivity(container, node) {
  container.activity?.remove();
  container.activity = node;
  container.el.append(node);
  return node;
}

function clearActivity(container) {
  container.activity?.remove();
  container.activity = null;
}

function blockElement(lane, index, kind) {
  const container = laneContainer(lane);
  let block = container.blocks.get(index);
  if (block) return block;
  block = makeBlock(lane, kind);
  container.blocks.set(index, block);
  return block;
}

function makeBlock(lane, kind) {
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
function clock(at) {
  if (!at) return '';
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The strip above every bubble: who or what produced it, on what model, at
 * what effort, when. Written once so a user turn and an agent turn cannot
 * drift into two different layouts.
 */
function stamp(who, { model, effort, at } = {}) {
  const bar = el('div', 'stamp');
  bar.append(el('span', 'who', who));
  if (model) bar.append(el('span', 'tag', model));
  if (effort) bar.append(el('span', 'tag', `effort ${effort}`));
  if (at) bar.append(el('span', 'when', clock(at)));
  return bar;
}

function userBubble(text, images, meta = {}) {
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

function toolCard(lane, name, input) {
  const card = el('details', 'tool act');
  card.append(el('summary', null, `${name}  ${summarize(input)}`));
  card.append(el('div', 'args', JSON.stringify(input, null, 2)));
  showActivity(laneContainer(lane), card);
  return card;
}

/** A short, readable hint of what a tool call is doing. */
function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  const key = ['command', 'file_path', 'path', 'pattern', 'url', 'prompt', 'description']
    .find((k) => typeof input[k] === 'string');
  if (!key) return '';
  const value = input[key].replace(/\s+/g, ' ').trim();
  return value.length > 90 ? `${value.slice(0, 90)}…` : value;
}

// --- history replay --------------------------------------------------------

function renderHistory(items) {
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
function sectionPanel(ev) {
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
function fromLegacyRm3(item) {
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
 * What a turn spent, in three numbers that mean three different things.
 *
 * THE OWNER, 2026-08-09: "there's 12 mil token input in that one prompt?"
 *
 * There was, and it was cache reads. Measured on a 14-turn run: 26 fresh input
 * tokens, 15k written to cache, and 12,839,496 read back from it — the same
 * context re-read on every internal call. Adding those together produced a
 * headline of "12.8M in", which is arithmetically true and says nothing a
 * reader wants: it reports how many times a large context was re-sent, not how
 * much was said. They are kept apart because they are paid for at different
 * rates and caused by different things — output is what the model produced,
 * input is what was newly given to it, and cache is the cost of the
 * conversation being long.
 */
function tokens(usage) {
  if (!usage) return null;
  const brief = (n) => {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return String(n);
  };
  const cached = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const parts = [
    `${brief(usage.input_tokens ?? 0)} in`,
    `${brief(usage.output_tokens ?? 0)} out`,
  ];
  if (cached) parts.push(`${brief(cached)} cached`);
  return `tokens: ${parts.join(' · ')}`;
}

function resultLine(ev) {
  // The measurement, not a price. A dollar figure is tokens multiplied by a
  // list that changes without the run changing — the same turn "costs"
  // something different next month, and nothing about it moved.
  const spent = tokens(ev.usage)
    ?? (ev.costUsd != null ? `$${ev.costUsd.toFixed(4)}` : '—');
  const secs = ev.durationMs != null ? `${(ev.durationMs / 1000).toFixed(1)}s` : '—';
  return el('div', `result ${ev.isError ? 'error' : ''}`,
    `${ev.subtype} · ${ev.turns} turns · ${secs} · ${spent}`);
}

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
function tick(at) {
  return new Date(at * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function ago(seconds) {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
}

/** As many beats as fit a glance; the record keeps the rest. */
const BEAT_ROWS = 40;

function secondsSince(at) {
  return at ? Date.now() / 1000 - at : 0;
}

function renderBeat() {
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
  const log = el('div', 'beatLog');
  for (const row of recent) {
    const line = el('div', `row ${row.state ?? ''}`);
    line.append(el('span', 't', tick(row.at)));
    // WHICH JOB SAID IT. Beats written before jobs existed carry no label and
    // fall back rather than rendering a blank bracket.
    line.append(el('span', 'src', `[${row.label ?? row.job ?? 'heartbeat'}]`));
    line.append(el('span', 's', row.state ?? '?'));
    log.append(line);
  }
  body.append(log);
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

// --- the jobs page ---------------------------------------------------------

/**
 * TWO LAYERS: what the heartbeat does, then one job's settings.
 *
 * Both drawn from what rainsmoke3 sends — label, description, enabled state,
 * and the tunables that job owns — so neither knows a job's name and adding one
 * is a change in one project.
 */
function drawJobList(report) {
  const body = els.settingsBody;
  body.textContent = '';
  els.settingsTitle.textContent = 'jobs';
  els.settingsLead.textContent =
    'What the heartbeat does. Each runs on its own and carries its own settings.';

  for (const job of report.jobs ?? []) {
    const row = el('div', `jobRow ${job.enabled ? '' : 'off'}`);
    const head = el('div', 'jobRowHead');
    head.append(el('span', 'name', job.label));

    // Three buttons, one shape: they are the same KIND of control. The switch
    // stays distinct because it says what IS rather than where it goes.
    const toggle = el('button', 'pill on-off', job.enabled ? 'on' : 'off');
    toggle.type = 'button';
    toggle.setAttribute('aria-pressed', String(job.enabled));
    toggle.addEventListener('click', async () => {
      const res = await post('/api/jobs', { job: job.name, on: !job.enabled });
      if (res.ok) drawJobList(await res.json());
    });
    head.append(toggle);

    const count = (job.tunables ?? []).length;
    const config = el('button', 'pill', count ? `config (${count})` : 'config');
    config.type = 'button';
    config.addEventListener('click', () => drawJobConfig(report, job.name));
    head.append(config);

    const info = el('button', 'pill info', 'info');
    info.type = 'button';
    info.setAttribute('aria-expanded', 'false');
    head.append(info);
    row.append(head);

    const does = el('p', 'means', job.does);
    does.hidden = true;
    info.addEventListener('click', () => {
      does.hidden = !does.hidden;
      info.setAttribute('aria-expanded', String(!does.hidden));
      info.classList[does.hidden ? 'remove' : 'add']('open');
    });
    row.append(does);
    body.append(row);
  }
}

function drawJobConfig(report, name) {
  const job = (report.jobs ?? []).find((j) => j.name === name);
  if (!job) return drawJobList(report);

  const body = els.settingsBody;
  body.textContent = '';
  els.settingsTitle.textContent = job.label;
  els.settingsLead.textContent = job.does;

  const back = el('button', 'pill back', '← all jobs');
  back.type = 'button';
  back.addEventListener('click', () => drawJobList(report));
  body.append(back);

  if (!job.enabled) {
    body.append(el('p', 'origin',
      'this job is switched off — its settings still apply when it runs'));
  }

  for (const t of job.tunables ?? []) {
    const row = el('div', 'tunable');
    const label = el('label');
    label.append(el('span', 'name', t.name.replace(/^heartbeat_|^miss_review_/, '').replace(/_/g, ' ')));
    const input = el('input');
    input.type = 'number';
    input.value = String(t.value);
    input.min = String(t.low);
    input.max = String(t.high);
    input.addEventListener('change', async () => {
      const res = await post('/api/jobs', { name: t.name, value: input.value });
      if (res.ok) drawJobConfig(await res.json(), name);
    });
    label.append(input);
    label.append(el('span', 'unit', t.unit));

    // The (i) carries the WHY. The registry knows it, so the page can offer it
    // without spending a paragraph on every setting by default.
    const why = el('button', 'iCircle', 'i');
    why.type = 'button';
    why.title = 'what this setting does';
    why.setAttribute('aria-expanded', 'false');
    label.append(why);
    row.append(label);

    const means = el('p', 'means', t.means);
    means.hidden = true;
    const origin = el('p', 'origin', t.owner_set
      ? `set by you · default ${t.default} ${t.unit} · range ${t.low}–${t.high}`
      : `default (${t.default} ${t.unit}) — you have not changed this · range ${t.low}–${t.high}`);
    origin.hidden = true;
    why.addEventListener('click', () => {
      means.hidden = origin.hidden = !means.hidden;
      why.setAttribute('aria-expanded', String(!means.hidden));
      why.classList[means.hidden ? 'remove' : 'add']('open');
    });
    row.append(means);
    row.append(origin);
    body.append(row);
  }
}

const drawSettings = drawJobList;

async function openSettings() {
  els.settings.hidden = false;
  els.settingsBody.textContent = 'loading…';
  const res = await fetch('/api/jobs').catch(() => null);
  // SAY WHICH THING FAILED. This reported "rainsmoke3 is not answering" for a
  // 404 — the server had simply not been restarted since the route was added.
  if (!res) {
    els.settingsBody.textContent = 'the page cannot reach the server.';
    return;
  }
  if (res.status === 404) {
    els.settingsBody.textContent =
      'this server build has no jobs route — it needs restarting to pick it up.';
    return;
  }
  if (!res.ok) {
    const why = await res.json().catch(() => ({}));
    els.settingsBody.textContent = why.error ?? `jobs unavailable (HTTP ${res.status}).`;
    return;
  }
  drawJobList(await res.json());
}

els.settingsOpen.addEventListener('click', openSettings);
els.settingsClose.addEventListener('click', () => { els.settings.hidden = true; });

els.beatHide.addEventListener('click', () => {
  els.beat.hidden = true;
  els.grip.hidden = true;
  els.beatShow.hidden = false;
});
els.beatShow.addEventListener('click', () => {
  els.beat.hidden = false;
  els.grip.hidden = false;
  els.beatShow.hidden = true;
});

// --- the splitter ----------------------------------------------------------

/**
 * Drag the handle to resize; double-click to reset.
 *
 * The width lives on `.split` as a custom property and in localStorage, so it
 * is one number in one place. Stored in pixels rather than a fraction: a panel
 * is sized for the text in it, and a fraction would resize it every time the
 * window changed. Pointer events cover mouse, touch and pen with one path, and
 * `setPointerCapture` keeps the drag alive when the pointer outruns the handle.
 */
const BEAT_MIN = 200;
const BEAT_DEFAULT = '20rem';

function setBeatWidth(px) {
  const most = Math.max(BEAT_MIN, window.innerWidth - 320);
  const width = Math.round(Math.min(Math.max(px, BEAT_MIN), most));
  els.split.style.setProperty('--beat-w', `${width}px`);
  try { localStorage.setItem('beatWidth', String(width)); } catch { /* private mode */ }
}

els.grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  els.grip.setPointerCapture(e.pointerId);
  els.grip.classList.add('dragging');
  document.body.classList.add('resizing');
});

els.grip.addEventListener('pointermove', (e) => {
  if (!els.grip.hasPointerCapture(e.pointerId)) return;
  // Measured from the right edge of the split, so the panel tracks the pointer
  // exactly rather than drifting by the handle's own width.
  setBeatWidth(els.split.getBoundingClientRect().right - e.clientX);
});

for (const done of ['pointerup', 'pointercancel']) {
  els.grip.addEventListener(done, (e) => {
    els.grip.releasePointerCapture?.(e.pointerId);
    els.grip.classList.remove('dragging');
    document.body.classList.remove('resizing');
  });
}

els.grip.addEventListener('dblclick', () => {
  els.split.style.setProperty('--beat-w', BEAT_DEFAULT);
  try { localStorage.removeItem('beatWidth'); } catch { /* private mode */ }
});

try {
  const saved = Number(localStorage.getItem('beatWidth'));
  if (saved > 0) setBeatWidth(saved);
} catch { /* private mode: the default stands */ }

// --- live events -----------------------------------------------------------

function handle(ev) {
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

    case 'turn_start': {
      lastTurn = { model: ev.model, effort: ev.effort };
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
      const block = lanes[ev.lane]?.blocks.get(ev.index);
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
      add(resultLine(ev));
      if (ev.isError && ev.text) add(el('div', 'result error', ev.text));
      break;

    case 'section':
      add(sectionPanel(ev));
      break;

    case 'heartbeat':
      beatState = ev;
      renderBeat();
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

// --- transport -------------------------------------------------------------

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    notice(info.error ?? `${path} failed`, true);
  }
  return res;
}

let effortInForce = null;

/**
 * Say what "default" resolves to, rather than leaving it a blank.
 *
 * The level is only knowable once the SDK reports it — `supportedModels()`
 * lists which levels a model allows, not which is active, and the init
 * response carries none. So the label fills in after the first turn instead
 * of asserting a number nothing measured.
 */
function labelDefaultEffort(level) {
  effortInForce = level ?? effortInForce;
  const fallback = els.effort.querySelector('option[value=""]');
  if (fallback) fallback.textContent = effortInForce ? `default (${effortInForce})` : 'default';
}

function fillEffort(modelValue) {
  const info = models.find((m) => m.value === modelValue);
  const levels = info?.supportsEffort ? (info.supportedEffortLevels ?? []) : [];
  els.effort.textContent = '';
  const fallback = el('option', null, 'default');
  fallback.value = '';
  els.effort.append(fallback);
  labelDefaultEffort(null);
  for (const level of levels) {
    const option = el('option', null, level);
    option.value = level;
    els.effort.append(option);
  }
  // A model without effort support has nothing to choose.
  els.effort.disabled = levels.length === 0;
}

async function loadModels() {
  const data = await (await fetch('/api/models')).json();
  models = data.models ?? [];
  els.model.textContent = '';
  for (const m of models) {
    // Name the model the row actually resolves to. "Default (recommended)"
    // does not tell you which LLM you are talking to; the resolved id does.
    const resolved = m.resolvedModel && m.resolvedModel !== m.value ? ` — ${m.resolvedModel}` : '';
    const option = el('option', null, `${m.displayName || m.value}${resolved}`);
    option.value = m.value;
    option.title = m.description ?? '';
    els.model.append(option);
  }
  if (data.current) els.model.value = data.current;
  fillEffort(els.model.value);
  if (data.effort) els.effort.value = data.effort;
  if (data.activeEffort) labelDefaultEffort(data.activeEffort);
}

async function send() {
  const text = els.input.value.trim();
  if (!text && pending.length === 0) return;
  const images = pending.map(({ mediaType, data }) => ({ mediaType, data }));
  els.input.value = '';
  els.input.style.height = 'auto';
  pending = [];
  drawTray();
  await post('/api/send', { text, images });
}

// --- wiring ----------------------------------------------------------------

els.send.addEventListener('click', send);

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

els.input.addEventListener('input', () => {
  els.input.style.height = 'auto';
  els.input.style.height = `${els.input.scrollHeight}px`;
});

// Paste anywhere on the page, not just the textarea: an image never lands as
// text in the box, it goes to the tray.
document.addEventListener('paste', (e) => {
  const blobs = [...(e.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!blobs.length) return;
  e.preventDefault();
  addImages(blobs);
});

for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    if (type === 'drop') {
      addImages([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
    }
  });
}

els.clearImages.addEventListener('click', () => { pending = []; drawTray(); });

els.model.addEventListener('change', async () => {
  await post('/api/model', { model: els.model.value });
  fillEffort(els.model.value);
  await post('/api/effort', { effort: els.effort.value });
});

els.effort.addEventListener('change', () => post('/api/effort', { effort: els.effort.value }));
els.interrupt.addEventListener('click', () => post('/api/interrupt'));

els.cwd.addEventListener('click', async () => {
  const next = prompt('Working directory for this user:', els.cwd.textContent);
  if (!next || next === els.cwd.textContent) return;
  const res = await post('/api/cwd', { cwd: next });
  if (res.ok) els.cwd.textContent = (await res.json()).cwd;
});

els.user.addEventListener('click', async () => {
  if (!confirm('Sign out? Your history is kept.')) return;
  await post('/api/logout');
  location.reload();
});

// --- boot ------------------------------------------------------------------

async function signIn(name) {
  // Errors here must land INSIDE the gate. `notice()` writes to the
  // transcript, which sits behind this overlay — a failed sign-in would
  // report itself somewhere the user cannot see.
  const problem = els.gate.querySelector('.problem') ?? (() => {
    const node = el('p', 'problem');
    els.loginForm.append(node);
    return node;
  })();
  problem.textContent = '';

  let res;
  try {
    res = await post('/api/login', { user: name });
  } catch (err) {
    problem.textContent = `could not reach the server: ${err.message}`;
    return;
  }
  if (!res.ok) {
    problem.textContent = (await res.json().catch(() => ({}))).error ?? 'sign-in failed';
    return;
  }
  location.reload();
}

els.loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  signIn(els.loginName.value);
});

async function boot() {
  const me = await (await fetch('/api/me')).json();

  if (!me.user) {
    els.gate.hidden = false;
    els.loginName.focus();
    for (const name of me.users ?? []) {
      const button = el('button', 'linky', name);
      button.type = 'button';
      button.addEventListener('click', () => signIn(name));
      els.knownUsers.append(button);
    }
    return;
  }

  els.user.textContent = me.user;
  const stream = new EventSource('/api/events');
  stream.onmessage = (e) => handle(JSON.parse(e.data));
  stream.onerror = () => { els.dot.className = 'dot'; };

  loadModels().catch((err) => notice(`model list: ${err.message}`, true));
  els.input.focus();
}

boot();
