/**
 * markdown.js — the agent's replies, rendered as a document.
 *
 * Everything goes in via textContent and createElement — never innerHTML — so
 * nothing the agent or a tool result emits can inject markup into this page.
 * Links are the one thing carrying a URL, and only http(s) survives the check.
 */
import { el } from './dom.js';

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

export function renderMarkdown(target, text) {
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
 * labelled `Rainsmoke - …` at the point it is written, and that prefix — not
 * its subject, not its vocabulary — is what makes it green. A detector shipped
 * next year needs no entry here, because there are no entries here.
 *
 * AND ONLY A CALLOUT CAN CLAIM IT. THE OWNER, 2026-08-09: "so I see a green
 * tab, is that just talking about the previous rounds?" — asked of a reply
 * whose green section was headed "rainsmoke3 caught two of mine", sitting above
 * a tally that read no issues. The heading was the agent's own prose ABOUT
 * rainsmoke3, and it took rainsmoke3's colour purely from its wording, so the
 * page asserted a provenance nothing had checked. That is the session's most
 * expensive shape arriving through the stylesheet: a signal that means "this
 * came from the enforcement layer" awarded to any sentence that mentions it.
 *
 * A `§§` callout is WRITTEN as an attribution and cannot be typed by accident;
 * a heading is a sentence. So headings are always the agent's voice, whatever
 * they are about, and only declared callouts can be green.
 */
/* NO WORD BOUNDARY. `rainsmoke\b` does not match "Rainsmoke3" — the boundary
   needs a non-word character after "rainsmoke", and a digit is a word
   character. So the project's own name, spelled the way it is spelled
   everywhere else, resolved to the agent's colour. A prefix is what was meant
   and a prefix is what it now says. */
const RAINSMOKE = /^\s*rainsmoke/i;

/** The role a DECLARED callout label carries. Headings do not call this. */
export function roleOf(label) {
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
      const section = el('section', 'sec ask');   // a heading is the agent's own
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

/* `setBusy` lived here as a stray copy after the file split — it referenced
   `busy` and `els`, neither of which this module imports, so calling it would
   have thrown. dom.js owns it; a second definition is the parallel-architecture
   corpse in miniature. Removed 2026-08-09. */

