/**
 * provider_registry.mjs — WHERE a turn goes, and with what credential.
 *
 * THE DEFECT THIS EXISTS FOR, measured 2026-08-11 from the live server log:
 * the owner selected opus, `[session] model=opus[1m]` was printed, the query
 * respawned correctly — and the turn came back `rate_limit`, because the
 * request went to the Alibaba gateway. `server.mjs` had loaded provider.env
 * into its own `process.env` at startup; `providerFor` returned null for a
 * first-party name, meaning "no env needed"; and the SDK's default env is
 * `{...process.env}` — the poisoned one. Opus was served by qwen's quota.
 *
 * SO THE ROUTER HOLDS PROVIDERS AS DATA, AND NOTHING WRITES `process.env`.
 * A credential read into a process-wide variable is a credential every later
 * decision inherits without asking for it. Every provider here is a value:
 * named, sourced, and carrying the exact environment its turns need.
 *
 * ANTHROPIC IS AN ENTRY, NOT AN ABSENCE. The old code modelled first-party as
 * "no entry, no env" — and "no env" is what let the ambient one through. It is
 * a provider like the others, whose credential happens to be the session's own
 * OAuth file and whose declared environment is empty ON PURPOSE.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every environment variable the router owns end to end.
 *
 * THIS LIST IS A STRIP LIST FIRST AND A SET LIST SECOND. `ambient_env.mjs`
 * removes all of it before a route adds back only what it declares, so a
 * variable left in a shell, a service file, or a `podman --env-file` cannot
 * become a routing decision nobody made. Adding a provider variable anywhere
 * means adding it here, and the test holds the two against each other.
 */
export const ROUTED_VARS = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'DISABLE_PROMPT_CACHING',
]);

/** The first-party provider's name. Not a magic string anywhere else. */
export const FIRST_PARTY = 'anthropic';

/**
 * The router's own declaration — the source the LAB POD uses.
 *
 * The pod has no `llm_config.json`: it was handed the gateway through
 * `podman --env-file`, so `providerFor` reported every gateway model as
 * "(no key)" while those models were in fact the only ones working. The menu
 * lied in one direction there and in the other direction here. A declared file
 * the router reads as data ends both.
 */
export const PROVIDERS_FILE = process.env.RM_ROUTER_PROVIDERS
  || path.join(os.homedir(), '.agent-chat', 'providers.json');

/** The credentials this box already had; kept so nothing is re-entered here. */
export const LLM_CONFIG = process.env.RAINSMOKE_LLM_CONFIG
  || path.join(os.homedir(), 'projects', 'rayxiv4', 'config', 'llm_config.json');

function readJson(file) {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (err) { return { ok: false, why: err.code === 'ENOENT' ? 'absent' : err.message }; }
}

/** One gateway entry from whichever file declared it. */
function gateway(name, spec, source) {
  const baseUrl = spec?.base_url ?? spec?.baseUrl ?? null;
  const token = spec?.api_key ?? spec?.apiKey ?? null;
  if (!baseUrl || !token) {
    // LISTED AND UNROUTABLE IS NOT THE SAME AS ABSENT. A model that vanishes
    // from a menu reads as a model that was never there — the disappearance
    // the golden record exists to prevent, arriving through the provider table.
    return {
      name,
      transport: 'anthropic_gateway',
      reachable: false,
      missing: `${name} has no ${!baseUrl ? 'base_url' : 'api_key'} in ${source}`,
      env: {},
      source,
    };
  }
  return {
    name,
    transport: 'anthropic_gateway',
    reachable: true,
    missing: null,
    env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token },
    source,
  };
}

/**
 * The provider table, most specific source last.
 *
 * `providers.json` outranks `llm_config.json` for the same name: the file that
 * names the router is a deliberate statement about routing, while the other is
 * a credentials file this project borrows and does not own.
 */
export function providers() {
  const table = new Map();

  table.set(FIRST_PARTY, {
    name: FIRST_PARTY,
    transport: 'oauth',
    reachable: true,
    missing: null,
    // EMPTY ON PURPOSE, AND THAT IS THE WHOLE POINT. The CLI authenticates
    // from ~/.claude/.credentials.json when — and only when — no base url and
    // no token are in its environment. Declaring {} is how the router says
    // "this turn carries no gateway", which is a decision; inheriting whatever
    // was ambient is the absence of one.
    env: {},
    source: 'the session\'s own OAuth credential',
  });

  for (const [file, pick] of [
    [LLM_CONFIG, (d) => d?.providers ?? {}],
    [PROVIDERS_FILE, (d) => d?.providers ?? {}],
  ]) {
    const read = readJson(file);
    if (!read.ok) continue;
    for (const [name, spec] of Object.entries(pick(read.data))) {
      if (name === FIRST_PARTY) continue;  // never redefinable from a file
      table.set(name, gateway(name, spec, file));
    }
  }
  return table;
}

/** What the registry read, and what it found — for the page and the handback. */
export function providerSources() {
  return [LLM_CONFIG, PROVIDERS_FILE].map((file) => {
    const read = readJson(file);
    return {
      file,
      present: read.ok,
      why: read.ok ? null : read.why,
      declares: read.ok ? Object.keys(read.data?.providers ?? {}) : [],
    };
  });
}

/** Every variable any declared provider could set, plus the router's own. */
export function declaredVars(table = providers()) {
  const names = new Set(ROUTED_VARS);
  for (const p of table.values()) for (const k of Object.keys(p.env)) names.add(k);
  return names;
}
