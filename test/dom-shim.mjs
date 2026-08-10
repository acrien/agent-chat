/**
 * A DOM small enough to hold the page's behaviour and nothing else.
 *
 * The page has no build step and no framework, so the cheapest honest test is
 * to run the real modules against a fake document and read the tree they
 * build. What this shim does NOT have is layout — no geometry, no styles — so
 * it verifies STRUCTURE and wiring, never appearance. Anything it cannot see
 * is stated here rather than discovered later: `getBoundingClientRect` returns
 * a fixed box, so the splitter's arithmetic is exercised but its feel is not.
 */
export const TEXT = 3;

export class El {
  constructor(tag) {
    this.tag = tag;
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.hidden = false;
    this.attrs = {};
    this.handlers = {};
    this.style = { setProperty: (k, v) => { this.attrs[k] = v; }, removeProperty() {} };
    this.classList = {
      add: (c) => { if (!this.className.split(' ').includes(c)) this.className = `${this.className} ${c}`.trim(); },
      remove: (c) => { this.className = this.className.split(' ').filter((x) => x && x !== c).join(' '); },
      contains: (c) => this.className.split(' ').includes(c),
    };
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parentNode?.children.splice(n.parentNode.children.indexOf(n), 1);
      n.parentNode = this;
      this.children.push(n);
    }
  }
  appendChild(n) { this.append(n); return n; }
  get lastChild() { return this.children[this.children.length - 1] ?? null; }
  get firstChild() { return this.children[0] ?? null; }
  remove() {
    const i = this.parentNode?.children.indexOf(this) ?? -1;
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  set textContent(v) {
    this.children = [];
    if (v !== '') this.children.push({ nodeType: TEXT, data: String(v), parentNode: this });
  }
  get textContent() {
    return this.children.map((c) => (c.nodeType === TEXT ? c.data : c.textContent)).join('');
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(kind, fn) { this.handlers[kind] = fn; }
  querySelector(sel) {
    const want = sel.replace(/^\./, '');
    const hunt = (n) => {
      for (const c of n.children) {
        if (c.nodeType === TEXT) continue;
        if (c.className?.split(' ').includes(want)) return c;
        const deeper = hunt(c);
        if (deeper) return deeper;
      }
      return null;
    };
    return hunt(this);
  }
  focus() {}
  setPointerCapture() {} hasPointerCapture() { return true; } releasePointerCapture() {}
  getBoundingClientRect() { return { right: 1600, left: 0, width: 1600 }; }
  get scrollHeight() { return 0; }
  get clientHeight() { return 0; }
}

export function install() {
  const byId = new Map();
  const document = {
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, new El(`#${id}`));
      return byId.get(id);
    },
    createElement: (tag) => new El(tag),
    createTextNode: (data) => ({ nodeType: TEXT, data }),
    addEventListener() {},
    querySelector: (sel) => document.getElementById(sel.replace(/^\./, '')),
    body: new El('body'),
  };
  globalThis.document = document;
  globalThis.window = globalThis;
  globalThis.innerWidth = 1600;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.prompt = () => null;
  globalThis.confirm = () => false;
  globalThis.location = { reload() {} };
  globalThis.EventSource = class { constructor() {} };
  // Never a real interval: one would keep node alive after the assertions.
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  return { document, byId };
}

/** The tree as text, so an assertion can be read as easily as written. */
export function dump(node, depth = 0) {
  const out = [];
  for (const c of node.children) {
    if (c.nodeType === TEXT) {
      out.push(`${'  '.repeat(depth)}· "${c.data.replace(/\n/g, '\\n')}"`);
      continue;
    }
    const label = `${c.tag}${c.className ? `.${c.className.split(' ').join('.')}` : ''}`;
    const only = c.children.length === 1 && c.children[0].nodeType === TEXT;
    if (only) {
      out.push(`${'  '.repeat(depth)}${label} "${c.children[0].data.replace(/\n/g, '\\n')}"`);
      continue;
    }
    out.push(`${'  '.repeat(depth)}${label}`);
    out.push(...dump(c, depth + 1));
  }
  return out;
}
