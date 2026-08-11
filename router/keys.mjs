/**
 * keys.mjs — the secrets, and the only file in this system that holds one.
 *
 * OUTSIDE EVERY REPOSITORY, ON PURPOSE. `~/.agent-chat/` sits inside a git
 * repo at `/home/aeli` whose remote is the same GitHub repo this project
 * pushes to, tracking zero files with no `.gitignore`; `~/projects/agent-chat`
 * is a repo that certainly pushes. Either would publish a key on one
 * `git add -A`. Protecting a secret with an ignore rule protects it only for
 * as long as the rule stays correct, so the secrets live where no repository
 * reaches: `~/.config/agent-chat/keys.json`, mode 0600.
 *
 * AND NEVER SYNCED. `ops/lab.sh` says of the pod's own credentials:
 * "owner-written, never synced from here ... a lab that silently ran on the
 * wrong account would spend the quota this exists to protect." That decision
 * stands. The pod learns WHICH model to run from the settings file, and uses
 * ITS OWN key for that gateway — so no secret ever crosses machines.
 *
 * KEYED BY GATEWAY, NOT BY MODEL. THE OWNER, 2026-08-11: "I enter a key for
 * LLM A, it saves it, then I configure LLM B on the same gateway as A ... it
 * should ask me if I want to reuse key from A." Two models on one gateway
 * share one credential because they share one account — storing it twice
 * would be two sites naming one thing, and rotating it would then be a
 * two-step nobody remembers is two steps.
 *
 * WRITE-ONLY FROM THE PAGE'S SIDE. Nothing here returns a secret to a caller
 * that renders HTML. `describe()` is what the page gets: enough to recognise
 * a key, never enough to use one. The reuse popup sends a REFERENCE — "use
 * the same key as this gateway" — and the copy happens here, so a stored key
 * cannot leak through a response, a cached page, or devtools.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEYS_FILE = process.env.RM_LLM_KEYS
  || path.join(os.homedir(), '.config', 'agent-chat', 'keys.json');

/** Gateways are one account per host+path; the trailing slash is not identity. */
export function gatewayId(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(url).replace(/\/+$/, '') || null;
  }
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'))?.gateways ?? {};
  } catch {
    return {};
  }
}

function write(gateways) {
  fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true, mode: 0o700 });
  // MODE ON CREATE, NOT AFTER. Writing then chmod-ing leaves a window where
  // the file is world-readable, and a window is all a defect needs.
  const fd = fs.openSync(KEYS_FILE, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ gateways }, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(KEYS_FILE, 0o600); } catch { /* already ours */ }
}

/** The secret for a gateway, or null. The ONLY function that returns one. */
export function keyFor(url) {
  const id = gatewayId(url);
  return id ? (read()[id]?.key ?? null) : null;
}

export function saveKey(url, secret) {
  const id = gatewayId(url);
  if (!id) throw new Error('a key needs a gateway url to belong to');
  if (!secret) throw new Error('refusing to store an empty key');
  const gateways = read();
  gateways[id] = { key: String(secret), savedAt: new Date().toISOString() };
  write(gateways);
  return describeOne(id, gateways[id]);
}

/** Copy an existing gateway's key to another gateway, without it leaving here. */
export function reuseKey(fromUrl, toUrl) {
  const from = gatewayId(fromUrl);
  const to = gatewayId(toUrl);
  const gateways = read();
  if (!from || !gateways[from]) throw new Error(`no stored key for ${fromUrl}`);
  if (!to) throw new Error('a key needs a gateway url to belong to');
  gateways[to] = { ...gateways[from], savedAt: new Date().toISOString(), reusedFrom: from };
  write(gateways);
  return describeOne(to, gateways[to]);
}

export function forgetKey(url) {
  const id = gatewayId(url);
  const gateways = read();
  if (!id || !gateways[id]) return false;
  delete gateways[id];
  write(gateways);
  return true;
}

/**
 * A fingerprint, so two keys on one host are distinguishable.
 *
 * NOT THE LAST FOUR CHARACTERS. That is the common spelling and it hands over
 * four characters of the secret for free; a hash prefix identifies the key
 * without revealing any part of it.
 */
function fingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 8);
}

function describeOne(id, entry) {
  return {
    gateway: id,
    host: (() => { try { return new URL(id).host; } catch { return id; } })(),
    fingerprint: fingerprint(entry.key),
    savedAt: entry.savedAt ?? null,
    reusedFrom: entry.reusedFrom ?? null,
    masked: '••••••••',
  };
}

/** What the page may see: enough to recognise a key, never enough to use it. */
export function describe() {
  const gateways = read();
  return Object.entries(gateways).map(([id, entry]) => describeOne(id, entry));
}

/** Does this gateway have a key at all? The question the pod asks. */
export function hasKey(url) {
  return Boolean(keyFor(url));
}
