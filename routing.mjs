/**
 * routing.mjs — where a selected model actually goes.
 *
 * WHY THIS EXISTS AS ITS OWN FILE. The model menu was built on 2026-08-10 with
 * gateway models in it — THE OWNER: "the model should include qwen3.8-max" —
 * and selecting one did nothing, because the menu and the routing were two
 * sites naming one thing, and only one of them was built. The menu said
 * "reachable" whenever the credentials file had a base_url and a key; the SDK
 * process had neither, so the name went to Anthropic, which does not know it,
 * and the turn died looking like a model failure.
 *
 * So the menu and the routing are now ONE function. `providerFor` is the only
 * place that decides whether a model can be served and what that serving
 * needs, and `gatewayModels` derives the menu from it — a model the spawn path
 * cannot provide cannot appear as available, which is the mismatch made
 * unrepresentable rather than checked.
 *
 * It lives outside server.mjs so the decision can be imported and falsified
 * without starting a listener — server.mjs runs its top level on import, and a
 * routing rule nobody can test is the same as a rule nobody wrote.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The same credentials agent-chat has always read, and rm2 authenticates with. */
export const LLM_CONFIG = process.env.RAINSMOKE_LLM_CONFIG
  || path.join(os.homedir(), 'projects', 'rayxiv4', 'config', 'llm_config.json');

export function readGolden() {
  // THE GOLDEN RECORD IS THE LIST. Deriving it from the credentials file would
  // make a model disappear the moment a key was rotated out — which is the
  // disappearance this file exists to prevent, arriving by a different door.
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'models.golden.json'), 'utf8'));
  } catch {
    return { models: [] };
  }
}

/**
 * The routing verdict for one model name.
 *
 *   null            — first-party (or default): the session's own OAuth serves
 *                     it, and the SDK process needs no extra environment.
 *   { model, missing } — the golden record lists it but THIS machine cannot
 *                     route it; `missing` says why. The menu must show this,
 *                     not hide it: a vanished model is the disappearance, and
 *                     a listed-but-unroutable one at least says so.
 *   { model, env }  — the complete environment for the SDK's child process.
 *
 * THE ENV IS COMPLETE ON PURPOSE. The SDK passes `options.env` through
 * verbatim — its default is `{...process.env}`, and a provided env REPLACES
 * that rather than merging — so this hands over everything the child needs,
 * with two measured exceptions:
 *
 *   ANTHROPIC_API_KEY is DELETED. It outranks the gateway token; leave it set
 *   and the request is rejected and the turn comes back empty, reading as a
 *   model failure rather than a configuration one. Measured in
 *   rainsmoke/ops/cc_qwen.sh, which speaks to this same gateway.
 *
 *   CLAUDE_CODE_MAX_CONTEXT_TOKENS comes from the golden record. The CLI does
 *   not recognise a gateway model and falls back to assuming 200k, then
 *   auto-compacts — a 1M model silently losing 800k. Reading it here keeps one
 *   source: the same file the menu is built from, so the two cannot disagree.
 */
export function providerFor(model) {
  if (!model) return null;
  const m = (readGolden().models ?? []).find((x) => x.value === model && !x.retired);
  if (!m) return null;   // not ours: a first-party name the CLI itself knows

  let providers = {};
  try {
    providers = JSON.parse(fs.readFileSync(LLM_CONFIG, 'utf8')).providers ?? {};
  } catch {
    return { model: m, missing: `no credentials file at ${LLM_CONFIG}` };
  }
  const prov = providers[m.provider] ?? {};
  if (!prov.base_url || !prov.api_key) {
    return { model: m, missing: `provider ${m.provider} has no base_url or api_key` };
  }

  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: prov.base_url,
    ANTHROPIC_AUTH_TOKEN: prov.api_key,
  };
  delete env.ANTHROPIC_API_KEY;
  // THE WINDOW IS THE RECORD'S OR NOBODY'S. An ambient value — a shell export,
  // a previous experiment left in a service file — would silently become the
  // context window of every gateway model, including ones the record gives no
  // window. Deleted first, then set only from the golden record. Found by the
  // test this same day: this very session's shell carried one.
  delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  if (m.contextTokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(m.contextTokens);
  return { model: m, env };
}

/**
 * The gateway half of the model menu.
 *
 * Reachability is DEFINED as "providerFor can route it" — the menu and the
 * spawn path read one verdict, so they cannot drift the first time a provider
 * changes. Before this file existed the menu had its own check, and the two
 * disagreed by construction: that was the dropdown that selected nothing.
 */
export function gatewayModels() {
  return (readGolden().models ?? []).filter((m) => !m.retired).map((m) => {
    const routed = providerFor(m.value);
    const reachable = Boolean(routed?.env);
    const levels = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [];
    return {
      value: m.value,
      displayName: reachable ? m.displayName : `${m.displayName}  (no key)`,
      description: m.description ?? '',
      supportsEffort: levels.length > 0,
      supportedEffortLevels: levels,
    };
  });
}
