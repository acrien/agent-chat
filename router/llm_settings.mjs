/**
 * llm_settings.mjs — what YOU chose, per model, and nothing chosen elsewhere.
 *
 * THE COMPLAINT THIS ANSWERS, 2026-08-11: "there's no way I know the setting
 * of the server if it differs from what I set in the config page."
 *
 * THE DEFECT IT NAMES, measured the same day. The page offered an effort
 * option spelled `default` whose value was the empty string; that became
 * `effort: null` in the session state; and the CLI's own persisted
 * `effortLevel` — `xhigh`, which the owner never chose — filled the gap. On
 * Claude Opus 5 with thinking disabled that combination is a 400, so every
 * turn failed with a setting nobody had picked and nobody could see.
 *
 * SO NO FIELD IS EVER NULL. There is no `default` here. If a model should run
 * at its provider's usual level, the RESOLVED value is written down, because
 * a stored `null` does not mean "no value" — it means "something I cannot see
 * will choose", which is the same shape as the gateway this router already
 * removed from the environment. Written down, a restart restores it; unset,
 * a restart restores nothing and the invisible default wins again.
 *
 * NO SECRETS LIVE HERE. This file is synced to the lab pod so a review can run
 * on the model you picked; keys stay in `keys.mjs`, outside every repository
 * and never synced. The pod learns WHICH model to run and uses its own
 * credential for that gateway.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { capabilitiesFor, goldenRecordFor, EFFORT_ORDER } from './capability_table.mjs';
import { FIRST_PARTY } from './provider_registry.mjs';

export const SETTINGS_FILE = process.env.RM_LLM_SETTINGS
  || path.join(os.homedir(), '.agent-chat', 'llms.json');

/** The shape every entry has. Every key present, every value a real value. */
export const FIELDS = Object.freeze(['displayName', 'company', 'url', 'effort', 'thinking', 'cache']);

function read() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))?.models ?? {};
  } catch {
    return {};
  }
}

function write(models) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify({ models }, null, 2)}\n`);
}

/** The provider a model routes to, without needing the whole registry. */
function providerOf(model, stored) {
  if (stored?.url) return null;                 // a declared url means a gateway
  return goldenRecordFor(model)?.provider ?? FIRST_PARTY;
}

/**
 * What is LEGAL for a model, given the constraints between fields.
 *
 * THE PAGE ASKS THIS, AND SO DOES THE SAVE. One verdict, two readers — the
 * same invariant that keeps the model menu from offering something the spawn
 * path cannot serve. A page that greys out `xhigh` while the server would
 * accept it is a page telling a different story from the machine.
 */
export function legalFor(model, { thinking = null, url = undefined } = {}) {
  const record = goldenRecordFor(model);
  // A MODEL BEHIND A URL NOBODY HAS PROBED GETS NOTHING OFFERED. Falling back
  // to the first-party ladder would show `xhigh` for a gateway that has never
  // heard of effort — the menu promising what the turn cannot do, which is the
  // shape this whole layer exists to stop. `capabilitiesFor` answers UNKNOWN
  // for a provider it has no entry for, and unknown is the honest answer.
  const declaredUrl = url === undefined ? (read()[model]?.url ?? null) : url;
  const provider = record?.provider ?? (declaredUrl ? `gateway:${declaredUrl}` : FIRST_PARTY);
  const caps = capabilitiesFor(provider, record);
  let effort = [...caps.effort.levels];
  const cap = thinking === 'disabled' ? caps.thinking.disabledMaxEffort : null;
  if (cap) {
    const ceiling = EFFORT_ORDER.indexOf(cap);
    effort = effort.filter((l) => EFFORT_ORDER.indexOf(l) <= ceiling);
  }
  return {
    effort,
    // A provider whose thinking form was never probed gets one option, so the
    // page cannot offer a switch that does nothing.
    thinking: caps.thinking.form === 'anthropic' ? ['adaptive', 'disabled'] : ['disabled'],
    cache: caps.promptCache.supported ? [true, false] : [false],
    why: {
      effort: cap ? `${caps.thinking.note} — thinking is off` : caps.effort.note ?? null,
      cache: caps.promptCache.verified ? null : caps.promptCache.note,
    },
  };
}

/** The settings in force for a model: stored where stored, resolved elsewhere. */
export function settingsFor(model) {
  const stored = read()[model] ?? {};
  const legal = legalFor(model, { thinking: stored.thinking ?? 'adaptive' });
  const thinking = legal.thinking.includes(stored.thinking) ? stored.thinking : legal.thinking[0];
  // RESOLVED, NOT NULL. The strongest level this model can take with the
  // thinking it has — written into the answer so the caller states it.
  const afterThinking = legalFor(model, { thinking });
  const effort = afterThinking.effort.includes(stored.effort)
    ? stored.effort
    : (afterThinking.effort[afterThinking.effort.length - 1] ?? null);
  const cache = typeof stored.cache === 'boolean' ? stored.cache : legal.cache[0];
  return {
    model,
    displayName: stored.displayName || goldenRecordFor(model)?.displayName || model,
    url: stored.url ?? null,
    provider: providerOf(model, stored),
    effort,
    thinking,
    cache,
    stored: Object.keys(read()[model] ?? {}),
  };
}

/** Everything the page lists. */
export function allSettings(models = []) {
  const stored = read();
  const names = [...new Set([...models, ...Object.keys(stored)])];
  return names.map((m) => settingsFor(m));
}

/**
 * Save a change, refusing one the machine would not accept.
 *
 * REFUSED HERE RATHER THAN AT THE TURN. A setting that is stored and then
 * rejected every time it is used is worse than one never stored: the page
 * says it is set, the turns say otherwise, and the owner has no way to tell
 * which is lying. That is the exact state this file was asked to end.
 */
export function saveSettings(model, patch = {}) {
  if (!model) throw new Error('which model?');
  const stored = read();
  const next = { ...(stored[model] ?? {}) };
  for (const field of FIELDS) {
    if (patch[field] !== undefined) next[field] = patch[field];
  }
  const thinking = next.thinking ?? settingsFor(model).thinking;
  const legal = legalFor(model, { thinking });
  if (next.thinking !== undefined && !legal.thinking.includes(next.thinking)) {
    throw new Error(`${model} cannot take thinking '${next.thinking}'`);
  }
  if (next.effort !== undefined && !legal.effort.includes(next.effort)) {
    throw new Error(
      `${model} cannot take effort '${next.effort}' with thinking '${thinking}'`
      + (legal.why.effort ? ` — ${legal.why.effort}` : '')
      + `. Legal: ${legal.effort.join(', ') || 'none'}`,
    );
  }
  if (next.cache === true && !legal.cache.includes(true)) {
    throw new Error(`${model} does not serve prompt caching`);
  }
  stored[model] = next;
  write(stored);
  return settingsFor(model);
}
