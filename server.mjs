#!/usr/bin/env node
/**
 * agent-chat — a local chat page wired to the Claude Agent SDK.
 *
 * EVERYTHING IS PER USER. A user is identified by a cookie, and owns their own
 * agent session, transcript, pasted images, model, effort, and working
 * directory. Nothing is shared between users except the process.
 *
 * TWO LAYERS OF HISTORY, and they are not the same thing:
 *   - the SDK's own session, resumed by id, which is what gives the *agent*
 *     its context back after a restart;
 *   - our transcript log, which is what lets the *page* redraw.
 * Persisting only the second would give you a conversation the model cannot
 * remember; persisting only the first would give you a blank page.
 *
 * The transcript is an append-only JSONL of finalized records — never token
 * deltas. Deltas are for live rendering only; the finalized `assistant`
 * message already carries complete text and complete tool inputs.
 *
 * Each user runs in *streaming input mode*: `query()` is handed a pushable
 * async iterable rather than a string, so the CLI subprocess stays up across
 * turns. That is also what makes the live controls possible — `setModel()` and
 * `applyFlagSettings({effortLevel})` exist only in streaming input mode.
 *
 * PERMISSIONS: `permissionMode: 'bypassPermissions'`, as asked. Every tool call
 * runs unprompted under this machine's account. Loopback only.
 *
 *   node server.mjs [--port 8787] [--cwd /path] [--data ~/.agent-chat]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { query } from '@anthropic-ai/claude-agent-sdk';

import * as store from './state.mjs';
// The model menu and every spawn path read ONE verdict — see router/turn_route.mjs
// for why two separate checks was the dropdown that selected nothing.
import { routeTurn, menu } from './router/turn_route.mjs';
import { providerSources } from './router/provider_registry.mjs';
import { allSettings, legalFor, saveSettings } from './router/llm_settings.mjs';
// `describe` is renamed at the boundary: in this file the bare word would read
// as "describe something", and the one thing it must never be confused with is
// a function that hands back a key.
import { describe as describeKeys, gatewayId, saveKey, reuseKey } from './router/keys.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(flag('port', '8787'));
const DEFAULT_CWD = path.resolve(flag('cwd', process.cwd()));
const DATA_DIR = path.resolve(flag('data', path.join(os.homedir(), '.agent-chat')));
const HOST = flag('host', '127.0.0.1');
/** 'disabled' | 'adaptive'. A gateway maps disabled -> enable_thinking=false. */
const THINKING = flag('thinking');

/**
 * Reaching this page means running tools unprompted on this machine, so the
 * moment it is bound anywhere but loopback it needs a secret to reach it.
 *
 * The token is generated rather than configured, and required rather than
 * offered: an opt-in flag would mean the dangerous configuration is the one
 * you get by forgetting. Off-loopback and unauthenticated is not a state
 * this server can be started in.
 */
const LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const TOKEN = LOOPBACK ? '' : (flag('token') || crypto.randomBytes(16).toString('hex'));
const KEY_COOKIE = 'agentchat_key';

/**
 * NOTHING LOADS A GATEWAY INTO THIS PROCESS. There used to be a
 * `loadProviderEnv` here that read provider.env into `process.env` at startup,
 * so that a restart could not forget the gateway. It could not forget it for
 * ANY turn — including the ones that had chosen a different provider.
 *
 * WHAT THAT COST, measured 2026-08-11 from this server's own log:
 *
 *     [session acrien-gmail.com] model=opus[1m] effort=(default) ...
 *       session error (acrien-gmail.com): rate_limit
 *
 * The dropdown worked and the query respawned; the request still went to the
 * Alibaba gateway, because the old routing returned null for a first-party
 * model — "no environment needed" — and the SDK's default child env is
 * `{...process.env}`. Opus was served out of qwen's quota.
 *
 * Its one assignment, `PROVIDER_VARS`, was never read by anything: mutating
 * the environment WAS the whole mechanism. Providers are now held as data and
 * read per turn — see `router/provider_registry.mjs`.
 */

/** rainsmoke3's single entry point; absent is fine, the page just stays quiet. */
const RM3_BIN = flag('rm3', path.join(os.homedir(), 'projects', 'rainsmoke3', 'ops', 'rm3'));

/**
 * Systems attached to this chat, each reporting on the turn in its own section.
 *
 * This is the hook-up point. Whatever runs alongside the agent — rainsmoke3
 * today, another agent or interface tomorrow — is an entry here: the name its
 * section is labelled with, and a probe that turns a session id into a summary
 * of itself. Nothing about a particular system reaches the transport or the
 * page; the mapping from its own vocabulary into the shared shape is the
 * reporter's own business, and stays inside its entry.
 *
 * A probe returns:
 *   headline  one line: what this system makes of the turn
 *   settled   false while the answer may still be incomplete, so retry
 *   counts    [{ label, n }] chips, in the order the system wants them read
 *   rows      [{ severity, label, detail }] the detail behind the headline
 * ...or throws, which means "not hooked up" and produces no section at all.
 */
const REPORTERS = [
  {
    name: 'rainsmoke3',
    // Asks `rm3 summary` rather than reading the record. The turn boundary, the
    // severity mapping and the tally already exist once, in rainsmoke3; a second
    // copy in JavaScript would be the parallel architecture that project exists
    // to refuse, and the first divergence between them would be silent.
    probe(session) {
      const payload = JSON.parse(
        execFileSync(RM3_BIN, ['summary', session], { encoding: 'utf8', timeout: 10000 }),
      );
      const total = payload.total ?? 0;
      return {
        settled: total > 0,
        headline: total ? `${total} ${total === 1 ? 'issue' : 'issues'}` : 'no issues',
        // THE CATEGORIES ARE RAINSMOKE3'S TO NAME. This was a literal list,
        // which meant `firelane` arrived and the chip for it silently did not
        // — a severity that exists everywhere except where it is read. The
        // tally arrives already ordered worst-first, so insertion order is
        // the ordering, and adding a category is a change in one project.
        counts: Object.entries(payload.counts ?? {}).map(([label, n]) => ({
          label, n: n ?? 0,
        })),
        rows: (payload.findings ?? []).map((f) => ({
          severity: f.severity,
          label: f.detector,
          detail: f.summary || f.entry || '',
        })),
      };
    },
  },
];

/**
 * The heartbeat runs OUTSIDE the turn cycle, so the page cannot learn about it
 * the way it learns everything else. Nothing about a poller between turns
 * appears in the SDK's message stream; the record it writes is the only place
 * it exists, so that is what gets watched.
 *
 * Watched, not polled: a beat is written and the page hears about it, rather
 * than the page asking every few seconds whether anything happened. The slow
 * sweep underneath is not a second opinion — it is there because the one thing
 * a file watcher cannot see is a file that STOPPED being written, and that
 * silence is exactly what "the heartbeat died" consists of.
 *
 * Which file a project's beats live in is rainsmoke3's business. This watches
 * the directory and asks `rm3 heartbeat` what it means, rather than recomputing
 * the name: that would be a second copy of a naming rule, and since blake2b-8
 * is not a truncation of blake2b-512 the copy could not even be wrong loudly.
 */
const BEAT_DIR = path.join(os.homedir(), '.rainsmoke3', 'heartbeat');
const BEAT_SETTLE_MS = 150;      // coalesce a write and its rename into one probe
const BEAT_SWEEP_MS = 20_000;    // cheap enough to ignore, often enough to notice silence

/**
 * Models reachable through a gateway, which the SDK cannot enumerate.
 *
 * THE OWNER, 2026-08-10: "the model should include qwen3.8-max and efforts for
 * that (effort should be per model), so each model should get different effort
 * texts, because not everything is called xhigh or ultra or max."
 *
 * EFFORT WAS ALREADY PER MODEL — `fillEffort` reads each entry's own
 * `supportedEffortLevels` — but `supportedModels()` only knows first-party
 * models, so a gateway model could not appear at all, let alone with its own
 * levels. These come from the same llm_config RM2 authenticates with, so there
 * is one place a provider is described and not two.
 *
 * NO EFFORT LEVELS UNLESS THE CONFIG NAMES THEM. Inventing `xhigh` for a model
 * that has never heard of it would send a parameter the gateway rejects, and
 * the failure would arrive as a dead turn rather than as a bad menu.
 */
// The menu and the verdict behind it live in router/ — imported above, where
// the imports belong.

/** execFile as a promise: the sweep must never block the event loop. */
function run(bin, args, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf8', timeout }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// --- limits ----------------------------------------------------------------

/** The only source types the Messages API accepts for base64 images. */
const IMAGE_MEDIA_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);
const MAX_IMAGES_PER_TURN = 10;
const MAX_IMAGE_CHARS = 5_000_000;    // base64 length, ~3.7 MB decoded
const MAX_BODY_BYTES = 60_000_000;
const HISTORY_REPLAY_LIMIT = 400;   // records sent to a newly attached page

/**
 * What the session about to end is asked to write down.
 *
 * IT ASKS FOR STATE, NOT A SUMMARY. "Summarise this conversation" produces
 * prose about what was discussed; what the next session needs is what is
 * UNFINISHED, what was decided and why, and what is running right now — the
 * things that are expensive to rediscover and invisible in a transcript.
 */
const HANDOFF_PROMPT = [
  'HANDOFF. This session is about to be cleared. Write the note your successor',
  'needs — it will start with nothing but this.',
  '',
  'Cover, in this order, and briefly:',
  '  1. WHAT IS IN FLIGHT RIGHT NOW — anything running, waiting, or half-done,',
  '     and where its state lives on disk.',
  '  2. WHAT THE OWNER ASKED FOR THAT IS NOT DONE, in their words where you can.',
  '  3. DECISIONS AND THEIR REASONS — especially ones that look arbitrary from',
  '     outside, because those are the ones a successor undoes by accident.',
  '  4. WHAT IS KNOWN TO BE BROKEN OR UNVERIFIED, said plainly.',
  '  5. THE NEXT CONCRETE STEP.',
  '',
  'Write it for someone competent who was not here. No preamble, no apology,',
  'no recap of what a transcript would already show. Facts, paths, and open',
  'questions.',
].join('\n');

/**
 * What the successor is told before it reads the note.
 *
 * IT SAYS WHICH BOUNDARY IT CROSSED. After a `/clear` only the context is gone;
 * after a RESTART the process is new too, so pids have changed, anything the
 * previous session started in the foreground is dead, and the transcript above
 * has a gap in it. A successor that assumed the first while living in the
 * second would report a restart it cannot see as a mystery — this environment's
 * standing trap (ENV.md), stated rather than left to be rediscovered.
 */
function handoffHeader(restarted) {
  return 'You are continuing work after a context clear'
    + (restarted ? ' and a restart of the server hosting this session' : '')
    + '. The note below was written by the session that just ended, about its '
    + 'own unfinished work. Treat it as the state of the world, verify anything '
    + 'it claims is running, and continue.';
}

// --- pushable stream -------------------------------------------------------

/**
 * An async iterable you can push into after the consumer has started.
 *
 * `query()` takes the iterable once and iterates it for the life of the
 * session; it must never finish, or the session closes. Nothing in the
 * standard library gives a pushable async iterator, hence this.
 */
function createPushable() {
  const queued = [];
  let waiting = null;
  let closed = false;

  return {
    push(value) {
      if (closed) return;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value, done: false });
      } else {
        queued.push(value);
      }
    },
    close() {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queued.length) return Promise.resolve({ value: queued.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { waiting = resolve; });
        },
        return() {
          closed = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

// --- per-user storage ------------------------------------------------------

/**
 * Usernames become directory names, so they are constrained rather than
 * escaped: anything outside this set cannot be expressed as a path at all.
 */
function slugify(name) {
  const slug = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40);
  return /^[a-z0-9]/.test(slug) ? slug : '';
}

function userDir(userId) {
  return path.join(DATA_DIR, 'users', userId);
}

function ensureUserDirs(userId) {
  const dir = userDir(userId);
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  return dir;
}

// The state file itself lives in state.mjs — one definition, testable without
// booting a server, and the take-once rule for a parked handoff lives beside
// the write it has to be atomic with.
function readState(userId) {
  return store.read(userDir(userId));
}

function writeState(userId, patch) {
  return store.write(ensureUserDirs(userId), patch);
}

function transcriptPath(userId) {
  return path.join(userDir(userId), 'transcript.jsonl');
}

/**
 * The transcript is the SSOT for what the page redraws, so it is written
 * synchronously. The async version returned before the bytes were anywhere,
 * and a process that dies mid-turn — a restart, a crash — loses whatever was
 * still buffered. That is precisely the turn a reader most needs to see.
 *
 * Affordable because records are per message, not per delta: a dozen small
 * appends in a turn, not thousands.
 */
function appendRecord(userId, record) {
  const line = `${JSON.stringify({ ...record, at: Date.now() })}\n`;
  try {
    fs.appendFileSync(transcriptPath(userId), line);
  } catch { /* a transcript that cannot be written must not stop the turn */ }
}

function readHistory(userId) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath(userId), 'utf8');
  } catch {
    return [];
  }
  const items = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { items.push(JSON.parse(line)); } catch { /* skip a torn final line */ }
  }
  return items.slice(-HISTORY_REPLAY_LIMIT);
}

function saveImage(userId, mediaType, base64) {
  const ext = IMAGE_MEDIA_TYPES.get(mediaType);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(ensureUserDirs(userId), 'images', id), Buffer.from(base64, 'base64'));
  return id;
}

/**
 * Validate the images attached to one turn.
 * Throws a user-facing message rather than sending a malformed request.
 */
function acceptImages(images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  if (images.length > MAX_IMAGES_PER_TURN) {
    throw new Error(`too many images (${images.length}); max ${MAX_IMAGES_PER_TURN} per message`);
  }
  return images.map((img, i) => {
    const mediaType = String(img?.mediaType ?? '');
    const data = String(img?.data ?? '');
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
      throw new Error(`image ${i + 1}: unsupported type ${mediaType || '(none)'} — use PNG, JPEG, GIF or WebP`);
    }
    if (!data) throw new Error(`image ${i + 1}: empty`);
    if (data.length > MAX_IMAGE_CHARS) {
      throw new Error(`image ${i + 1} is too large (${(data.length / 1e6).toFixed(1)} MB encoded); max ~3.7 MB`);
    }
    return { mediaType, data };
  });
}

// --- user session ----------------------------------------------------------

const sessions = new Map();   // userId -> UserSession

class UserSession {
  constructor(userId) {
    const state = readState(userId);
    this.userId = userId;
    this.clients = new Set();
    this.busy = false;
    this.model = state.model ?? null;
    this.effort = state.effort ?? null;
    this.cwd = state.cwd ?? DEFAULT_CWD;
    this.sdkSessionId = state.sessionId ?? null;
    //: The level actually in force, learned from hook input. Distinct from
    //: `effort`, which is what the user picked — null there means "default",
    //: and the whole point is to say what default resolves to.
    this.activeEffort = state.activeEffort ?? null;
    this.thinking = state.thinking ?? THINKING ?? null;
    //: Prompt caching, as a switch rather than a provider's habit. The SDK has
    //: no per-request cache control — the CLI places its own cache_control
    //: breakpoints — so the only lever is DISABLE_PROMPT_CACHING, which makes
    //: caching exactly the kind of ambient variable the router owns. null
    //: leaves the provider's own default; true/false is a decision.
    this.cache = state.cache ?? null;
    //: The verdict the live query was spawned with — what the page reports and
    //: what `/api/models` answers with, so the selector shows what is in force
    //: rather than what was asked for.
    this.route = null;
    this.streaming = { main: new Set(), sub: new Set() };
    this.q = null;
    this.input = null;
    this.beatWatch = null;
    this.beatSweep = null;
    this.lastBeat = null;
    //: This session owes a handoff to a restart that is waiting for it. The
    //: restart fires when nothing owes one — see `maybeRestart`.
    this.restartPending = false;
    //: A model switch that changes the provider, chosen while a turn was
    //: running. Applied by `send()` before the next turn, never mid-turn —
    //: swapping the query underneath a running turn would kill the turn.
    this.pendingModelSwap = false;
    this.start();
    this.watchHeartbeat();
  }

  /**
   * Follow the heartbeat for whatever directory this session is pointed at.
   *
   * Restarted rather than reconfigured when the cwd changes: a watcher aimed
   * at the previous project would keep reporting a heartbeat the user is no
   * longer looking at, which is worse than reporting none.
   */
  watchHeartbeat() {
    this.stopHeartbeat();
    let settle = null;
    const soon = () => {
      clearTimeout(settle);
      settle = setTimeout(() => this.pushHeartbeat(), BEAT_SETTLE_MS);
    };
    try {
      this.beatWatch = fs.watch(BEAT_DIR, soon);
      // Absent, unreadable, or on a filesystem without watches: the sweep
      // below still reports, just at its own pace. Never the chat's problem.
      this.beatWatch.on('error', () => { this.beatWatch?.close(); this.beatWatch = null; });
    } catch { this.beatWatch = null; }
    this.beatSweep = setInterval(() => {
      this.pushHeartbeat();
      this.claimJob();
    }, BEAT_SWEEP_MS);
    this.pushHeartbeat();
  }

  /**
   * Take whatever a rainsmoke3 job has left for the agent, and run it.
   *
   * THE POLLER CANNOT CALL THIS DIRECTLY. It is a systemd service with no idea
   * whether a chat server exists, let alone which port; and a job that posted
   * into a dead port would lose the batch silently. So the job writes its
   * request down and this claims it — the offer waits as long as it has to.
   *
   * NEVER MID-TURN. Pushing into `input` while the agent is answering
   * interleaves a job's question with the owner's, and the reply that comes
   * back belongs to neither. A skipped sweep costs one interval; the offer is
   * still there.
   *
   * CLAIMING DOES NOT ADVANCE THE CURSOR — it marks the batch in flight, and
   * the reader's own `rm3 review done:NNN` call is what moves the index (or
   * puts the batch back, on 190). A claim that advanced would mark the turns
   * read at the instant they were handed over, so a crash mid-read would
   * leave an index saying they were reviewed.
   */
  async claimJob() {
    // NO CONNECTED-CLIENT REQUIREMENT. It used to also demand `this.clients.size`
    // — "is anyone watching?" answered with "is a browser attached to THIS
    // server?" That was the same question while this was the only surface. It
    // stopped being the same question when the review moved to the lab pod,
    // where nobody is attached BY DESIGN — the pod's work is read from the
    // pod's own page, afterwards. Keeping it would mean the pod could never
    // claim anything, silently, which reads exactly like a review that found
    // nothing to do.
    //
    // AND NOT `sdkSessionId` EITHER, which was the same mistake one layer
    // down. That id appears only after a turn has run — and delivering a job
    // turn is what would start one. A pod that has never been spoken to could
    // therefore never be spoken to, and the symptom is silence rather than an
    // error. What is actually required is somewhere to push, which `start()`
    // created before any of this: the id is for RESUMING a session, not for
    // having one.
    if (this.busy || !this.input) return;
    let offer;
    try {
      offer = JSON.parse(await run(RM3_BIN, ['review', 'claim']));
    } catch {
      return;   // rainsmoke3 absent or unhappy: nothing to deliver
    }
    if (!offer?.prompt) return;

    // EVERY STEP BETWEEN THE CLAIM AND THE PUSH IS A STEP THAT CAN LOSE A
    // BATCH, and one did: the claim consumed the offer, the delivery did not
    // happen, and the turns were gone while the stream still reported the
    // round had started. So a delivery that throws puts the batch back.
    try {
      this.busy = true;

      // A JOB TURN STARTS FROM NOTHING, EVERY TIME.
      //
      // THE OWNER, 2026-08-10: "when you run anything on pod, make sure to
      // clear it so it starts new; otherwise it'll be polluted with other
      // contexts."
      //
      // Measured the same day: a handoff-test session in the pod inherited the
      // previous rounds AND the synced copy of production's record, and spent
      // its turn diagnosing a conversation that was not its own. A review is
      // handed everything it needs in its prompt — the batch, the brief, the
      // environment — so anything else in its context is another round's
      // reasoning leaking into this one's conclusions.
      //
      // This is `/clear` without the handoff, which is the right shape: there
      // is nothing to carry forward between independent readings.
      try { this.q?.close?.(); } catch { /* already gone */ }
      this.input?.close();
      this.sdkSessionId = null;
      writeState(this.userId, { sessionId: null });
      this.start({ fresh: true });

      const at = Date.now();
      const event = { t: 'job', name: offer.job, label: offer.label,
                      headline: `${offer.headline} · fresh session`, at };
      this.emit(event, { k: 'job', ...event, t: undefined });
      this.input.push({
        type: 'user',
        message: { role: 'user', content: offer.prompt },
        parent_tool_use_id: null,
      });
      // WHAT THE COMPLETION REPORT WILL BE ABOUT. The poller used to infer a
      // finished round from "an agent reply appeared after the claim" — and
      // this session produces replies of its own, so an unrelated one ended
      // the round and advanced the index past turns nobody read.
      this.jobInFlight = offer.job;
      this.jobText = '';
    } catch (err) {
      this.busy = false;
      this.jobInFlight = null;
      this.emitError(`could not deliver the ${offer.job} batch: ${err?.message ?? err}`);
      try { await run(RM3_BIN, ['review', 'unclaim']); } catch { /* it stays in flight */ }
    }
  }

  /**
   * Tell rainsmoke3 the job turn is over — the only party that knows.
   *
   * Called on `result`, which is the SDK saying this turn ended. Inference was
   * what went wrong: the poller looked for any agent reply after the claim, and
   * got one that had nothing to do with the review.
   */
  async finishJob(ok) {
    if (!this.jobInFlight) return;
    this.jobInFlight = null;

    // A FAILED TURN READ NOTHING. Measured 2026-08-10: a 30-turn round died on
    // `authentication_failed` partway through and the index advanced past all
    // thirty anyway, because `result` fires for a failed run exactly as it does
    // for a finished one. Those turns were then marked reviewed and would never
    // be offered again — the same hole as claiming-before-delivery, arriving
    // through the other end.
    //
    // This is the rule already written into `exercised.py` and not carried
    // here: a red run is evidence the thing BROKE, not evidence it was done.
    // THE READER CALLS, IT DOES NOT WRITE. `ok` is the SDK saying the process
    // ended without erroring — which a turn that read nothing also says. And
    // the earlier version, scanning the reply for a bracketed code, was a
    // formatting rule the reader had to remember across sixty thousand
    // characters; it was ignored four times, which is what a reminder does.
    //
    // `rm3 review done:101` is an ACTION. It happened or it did not, it is
    // recorded by the thing that ran it, and there is no way to write prose
    // that resembles a declaration without being one.
    //
    // 101 read the batch · 102 read part of it · 190 could not · no call = 190,
    // because a turn that died before calling looks exactly like one that
    // never meant to, and both establish nothing.
    //
    // THE DECLARATION ALREADY TOOK EFFECT the moment the reader called it —
    // rainsmoke3's declare() completed (or put back) the batch then. What
    // runs here is the fallback for a turn that ended without calling
    // anything, and an idempotent no-op when it did: `complete` with no batch
    // in flight moves nothing, `unclaim` with nothing to put back returns
    // nothing.
    let code = 0;
    try {
      code = Number(JSON.parse(await run(RM3_BIN, ['review', 'declared'])).code ?? 0);
    } catch { code = 0; }
    this.jobText = '';
    const read = ok && (code === 101 || code === 102);
    const action = read ? 'complete' : 'unclaim';
    try {
      await run(RM3_BIN, ['review', action]);
      if (!read) {
        this.emitError(
          `the review batch goes back unread — result ${ok ? 'ok' : 'failed'}, `
          + `declared code ${code || 'none'}`,
        );
      }
    } catch (err) {
      // The batch stays in flight and the poller's deadline hands it back.
      this.emitError(`could not ${action} the review batch: ${err?.message ?? err}`);
    }
  }

  stopHeartbeat() {
    try { this.beatWatch?.close(); } catch { /* already gone */ }
    clearInterval(this.beatSweep);
    this.beatWatch = null;
    this.beatSweep = null;
    this.lastBeat = null;
  }

  /**
   * Send the heartbeat's state, but only when it is a different state.
   *
   * Identity is the beat's own timestamp plus whether it is still beating —
   * NOT the whole payload, which carries an age that changes on every read and
   * would make every sweep look like news. Age is the page's job: it has the
   * timestamp and a clock, and can count without being told.
   */
  async pushHeartbeat(force = false) {
    if (!this.clients.size) return;
    let payload;
    try {
      payload = JSON.parse(await run(RM3_BIN, ['heartbeat', this.cwd]));
    } catch {
      return;   // rainsmoke3 absent or unhappy: the panel just stays quiet
    }
    const identity = JSON.stringify([payload.attached, payload.beating, payload.beat?.at]);
    if (!force && identity === this.lastBeat) return;
    this.lastBeat = identity;
    this.broadcast({ t: 'heartbeat', ...payload });
  }

  /** Tear down the CLI and start a new one.

   * `thinking`, `model` at startup and `cwd` are query() options, fixed for a
   * session's lifetime — changing one means a new query(), not a control
   * request. The SDK session id is kept, so the conversation survives.
   */
  restart() {
    try { this.q?.close?.(); } catch { /* already gone */ }
    this.input?.close();
    this.busy = false;
    this.start();
  }

  start({ fresh = false } = {}) {
    const input = createPushable();
    const options = {
      cwd: this.cwd,
      // Asked for explicitly. `bypassPermissions` is rejected without this flag.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Without the preset the agent has no Claude Code system prompt and does
      // not behave like the CLI — the whole point of the page.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
    };
    if (this.model) options.model = this.model;

    // THE ROUTE. One call decides the provider, the complete child environment,
    // and every provider-facing option — effort, thinking, prompt caching, the
    // context window, and the turn ceiling. Nothing here branches on a provider
    // name, because the moment this file knows one, it is a second site that
    // can disagree with the first.
    const route = routeTurn({
      model: this.model,
      effort: this.effort,
      thinking: this.thinking,
      cache: this.cache,
    });
    // ALWAYS SET, NEVER INHERITED. The SDK's default is `{...process.env}`; a
    // route that declined to say what a turn's environment is would be handing
    // that decision to whatever last exported a variable. See the block above.
    options.env = route.env;
    Object.assign(options, route.options);
    this.route = route;

    // A DROPPED OPTION IS ANNOUNCED. The old code suppressed an effort the
    // gateway would reject — correctly — and said nothing, so the selector went
    // on showing a level that was not in force. Three silences (unsupported,
    // unverified, out of range) are now one visible line.
    for (const d of route.dropped) {
      this.broadcast({ t: 'notice', text: `${d.what} ${JSON.stringify(d.asked)} not sent — ${d.why}` });
    }

    // WHAT IS IN FORCE BECOMES WHAT THE PAGE SHOWS. The route may cap the
    // effort — thinking off on Claude Opus 5 tops out at `high` — and until
    // this line the session kept the level the owner had asked for, so the
    // selector read `xhigh` while every turn ran at `high`. That gap IS the
    // complaint this store was built for ("no way I know the setting of the
    // server if it differs"), reappearing one layer in. The verdict wins, and
    // it is written down where the page reads it.
    if (route.options.effort && route.options.effort !== this.effort) {
      this.effort = route.options.effort;
      writeState(this.userId, { effort: this.effort });
    }

    // The only honest source for the EFFECTIVE effort. `supportedModels()`
    // lists which levels a model allows but not which one is in force, and
    // the init response carries no effort at all — so an unset selector
    // could otherwise only display a guess. Hook input carries the active
    // level for the turn, after any silent downgrade for the model.
    options.hooks = {
      Stop: [{
        hooks: [async (input) => {
          const level = input?.effort?.level;
          if (level && level !== this.activeEffort) {
            this.activeEffort = level;
            writeState(this.userId, { activeEffort: level });
            this.broadcast({ t: 'effort_in_force', effort: level });
          }
          return {};
        }],
      }],
    };
    // Resuming is what restores the *agent's* memory. The transcript only
    // restores the page.
    if (!fresh && this.sdkSessionId) options.resume = this.sdkSessionId;

    // THE PROVIDER IS IN THE LINE NOW. The log that recorded this defect said
    // `model=opus[1m]` and was telling the truth — the model HAD switched. It
    // could not say the request was still going to the gateway, because
    // nothing in this process knew where a turn was going.
    console.log(`[session ${this.userId}] model=${options.model ?? '(default)'} via=${route.provider}`
      + ` effort=${options.effort ?? '(default)'} thinking=${JSON.stringify(options.thinking ?? null)}`
      + (options.maxTurns ? ` maxTurns=${options.maxTurns}` : '')
      + (route.dropped.length ? ` dropped=${route.dropped.map((d) => d.what).join(',')}` : ''));
    const q = query({ prompt: input, options });
    this.q = q;
    this.input = input;
    this.consume(q, { resumed: Boolean(options.resume) });
  }

  async consume(q, { resumed }) {
    try {
      for await (const message of q) this.relay(message);
    } catch (err) {
      this.busy = false;
      // A stored session id can go stale (pruned, or written by another
      // machine). Resuming it then fails at startup — fall back to a fresh
      // session once rather than leaving the user with a dead page.
      if (resumed && q === this.q) {
        this.sdkSessionId = null;
        writeState(this.userId, { sessionId: null });
        this.broadcast({ t: 'notice', text: 'previous session could not be resumed — started a new one' });
        this.start({ fresh: true });
        return;
      }
      // RECORDED, NOT ONLY BROADCAST. THE OWNER, 2026-08-10, reading an error
      // off the pod's page that the agent could not see: "why can't you see
      // it? do you need my credentials? my permission?"
      //
      // Neither. `broadcast` writes to connected sockets and nowhere else, so
      // an error with no browser attached was never written down — and the
      // pod is a machine nobody attaches a browser to BY DESIGN. The failure
      // that mattered most was the one guaranteed to be invisible: a session
      // set busy with no process behind it, reported to an empty room.
      //
      // `emit` puts it in the transcript, which is on disk, which anything can
      // read afterwards — a person, a mirror, or the review itself.
      this.emitError(err?.message ?? String(err));
    }
  }

  broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try { res.write(payload); } catch { /* client vanished; close handler prunes */ }
    }
  }

  /** Broadcast live, and append to the durable transcript. */
  /** An error the reader can still find tomorrow. See its one call site. */
  emitError(text) {
    const event = { t: 'error', text: String(text), at: Date.now() };
    this.emit(event, { k: 'error', ...event, t: undefined });
    // Also to the process log: a server whose transcript cannot be written is
    // exactly when an error most needs somewhere to go.
    console.error(`  session error (${this.userId}): ${String(text).slice(0, 300)}`);
  }

  emit(event, record) {
    this.broadcast(event);
    if (record) appendRecord(this.userId, record);
  }

  /**
   * Translate one SDK message into UI events.
   *
   * Division of labour, chosen so nothing renders twice: text and thinking
   * stream live from `stream_event` deltas, while tool calls and results come
   * from the finalized `assistant`/`user` messages, where a tool's input is
   * complete rather than partial JSON. The transcript is written from the
   * finalized messages only.
   */
  relay(message) {
    const lane = message.parent_tool_use_id ? 'sub' : 'main';

    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          this.sdkSessionId = message.session_id;
          writeState(this.userId, { sessionId: message.session_id });
          this.broadcast({
            t: 'session',
            sessionId: message.session_id,
            model: message.model ?? null,
            cwd: message.cwd ?? this.cwd,
            tools: Array.isArray(message.tools) ? message.tools.length : null,
          });
        } else if (message.subtype === 'api_retry') {
          this.broadcast({ t: 'notice', text: `API retry ${message.attempt}/${message.max_retries}` });
        }
        break;
      }

      case 'stream_event': {
        const ev = message.event;
        if (!ev) break;
        if (ev.type === 'message_start') {
          this.streaming[lane].clear();
          // The model on message_start is the one that actually served this
          // turn — authoritative in a way the selector is not, since the
          // selector can say "default" or have been changed mid-turn.
          const meta = {
            lane,
            model: ev.message?.model ?? this.model ?? null,
            effort: this.activeEffort ?? this.effort ?? null,
            at: Date.now(),
          };
          this.emit({ t: 'turn_start', ...meta }, { k: 'turn', ...meta });
        } else if (ev.type === 'content_block_start') {
          const kind = ev.content_block?.type;
          if (kind === 'text' || kind === 'thinking') {
            this.streaming[lane].add(ev.index);
            this.broadcast({ t: 'block_start', lane, index: ev.index, kind });
          }
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta ?? {};
          if (d.type === 'text_delta') {
            this.broadcast({ t: 'delta', lane, index: ev.index, kind: 'text', text: d.text });
            // THE CODE IS IN THE REPLY, so the reply has to be kept. Only while
            // a job turn is in flight — the owner's turns are already on disk
            // and this would be a second copy of them in memory.
            if (this.jobInFlight) this.jobText = (this.jobText ?? '') + d.text;
            if (this.handoffPending) this.handoffText = (this.handoffText ?? '') + d.text;
          } else if (d.type === 'thinking_delta') {
            this.broadcast({ t: 'delta', lane, index: ev.index, kind: 'thinking', text: d.thinking });
          }
        } else if (ev.type === 'content_block_stop' && this.streaming[lane].delete(ev.index)) {
          this.broadcast({ t: 'block_stop', lane, index: ev.index });
        }
        break;
      }

      case 'assistant': {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'tool_use') {
            this.emit(
              { t: 'tool_use', lane, id: block.id, name: block.name, input: block.input },
              { k: 'tool', lane, id: block.id, name: block.name, input: block.input },
            );
          } else if (block.type === 'text' && block.text) {
            // Persist only — it already streamed to the page as deltas.
            appendRecord(this.userId, { k: 'text', lane, text: block.text });
          } else if (block.type === 'thinking' && block.thinking) {
            appendRecord(this.userId, { k: 'thinking', lane, text: block.thinking });
          }
        }
        if (message.error) {
          this.emitError(message.error.message ?? String(message.error));
        }
        break;
      }

      case 'user': {
        const content = message.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const text = renderToolResult(block.content);
          this.emit(
            { t: 'tool_result', lane, id: block.tool_use_id, isError: Boolean(block.is_error), text },
            { k: 'tool_result', id: block.tool_use_id, isError: Boolean(block.is_error), text },
          );
        }
        break;
      }

      case 'result': {
        this.busy = false;
        const event = {
          t: 'result',
          subtype: message.subtype,
          isError: Boolean(message.is_error),
          text: message.subtype === 'success' ? message.result : (message.errors ?? []).join('\n'),
          // TOKENS, NOT DOLLARS. `total_cost_usd` is derived — token counts
          // multiplied by a price list that changes without the run changing.
          // The tokens are what the turn actually spent; the money is one
          // opinion about them, and showing the opinion while hiding the
          // measurement means a turn costs a different number tomorrow.
          usage: message.usage ?? null,
          costUsd: message.total_cost_usd,
          durationMs: message.duration_ms,
          turns: message.num_turns,
        };
        this.emit(event, { k: 'result', ...event, t: undefined });
        this.reportSections();   // async on purpose: never delay the result
        this.finishJob(message.subtype === 'success');
        if (this.handoffPending) {
          // THE CLEAR HAPPENS HERE, when the handoff exists — not when a
          // countdown reaches zero. A timer would cut it off mid-sentence and
          // the successor would inherit half a note.
          const note = this.handoffText ?? '';
          this.handoffText = '';
          const restarting = Boolean(this.clearing?.restart);
          if (note.trim()) this.finishClear(note);
          else {
            // AN EMPTY NOTE STOPS THE RESTART TOO, and that is the stronger
            // half: clearing on an empty note loses the context, restarting on
            // one loses it and takes the process down after it. That is the
            // exact state this whole path was built to stop happening.
            this.handoffPending = false;
            this.clearing = null;
            if (restarting) this.restartAbort('the handoff came back empty — not restarting');
            else this.emitError('the handoff came back empty — not clearing');
          }
        }
        break;
      }
    }
  }

  /**
   * Ask every attached system what it made of this turn, and give each one its
   * own section.
   *
   * A system hooked up alongside the agent — an enforcement layer, a linter,
   * another agent — is not the agent, and folding its output into the reply
   * would say that it was. Each reports under its own name, in its own section,
   * on every turn.
   *
   * Reported by asking rather than listening: hook output never reaches the
   * Agent SDK's message stream. Probed 2026-08-09, a full turn emits only
   * system/init, assistant, result and rate_limit_event, so a host cannot see a
   * gate's findings by listening to the stream it already has.
   *
   * Retried because a reporter's writes race the `result` message: an unsettled
   * answer may only mean "not written yet". Bounded, and whatever the last
   * attempt said is shown either way.
   */
  async reportSections() {
    const session = this.sdkSessionId;
    if (!session) return;

    for (const reporter of REPORTERS) {
      let summary = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        try {
          summary = reporter.probe(session);
        } catch {
          summary = null;   // absent or unhappy: never the chat's problem
          break;
        }
        if (!summary || summary.settled) break;
      }
      if (!summary) continue;
      const { settled, ...body } = summary;
      const event = { t: 'section', source: reporter.name, at: Date.now(), ...body };
      this.emit(event, { k: 'section', ...event, t: undefined });
    }
  }

  send(text, images) {
    // A provider switch chosen mid-turn lands here. Only BETWEEN turns — the
    // `busy` guard is what keeps a running turn alive and keeps nothing pushed
    // into an input that is about to be closed. If this send is itself mid-
    // turn, the swap simply waits for the next one.
    if (this.pendingModelSwap && !this.busy) {
      this.swapQuery(`model → ${this.model || 'default'}`);
    }

    const stored = images.map((img) => ({
      id: saveImage(this.userId, img.mediaType, img.data),
      mediaType: img.mediaType,
    }));

    // Images lead the message and are labelled, so "image 2" means the same
    // thing to the model as it does in the composer's numbered tray.
    let content;
    if (stored.length) {
      content = [];
      images.forEach((img, i) => {
        content.push({ type: 'text', text: `Image ${i + 1}:` });
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        });
      });
      if (text) content.push({ type: 'text', text });
    } else {
      content = text;
    }

    this.busy = true;
    const at = Date.now();
    this.emit(
      { t: 'user', text, images: stored, at },
      { k: 'user', text, images: stored, at },
    );
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
  }

  /**
   * Hand off, then start again — the thread kept, the context dropped.
   *
   * THE OWNER, 2026-08-10: "Build a /clear option, make it so when I turn it
   * on, it'll start a clear countdown of 10 seconds, as it starts counting
   * down, you it needs to kick off a call to do the handoff, so after /clear,
   * the session after knows exactly what works are needed, what discussions
   * were going on and where we left off [...] research shows that LLMs lost
   * reasoning at the middle, so around the 500k token range."
   *
   * THE ORDER IS THE WHOLE DESIGN. A clear that fires on a timer would cut the
   * handoff off mid-sentence, and a handoff that arrives after the clear
   * arrives in a session that has already forgotten what it was about. So the
   * ten seconds are ONLY the window to cancel; the handoff runs next, at
   * whatever length it needs; and the clear happens when the handoff LANDS.
   * A countdown that promised to clear at zero would be lying about the one
   * thing it is counting down to.
   *
   * THE HANDOFF IS WRITTEN BY THE SESSION BEING ENDED, which is the only party
   * that has the context. Nothing else could reconstruct it, and by the time
   * anything else could ask, it is gone.
   */
  async startClear(seconds = 10, { restart = false } = {}) {
    if (this.clearing) return { already: true };
    this.clearing = { at: Date.now(), seconds, phase: 'countdown', restart };
    if (restart) this.restartPending = true;
    this.broadcast({ t: 'clearing', phase: 'countdown', seconds, restart, at: Date.now() });

    await new Promise((r) => { this.clearTimer = setTimeout(r, seconds * 1000); });
    if (!this.clearing) return { cancelled: true };      // cancelled mid-count

    // WAIT FOR THE CURRENT TURN, AND SAY THAT IS WHAT IS HAPPENING.
    //
    // Two reasons, and the second is a bug I would have walked into. Pushing
    // the handoff mid-turn queues it — fine — but `handoffPending` would then
    // be true when the RUNNING turn's `result` arrived, and the clear would
    // fire on that, taking the current reply as the handoff. The note would be
    // whatever was being said at the time, and the real handoff would run into
    // a session that had already been cleared.
    //
    // The first reason is the plain one: interrupting a turn to write a
    // handoff about it loses the thing the handoff is for. Waiting is right —
    // and the stream used to say "writing the handoff" while it was actually
    // waiting, which is a phase message lying about the phase.
    if (this.busy) {
      this.clearing.phase = 'waiting';
      this.broadcast({ t: 'clearing', phase: 'waiting', at: Date.now() });
      while (this.busy) {
        await new Promise((r) => setTimeout(r, 500));
        if (!this.clearing) return { cancelled: true };
      }
    }

    this.clearing.phase = 'handoff';
    this.broadcast({ t: 'clearing', phase: 'handoff', restart, at: Date.now() });
    this.handoffPending = true;
    this.busy = true;
    this.input.push({
      type: 'user',
      message: { role: 'user', content: HANDOFF_PROMPT },
      parent_tool_use_id: null,
    });
    return { started: true };
  }

  cancelClear() {
    clearTimeout(this.clearTimer);
    const was = Boolean(this.clearing);
    const restart = Boolean(this.clearing?.restart);
    this.clearing = null;
    this.handoffPending = false;
    this.restartPending = false;
    // CANCELLING ONE SESSION'S HANDOFF CANCELS THE RESTART. The restart was
    // asked for on behalf of every session at once; going ahead without this
    // one's note would restart the process and hand the successor a handoff
    // from somebody else, which is worse than not restarting.
    if (restart) restartAborted = true;
    if (was) this.broadcast({ t: 'clearing', phase: 'cancelled', restart, at: Date.now() });
    return { cancelled: was };
  }

  /**
   * The handoff has landed: keep it, drop everything else, hand it forward.
   *
   * The transcript is NOT wiped. What is cleared is the model's context — the
   * expensive half — while the record of the conversation stays exactly where
   * it was. Clearing both would make `/clear` a thing nobody dares press.
   */
  finishClear(text) {
    if (!this.handoffPending) return;
    this.handoffPending = false;
    const restarting = Boolean(this.clearing?.restart);
    this.clearing = null;
    if (restarting) return this.handOffAndRestart(text);

    const note = { t: 'notice', text: 'context cleared — the handoff below is what the new session starts with.', at: Date.now() };
    this.emit(note, { k: 'notice', ...note, t: undefined });

    try { this.q?.close?.(); } catch { /* already gone */ }
    this.input?.close();
    this.sdkSessionId = null;                 // a NEW session, not a resumed one
    writeState(this.userId, { sessionId: null });
    this.start({ fresh: true });
    this.busy = false;
    this.broadcast({ t: 'clearing', phase: 'done', at: Date.now() });
    this.deliverHandoff(text, { restarted: false });
  }

  /**
   * The same note, across a process boundary instead of inside one.
   *
   * WHAT WENT WRONG WITHOUT THIS, 2026-08-10 12:31. `/clear` was tested end to
   * end in the pod and worked. Production then needed a RESTART — to pick up
   * the very code that does the handoff — and a restart is a different path
   * with none of this on it: the session id was cleared by hand, the process
   * was re-execed, and the successor came up with no context, nothing pushed,
   * and no idea a predecessor had existed. The note had been hand-written into
   * a file and committed, which nothing here reads. A handoff that depends on
   * the next session thinking to go looking is not a handoff.
   *
   * SO THE NOTE GOES TO DISK BEFORE THE KILL. It is the one artefact that
   * cannot be reconstructed afterwards — the session that holds the context is
   * the session about to be terminated — so it is parked first, and the restart
   * is only started once it is written.
   *
   * THE RESTART IS SPAWNED, NOT PERFORMED. `ops/restart.sh` reads the argv,
   * cwd and exe from /proc BEFORE killing anything, so the port, the data
   * directory and above all the token survive: a restart that minted a new
   * token would silently stop authorising the link in the owner's browser while
   * the page looked identical. Detached, because everything after the kill has
   * to already be running somewhere that is not this process.
   */
  handOffAndRestart(text) {
    this.restartPending = false;
    // KEPT, because parking drops it and a restart that does not happen has to
    // be able to put it back. The live query is still running and still knows
    // this id; losing it here would cost the context anyway, which is the exact
    // thing not restarting was supposed to protect.
    const was = this.sdkSessionId;
    try {
      store.parkHandoff(userDir(this.userId), text, 'restart');
    } catch (err) {
      // NOTHING IS RESTARTED IF THE NOTE DID NOT LAND. The session is still
      // alive and still holds its context; a restart now would throw that away
      // to no purpose, which is exactly the failure this method exists for.
      this.restartAbort(`could not write the handoff (${err.message}) — not restarting`);
      return;
    }
    this.sdkSessionId = null;
    const note = {
      t: 'notice',
      text: `handoff saved (${text.length} chars) — restarting; the next session starts with it.`,
      at: Date.now(),
    };
    this.emit(note, { k: 'notice', ...note, t: undefined });
    this.broadcast({ t: 'clearing', phase: 'restarting', restart: true, at: Date.now() });

    // A RESTART THAT CANNOT BE STARTED IS NOT A QUIET NO-OP HERE. The note is
    // already parked and this session's id is already dropped; leaving it there
    // would mean a server that kept running with its context thrown away, and a
    // handoff delivered at some unrelated future boot. Whatever went wrong is
    // said, and the note is unparked with it.
    const out = maybeRestart();
    if (!out.restarting && !out.waiting) {
      this.sdkSessionId = was;
      writeState(this.userId, { sessionId: was });
      this.restartAbort(`could not restart: ${out.why} — the handoff was dropped and this session kept its context`);
    }
  }

  /**
   * A restart that is not going to happen must say so and let go of the claim.
   *
   * The parked note is dropped in the same breath. A note left on disk after a
   * cancelled restart is delivered to whoever boots next — a successor handed a
   * handoff from a session that never ended, describing work that has moved on.
   */
  restartAbort(why) {
    this.restartPending = false;
    this.busy = false;
    try { store.write(userDir(this.userId), { handoff: null }); } catch { /* nothing parked */ }
    this.emitError(why);
    this.broadcast({ t: 'clearing', phase: 'cancelled', restart: true, at: Date.now() });
    restartAborted = true;
  }

  /**
   * Hand the note to a session that has none, and let it start reading.
   *
   * THE NEW SESSION STARTS READING IMMEDIATELY, and says so.
   *
   * THE OWNER, 2026-08-10: "the new session needs to start reading the handoff,
   * not waiting for user to input something."
   *
   * The push alone did start it — and started it INVISIBLY: a turn beginning
   * with no bubble and no record, so the page showed the agent working on
   * something the reader never saw arrive. A turn nobody can account for is the
   * same defect as a turn that never happened, one of them just costs tokens
   * too.
   *
   * It is a JOB bubble, not the owner's: they did not write this, the previous
   * session did.
   *
   * ONE DEFINITION FOR BOTH ROUTES. `/clear` calls it in the process that wrote
   * the note; a restart calls it in the process that comes after. Two copies
   * would drift the first time either half changed, and the restart half is the
   * one nobody watches.
   */
  deliverHandoff(text, { restarted = true } = {}) {
    const at = Date.now();
    const event = {
      t: 'job',
      name: 'handoff',
      label: 'handoff',
      headline: `picking up from the ${restarted ? 'session before the restart' : 'previous session'}`
        + ` — ${text.length} chars of state`,
      at,
    };
    this.emit(event, { k: 'job', ...event, t: undefined });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: `${handoffHeader(restarted)}\n\n${text}` },
      parent_tool_use_id: null,
    });
    this.busy = true;
  }

  /**
   * Change the model, routing it rather than merely naming it.
   *
   * THE DISTINCTION THIS EXISTS FOR. `setModel` alone was the dropdown that
   * selected nothing: a gateway model's name arrived at Anthropic, which does
   * not know it, because the SDK process had no gateway environment — env is
   * fixed when `query()` spawns, so it can only change with the query.
   *
   * Within one provider the name is enough — `setModel` on the live query.
   * Across providers the query itself is replaced, and the conversation
   * follows by its session id. That is the seamless part: opus to qwen3.8-max
   * and back keeps the thread, because a change of provider is not a change of
   * place — unlike cwd, which genuinely cannot carry the context.
   */
  async setModelRouted(want) {
    // THE SAME VERDICT THE SPAWN PATH READS. Asking the router which provider
    // serves each name is what makes "within one provider" a fact rather than
    // a second opinion — and first-party now HAS a provider name, so opus to
    // opus-with-a-different-alias no longer looks like a provider change.
    const from = routeTurn({ model: this.model }).provider;
    const to = routeTurn({ model: want }).provider;
    if (from === to) {
      await this.q.setModel(want || undefined);
      this.model = want || null;
      writeState(this.userId, { model: this.model });
      this.broadcast({ t: 'notice', text: `model → ${want || 'default'}` });
      return;
    }
    this.model = want || null;
    writeState(this.userId, { model: this.model });
    if (this.busy) {
      // Mid-turn: the swap waits for the next `send()`. Announced, not silent
      // — the selector already shows the new name, but the turn still running
      // is on the old provider, and the page should say so.
      this.pendingModelSwap = true;
      this.broadcast({ t: 'notice', text: `model → ${want || 'default'} after this turn` });
      return;
    }
    this.swapQuery(`model → ${want || 'default'}`);
  }

  /**
   * A new query() with the conversation kept. The session id is NOT nulled —
   * `start()` resumes on it, which is what makes a provider switch seamless.
   * (setCwd nulls it for the opposite reason: a new project is a new context.)
   */
  swapQuery(noticeText) {
    try { this.q?.close?.(); } catch { /* already gone */ }
    this.input?.close();
    this.pendingModelSwap = false;
    this.start();
    this.broadcast({ t: 'notice', text: noticeText });
  }

  /** Changing cwd means a new query(); it is fixed for a session's lifetime. */
  async setCwd(nextCwd) {
    const resolved = path.resolve(nextCwd);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`not a directory: ${resolved}`);
    }
    this.cwd = resolved;
    writeState(this.userId, { cwd: resolved });
    this.watchHeartbeat();   // a new project has a different heartbeat
    try { this.q?.close?.(); } catch { /* already gone */ }
    this.input?.close();
    // A session is bound to its cwd, so the agent's context cannot follow it.
    this.sdkSessionId = null;
    writeState(this.userId, { sessionId: null });
    this.start({ fresh: true });
    this.broadcast({ t: 'notice', text: `cwd → ${resolved} (new session)` });
  }
}

function renderToolResult(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
}

function sessionFor(userId) {
  let s = sessions.get(userId);
  if (!s) {
    ensureUserDirs(userId);
    s = new UserSession(userId);
    sessions.set(userId, s);
  }
  return s;
}

// --- restart, with the context carried over --------------------------------

/** The script that outlives this process. It re-execs what /proc says was run. */
const RESTART_SH = path.join(HERE, 'ops', 'restart.sh');

/**
 * One session refused, so nobody restarts. Sticky for the life of the process:
 * a refusal means a note was not written, and the run that was going to carry
 * it is the run being abandoned.
 */
let restartAborted = false;

/**
 * Restart once every session that owed a handoff has parked one.
 *
 * WHY A CHECK AND NOT A CALLBACK. Each session writes its own note when its own
 * turn lands, and the turns land at different times. The first one finishing is
 * not the signal to restart — the second session's note would be being written
 * into a process that is already being killed, which is the loss this exists to
 * prevent, arrived at from the other side.
 */
function maybeRestart(why = 'handoff parked') {
  if (restartAborted) return { restarting: false, why: 'a handoff was refused' };
  // WAITING IS NOT FAILING, and the caller has to be able to tell them apart:
  // one means "somebody else is still writing", the other means "this is not
  // going to happen" and has to be said out loud. Returning false for both
  // would make a broken restart script look exactly like a slow session.
  if ([...sessions.values()].some((s) => s.restartPending)) return { waiting: true };
  return spawnRestart(why);
}

/**
 * Hand the restart to a process that is not about to die.
 *
 * NOTHING HERE VERIFIES IT CAME BACK, and it cannot: the checking half happens
 * after the checker is gone. That is rainsmoke3's revive job — `rm3 revive
 * expect` — and it is armed by whoever asks for the restart, not from inside
 * the blast radius.
 */
function spawnRestart(why) {
  if (!fs.existsSync(RESTART_SH)) {
    return { restarting: false, why: `no restart script at ${RESTART_SH}` };
  }
  try {
    const child = spawn(RESTART_SH, [String(process.pid)], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(`restart requested (${why}) — pid ${process.pid}`);
    return { restarting: true, pid: process.pid };
  } catch (err) {
    return { restarting: false, why: `could not start ${RESTART_SH}: ${err.message}` };
  }
}

/**
 * What a caller outside this process asks for: restart, but not empty-handed.
 *
 * IT ACTS ON EVERY LIVE SESSION, because the process is shared and they all
 * lose their context together. A caller holding the server token has no user
 * cookie and no business naming one — see the health route on why that gate is
 * where it is.
 *
 * NO SESSION MEANS NOTHING TO HAND OFF, and it restarts immediately. A server
 * nobody has spoken to has no context to lose, and making it wait for a handoff
 * that cannot be written would turn "restart it" into "it did nothing, silently".
 */
function restartWithHandoff(seconds = 10) {
  restartAborted = false;
  const live = [...sessions.values()];
  if (!live.length) return { ...spawnRestart('no session to hand off'), handoffs: 0 };

  // A SESSION ALREADY CLEARING DOES NOT START A SECOND ONE, and `startClear`
  // says so by returning `already`. Reporting `started: true` over the top of
  // that is the shape this project keeps filing: the caller is told the thing
  // it asked for is happening, the countdown it is watching belongs to a plain
  // /clear, and the restart never comes. So the answer names what each session
  // actually did, and says plainly when none of them started.
  // NOT AWAITED, AND THEREFORE NOT ASKED. `startClear` is async — it resolves
  // when the countdown and the handoff are over — so its `already` verdict is
  // inside a promise this cannot wait for without waiting out the countdown it
  // is starting. The state it reads is the same state `startClear` re-checks.
  const armed = live.filter((session) => {
    if (session.clearing) return false;
    session.startClear(seconds, { restart: true });
    return true;
  });
  if (!armed.length) {
    restartAborted = true;
    return { started: false, why: 'every session is already clearing — cancel that first', handoffs: 0 };
  }
  return { started: true, seconds, handoffs: armed.length, busy: live.length - armed.length };
}

// --- HTTP ------------------------------------------------------------------

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY_BYTES) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const COOKIE = 'agentchat_user';

function cookies(req) {
  const jar = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) jar[k] = decodeURIComponent(rest.join('='));
  }
  return jar;
}

function currentUser(req) {
  return slugify(cookies(req)[COOKIE] ?? '');
}

/** Constant-time compare, so the token cannot be discovered a byte at a time. */
function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Gate every request when a token is in force. Presenting `?k=` once swaps it
 * for a cookie, so the secret stays out of subsequent URLs and out of the
 * Referer header on anything the page loads.
 */
function authorized(req, res, params) {
  if (!TOKEN) return true;
  if (sameSecret(cookies(req)[KEY_COOKIE] ?? '', TOKEN)) return true;
  const offered = params.get('k');
  if (offered && sameSecret(offered, TOKEN)) {
    res.setHeader('set-cookie', `${KEY_COOKIE}=${TOKEN}; Path=/; Max-Age=31536000; SameSite=Lax`);
    return true;
  }
  return false;
}

function knownUsers() {
  try {
    return fs.readdirSync(path.join(DATA_DIR, 'users'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

/**
 * `pathname` comes from the caller's parsed URL, not from `req.url`.
 *
 * Re-parsing here is what broke it: the old check compared `req.url === '/'`,
 * so the moment the link carried `?k=…` the path resolved to the public
 * DIRECTORY, `createReadStream` raised EISDIR as an unhandled error event, and
 * the process died. One request, whole server down — survivable on loopback,
 * a remote kill switch once bound to the network.
 *
 * So: one source for the path, `isFile` rather than `exists`, and an error
 * handler on the stream so no read failure can reach the event loop unhandled.
 */
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  // no-store, because a cached page/stylesheet survives a fix. A stale
  // style.css is what kept the sign-in overlay on screen after it was fixed.
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const url = parsed.pathname;

  if (!authorized(req, res, parsed.searchParams)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('agent-chat: open the link with its ?k=… token\n');
  }

  try {
    // --- liveness (no session required, and deliberately so) ---
    //
    // ABOVE THE SIGN-IN GATE ON PURPOSE. This is what a restart asks before it
    // kills the process, and a restart script holds the server token but no
    // user cookie — behind the gate it answered 401 to the one caller that
    // needs it, and the script would have read that as "no such route" and
    // killed a running turn. It carries no user data: whether anything is
    // mid-turn, and how many sessions exist.
    if (url === '/api/health') {
      return json(res, 200, {
        ok: true,
        busy: [...sessions.values()].some((s) => s.busy),
        users: sessions.size,
      });
    }

    // --- restart, with a handoff (no session required, for the same reason) ---
    //
    // BESIDE HEALTH, ABOVE THE SIGN-IN GATE. The caller is whatever is
    // restarting the server: a script, a job, or the agent itself from a shell.
    // It holds the server token and no user cookie, and behind the gate this
    // answered 401 to the only caller that ever needs it — which is how the
    // handoff gets skipped and the restart happens anyway, by hand, empty.
    //
    // `cancel` is here rather than on /api/clear because a restart is not one
    // user's clear: it was started for every session at once and it has to be
    // stoppable the same way.
    if (url === '/api/restart' && req.method === 'POST') {
      const { cancel, seconds } = await readBody(req);
      if (cancel) {
        restartAborted = true;
        return json(res, 200, { cancelled: [...sessions.values()].map((s) => s.cancelClear()) });
      }
      return json(res, 200, restartWithHandoff(Number(seconds) > 0 ? Number(seconds) : 10));
    }

    // --- identity (no session required) ---
    if (url === '/api/me') {
      const user = currentUser(req);
      return json(res, 200, { user: user || null, users: knownUsers() });
    }

    if (url === '/api/login' && req.method === 'POST') {
      const { user } = await readBody(req);
      const id = slugify(user);
      if (!id) return json(res, 400, { error: 'name must start with a letter or digit (a–z, 0–9, . _ -)' });
      ensureUserDirs(id);
      res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax`);
      return json(res, 200, { user: id });
    }

    if (url === '/api/logout' && req.method === 'POST') {
      res.setHeader('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
      return json(res, 200, { ok: true });
    }

    // --- everything below is per user ---
    const userId = currentUser(req);
    if (url.startsWith('/api/')) {
      if (!userId) return json(res, 401, { error: 'not signed in' });
    } else {
      return serveStatic(res, url);
    }

    if (url.startsWith('/api/image/')) {
      const name = path.basename(decodeURIComponent(url.slice('/api/image/'.length)));
      const file = path.join(userDir(userId), 'images', name);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'no such image' });
      const ext = path.extname(file).slice(1);
      const type = [...IMAGE_MEDIA_TYPES].find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=31536000' });
      const image = fs.createReadStream(file);
      image.on('error', () => res.destroy());   // never an unhandled error event
      return image.pipe(res);
    }

    const session = sessionFor(userId);

    if (url === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const hello = {
        t: 'hello',
        user: userId,
        cwd: session.cwd,
        sessionId: session.sdkSessionId,
        busy: session.busy,
        model: session.model,
        effort: session.effort,
        activeEffort: session.activeEffort,
      };
      res.write(`data: ${JSON.stringify(hello)}\n\n`);
      res.write(`data: ${JSON.stringify({ t: 'history', items: readHistory(userId) })}\n\n`);
      session.clients.add(res);
      // Forced: a page that just opened has no state to be a change from, and
      // the heartbeat may not beat again for a minute.
      session.pushHeartbeat(true);
      const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
      req.on('close', () => { clearInterval(keepAlive); session.clients.delete(res); });
      return;
    }

    // The settings surface. rainsmoke3 owns the list, the bounds and the
    // meanings; this passes them through and passes a change back. Nothing
    // here knows a tunable's name, so adding one is an entry in rm3's
    // registry and no change to the page at all.
    // The jobs page. rainsmoke3 owns the list, each job owns its own settings,
    // and this passes both through — so a job added there needs no change here
    // and none on the page.
    if (url === '/api/clear' && req.method === 'POST') {
      const { cancel, restart } = await readBody(req);
      if (cancel) return json(res, 200, session.cancelClear());
      // The same countdown and the same handoff either way; `restart` decides
      // only where the note is handed over — to the session this process starts
      // next, or to the process that starts after this one dies.
      if (restart) restartAborted = false;
      session.startClear(10, { restart: Boolean(restart) });   // not awaited: the countdown is the point
      return json(res, 200, { started: true, seconds: 10, restart: Boolean(restart) });
    }

    if (url === '/api/jobs') {
      const body = req.method === 'POST' ? await readBody(req) : null;
      try {
        if (body?.job) await run(RM3_BIN, ['jobs', `${body.job}=${body.on ? 'on' : 'off'}`]);
        else if (body?.name) await run(RM3_BIN, ['tunables', `${body.name}=${body.value ?? ''}`]);
        const out = await run(RM3_BIN, ['jobs']);
        if (body) session.pushHeartbeat(true);
        return json(res, 200, JSON.parse(out));
      } catch (err) {
        return json(res, 503, { error: `rainsmoke3 unavailable: ${err.message}` });
      }
    }

    if (url === '/api/tunables') {
      // Read once: the request body is a stream, and a second read returns
      // nothing rather than the same object.
      const body = req.method === 'POST' ? await readBody(req) : null;
      const arg = body ? `${body.name}=${body.value ?? ''}` : null;
      try {
        const out = await run(RM3_BIN, arg ? ['tunables', arg] : ['tunables']);
        const report = JSON.parse(out);
        if (arg) session.pushHeartbeat(true);   // the panel states the interval
        // What this user chose, alongside what rainsmoke3 holds. Two owners,
        // one surface: the page cannot say where a setting lives, but it can
        // say that every setting shown here outlives the process.
        report.page = {
          model: session.model,
          effort: session.effort,
          activeEffort: session.activeEffort,
          cwd: session.cwd,
          storedAt: path.join(userDir(userId), 'state.json'),
        };
        return json(res, 200, report);
      } catch (err) {
        return json(res, 503, { error: `rainsmoke3 unavailable: ${err.message}` });
      }
    }

    if (url === '/api/models') {
      // The menu is DERIVED from the same verdict the spawn path reads, so a
      // row cannot claim a reachability the routing disagrees with. The SDK's
      // per-model capabilities and the golden record's are merged there, not
      // concatenated here — they were always the same shape.
      return json(res, 200, {
        models: menu({ sdkModels: await session.q.supportedModels() }),
        current: session.model,
        effort: session.effort,
        activeEffort: session.activeEffort,
        thinking: session.thinking,
        cache: session.cache,
        // Where the credentials came from, and what ambient routing this
        // process is refusing to inherit — both states a person can now see.
        providers: providerSources(),
        ambient: session.route?.ambient ?? [],
      });
    }

    // --- the llm config page ------------------------------------------
    //
    // ONE READER FOR WHAT IS LEGAL. The page greys out what the save would
    // refuse because both ask `legalFor`, so a control cannot offer a
    // combination the machine rejects — the same invariant that keeps the
    // model menu from listing something the spawn path cannot serve.
    if (url === '/api/llms') {
      const listed = menu({ sdkModels: await session.q.supportedModels() }).map((m) => m.value);
      const rows = allSettings(listed).map((s) => ({
        ...s,
        legal: legalFor(s.model, { thinking: s.thinking }),
        // WHICH GATEWAY, NOT WHICH KEY. The row says whether a credential
        // exists and how to recognise it; the secret itself has no route to
        // this response.
        key: s.url ? (describeKeys().find((k) => k.gateway === gatewayId(s.url)) ?? null) : null,
      }));
      return json(res, 200, { models: rows, keys: describeKeys(), current: session.model });
    }

    if (url === '/api/llms' && req.method === 'POST') {
      const { model, patch } = await readBody(req);
      let saved;
      try {
        saved = saveSettings(model, patch ?? {});
      } catch (err) {
        // REFUSED WITH THE REASON, and the reason names what WOULD be legal.
        return json(res, 400, { error: String(err.message ?? err) });
      }
      // A SETTING FOR THE MODEL YOU ARE ON APPLIES NOW, or the page and the
      // session disagree — which is the exact state this store was asked to
      // end. Effort is a live control request; thinking and caching are
      // query() options, so they need a new query.
      if (model === session.model) {
        const touched = Object.keys(patch ?? {});
        if (touched.includes('effort')) {
          try { await session.q.applyFlagSettings({ effortLevel: saved.effort }); } catch { /* reported below */ }
        }
        if (touched.includes('thinking') || touched.includes('cache') || touched.includes('url')) {
          session.restart();
        }
        session.broadcast({ t: 'notice', text: `${model}: ${touched.join(', ')} → saved` });
      }
      return json(res, 200, saved);
    }

    // WHAT WOULD BE LEGAL FOR SOMETHING THAT DOES NOT EXIST YET. The add form
    // needs the same verdict the row and the save use, before there is a row
    // to ask about — otherwise it offers `xhigh` for a gateway that has never
    // heard of effort, and the refusal arrives after the owner has filled the
    // form in.
    if (url === '/api/llms/legal' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, legalFor(body.model ?? '', {
        thinking: body.thinking ?? null,
        url: body.url ?? null,
      }));
    }

    if (url === '/api/llms/key' && req.method === 'POST') {
      const { url: gateway, key, sameAs } = await readBody(req);
      try {
        // BY REFERENCE, NOT BY VALUE. The page never holds a secret, so
        // "reuse the key from that gateway" is a name it sends rather than a
        // string it was given — nothing to leak through a response or a
        // cached page.
        const out = sameAs ? reuseKey(sameAs, gateway) : saveKey(gateway, key);
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: String(err.message ?? err) });
      }
    }

    if (url === '/api/send' && req.method === 'POST') {
      const { text, images } = await readBody(req);
      const accepted = acceptImages(images);
      const body = String(text ?? '').trim();
      if (!body && accepted.length === 0) return json(res, 400, { error: 'nothing to send' });
      session.send(body, accepted);
      return json(res, 200, { ok: true });
    }

    if (url === '/api/model' && req.method === 'POST') {
      const { model } = await readBody(req);
      await session.setModelRouted(model || null);
      return json(res, 200, { ok: true });
    }

    if (url === '/api/effort' && req.method === 'POST') {
      const { effort } = await readBody(req);
      // The page only offers levels the model names, but the server does not
      // take the page's word for it: an effort a model cannot take would send
      // a parameter the gateway rejects, arriving as a dead turn.
      const probe = routeTurn({ model: session.model, effort });
      const refused = probe.dropped.find((d) => d.what === 'effort');
      if (refused) {
        // THE ROUTER'S OWN REASON, not a second sentence written here that
        // could drift from it. Where the provider has no ladder at all the
        // level still means something — a turn ceiling — so say what it bought.
        const ceiling = probe.options.maxTurns;
        return json(res, 400, {
          error: refused.why,
          appliesAs: ceiling ? `a ${ceiling}-turn ceiling` : null,
        });
      }
      // Session-scoped: applyFlagSettings is streaming-input-mode only, which
      // is why each user keeps one long-lived query rather than one per turn.
      await session.q.applyFlagSettings({ effortLevel: effort || null });
      session.effort = effort || null;
      writeState(userId, { effort: session.effort });
      // WRITTEN THROUGH TO THE CONFIG, so the quick selector and the config
      // page cannot hold different answers for one model. Two paths to one
      // setting is the divergence the config store was built to end; leaving
      // this one writing only session state would have re-created it beside
      // the fix. A model with no url is first-party and always saveable.
      if (effort) {
        try { saveSettings(session.model ?? 'default', { effort }); } catch { /* the machine refused it; the live query already has it */ }
      }
      session.broadcast({ t: 'notice', text: `effort → ${effort || 'default'}` });
      return json(res, 200, { ok: true });
    }

    if (url === '/api/thinking' && req.method === 'POST') {
      const { thinking } = await readBody(req);
      const want = thinking === 'disabled' || thinking === 'adaptive' ? thinking : null;
      session.thinking = want;
      writeState(userId, { thinking: want });
      // Same write-through as effort: one setting, one stored answer.
      if (want) {
        try { saveSettings(session.model ?? 'default', { thinking: want }); } catch { /* refused; session state stands */ }
      }
      // thinking is a query() option, so it is fixed for a session's lifetime.
      session.restart();
      session.broadcast({ t: 'notice', text: `thinking → ${want ?? 'default'} (new session)` });
      return json(res, 200, { ok: true, thinking: want });
    }

    if (url === '/api/cache' && req.method === 'POST') {
      const { cache } = await readBody(req);
      const want = cache === true || cache === false ? cache : null;
      session.cache = want;
      writeState(userId, { cache: want });
      // DISABLE_PROMPT_CACHING is read by the CLI at spawn, so this is a
      // query() option in everything but name and changing it means a new one.
      session.restart();
      const caps = routeTurn({ model: session.model, cache: want }).capabilities.promptCache;
      session.broadcast({
        t: 'notice',
        text: `prompt cache → ${want === null ? 'provider default' : want ? 'on' : 'off'} (new session)`
          + (caps.verified ? '' : ` — ${session.model ?? 'this provider'}'s caching is unverified, so it is not relied on`),
      });
      return json(res, 200, { ok: true, cache: want, capability: caps });
    }

    if (url === '/api/cwd' && req.method === 'POST') {
      const { cwd } = await readBody(req);
      await session.setCwd(cwd);
      return json(res, 200, { ok: true, cwd: session.cwd });
    }

    if (url === '/api/interrupt' && req.method === 'POST') {
      await session.q.interrupt();
      session.busy = false;
      session.broadcast({ t: 'notice', text: 'interrupted' });
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'no such endpoint' });
  } catch (err) {
    return json(res, 500, { error: err?.message ?? String(err) });
  }
});

/** The address to hand someone on the LAN, rather than the bind wildcard. */
function lanAddress() {
  if (HOST !== '0.0.0.0' && HOST !== '::') return HOST;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (name === 'lo') continue;
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

fs.mkdirSync(path.join(DATA_DIR, 'users'), { recursive: true });
server.listen(PORT, HOST, () => {
  const link = `http://${lanAddress()}:${PORT}/${TOKEN ? `?k=${TOKEN}` : ''}`;
  console.log(`agent-chat  ${link}`);
  console.log(`data        ${DATA_DIR}`);
  console.log(`default cwd ${DEFAULT_CWD}`);
  console.log('permissions bypassPermissions — every tool runs unprompted');
  if (TOKEN) {
    console.log(`\n  bound to ${HOST} — reachable from your network.`);
    console.log('  The link above carries the only token; without it every request is 403.');
  }
});

/**
 * A turn cut off by a restart must SAY it was cut off.
 *
 * The reply is composed inside this process, so terminating it truncates the
 * answer mid-sentence. The transcript then ends with no explanation, and the
 * reader is left deciding whether the agent stopped, crashed, or is still
 * thinking. Nothing here can save the turn — the SDK query dies with the
 * process — but it can make the gap legible, and it can flush what was
 * already written.
 *
 * The conversation itself survives regardless: the SDK session id is in each
 * user's state, so the next start resumes the agent's own memory. What is lost
 * is the in-flight answer, and only that.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    for (const session of sessions.values()) {
      // EVERY SESSION IS TOLD, not only a busy one. This used to skip idle
      // sessions on the grounds that they had lost nothing — true, and beside
      // the point. THE OWNER, 2026-08-10: "I need some kind of indicator it
      // restarted." An idle session is exactly where a restart is invisible:
      // nothing was cut off, so nothing looked wrong, so the transcript simply
      // continues across a boundary the reader cannot see.
      const note = {
        t: 'notice',
        text: session.busy
          ? `the server is restarting (pid ${process.pid}) — this reply was cut off. `
            + 'The conversation resumes; the unfinished answer does not.'
          : `the server is restarting (pid ${process.pid}).`,
        at: Date.now(),
      };
      try {
        session.emit(note, { k: 'notice', ...note, t: undefined });
      } catch { /* a dying process must still reach the next session */ }
    }
    process.exit(0);
  });
}

/**
 * AND THE OTHER HALF: say when it came back.
 *
 * The going-down notice is written by a process about to die, into a stream
 * that dies with it — a page connected at that moment may never render it, and
 * a page connected LATER never had it. So the coming-up half is written here,
 * on boot, into the transcript rather than only the connection: it is on disk,
 * so it is there whenever anyone next looks.
 *
 * WRITTEN PER USER, ONCE, at startup. A session is constructed lazily on first
 * request, so this walks the user directories rather than `sessions` — which is
 * empty at this point and would have made the marker appear only for whoever
 * happened to connect during the first request, which is nobody.
 */
for (const userId of knownUsers()) {
  try {
    if (!fs.existsSync(transcriptPath(userId))) continue;   // never spoke here
    appendRecord(userId, {
      k: 'notice',
      text: `the server restarted and is back (pid ${process.pid}).`,
    });

    /**
     * AND THE HANDOFF, IF THE PROCESS THAT DIED LEFT ONE.
     *
     * This is the far side of `handOffAndRestart`, and the only place the note
     * is read. Taking it CLEARS it first (state.mjs), so a server that crashes
     * during this turn hands the next boot nothing rather than the same note
     * again — a crash loop that re-reads a handoff pays for it every time and,
     * from the page, looks like an agent talking to itself.
     *
     * The session is constructed here rather than waiting for a browser: the
     * point of the note is that the successor starts reading it, and on this
     * machine nobody may open the page for hours. A pod is the extreme case —
     * nothing ever attaches to it by design.
     */
    const handoff = store.takeHandoff(userDir(userId));
    if (handoff) sessionFor(userId).deliverHandoff(handoff.text);
  } catch (err) {
    // PER USER, so one unreadable directory cannot silently cost every other
    // user their handoff. A marker that cannot be written must not stop the
    // server — but a handoff dropped here is a session's whole context, so it
    // is said out loud rather than swallowed.
    console.error(`startup (${userId}): ${err.message}`);
  }
}
