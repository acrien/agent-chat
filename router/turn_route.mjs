/**
 * turn_route.mjs — the one place a turn's provider-facing configuration is
 * decided, and the only thing `server.mjs` needs to ask.
 *
 * THERE IS NO NULL VERDICT. That is the whole design. The file this replaces
 * returned `null` for a first-party model, meaning "no environment needed",
 * and the spawn path read null as "inherit whatever is ambient" — which, on a
 * server that had loaded a gateway into its own `process.env`, meant opus was
 * served by qwen's rate limiter (measured 2026-08-11, `[session] model=opus[1m]`
 * followed by `rate_limit`). Every route returned here carries a COMPLETE
 * environment, first-party included. "Inherit whatever is there" stops being
 * something this system can express.
 *
 * A DROPPED OPTION IS REPORTED, NEVER SILENT. `dropped[]` says what was asked
 * for, that it was not sent, and why. An effort a gateway would reject is not
 * sent — the old code got that right — but it also said nothing, so the menu
 * and the turn disagreed with no witness. Three kinds of silence are now the
 * same visible state: unsupported, unverified, and out of range.
 */
import { providers, FIRST_PARTY } from './provider_registry.mjs';
import { baseEnv, ambientRouting } from './ambient_env.mjs';
import { capabilitiesFor, goldenRecordFor, goldenModels, TURNS_FOR_EFFORT } from './capability_table.mjs';

/**
 * The complete verdict for one turn.
 *
 * @param model    the selected model name, or null for the provider default
 * @param effort   a level the user picked, or null
 * @param thinking 'adaptive' | 'disabled' | null — the per-model switch
 * @param cache    true/false to force prompt caching on or off, null to leave
 *                 the provider's own default in place
 * @param maxTurns an explicit ceiling; otherwise derived from effort for a
 *                 provider that has no effort ladder of its own
 */
export function routeTurn({
  model = null, effort = null, thinking = null, cache = null,
  maxTurns = null, source = process.env,
} = {}) {
  const record = goldenRecordFor(model);
  const name = record?.provider ?? FIRST_PARTY;
  const provider = providers().get(name) ?? {
    name, transport: 'anthropic_gateway', reachable: false,
    missing: `no provider named ${name} is declared`, env: {}, source: null,
  };
  const caps = capabilitiesFor(name, record);
  const dropped = [];
  const options = {};

  // THE ENVIRONMENT: subtract everything the router owns, then add back only
  // what this route declares. Nothing reaches the child by inheritance.
  const env = { ...baseEnv(source), ...provider.env };

  // ONE OWNER FOR THE CONTEXT WINDOW — and it is the largest single number in
  // the bill. 80.6% of the qwen era's 85M tokens was context re-read; the
  // window is the multiplier on every one of a prompt's internal turns.
  if (caps.contextTokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(caps.contextTokens);

  // CACHING IS AN ENV LEVER, NOT A QUERY OPTION. The SDK exposes no per-request
  // cache control — the CLI places its own cache_control breakpoints — so the
  // only switch is DISABLE_PROMPT_CACHING, which makes it exactly the kind of
  // ambient variable this router exists to own rather than inherit.
  const cacheable = caps.promptCache.supported;
  if (cache === false || (cache === true && !cacheable) || (cache === null && !cacheable)) {
    env.DISABLE_PROMPT_CACHING = '1';
  }
  if (cache === true && !cacheable) {
    dropped.push({
      what: 'promptCache', asked: true,
      why: caps.promptCache.verified
        ? `${name} does not serve prompt caching`
        : `${name}'s prompt caching has never been probed — unverified, so not relied on`,
    });
  }

  // EFFORT: sent only where the provider declares levels, and only a level it
  // declares. Anything else would send a parameter the gateway rejects, and the
  // failure would arrive as a dead turn rather than as a bad menu.
  if (effort) {
    if (!caps.effort.levels.length) {
      dropped.push({ what: 'effort', asked: effort, why: `${name} has no effort levels — ${caps.effort.note}` });
    } else if (!caps.effort.levels.includes(effort)) {
      dropped.push({ what: 'effort', asked: effort, why: `${name} declares only ${caps.effort.levels.join(', ')}` });
    } else {
      options.effort = effort;
    }
  }

  // THINKING: one switch, per model, honoured in the Anthropic form by both
  // providers that have been probed for it. A provider whose form is unknown
  // gets nothing rather than a guess.
  if (thinking) {
    if (caps.thinking.form === 'anthropic') {
      options.thinking = thinking === 'disabled' ? { type: 'disabled' } : { type: 'adaptive' };
    } else {
      dropped.push({ what: 'thinking', asked: thinking, why: `${name}'s thinking form is ${caps.thinking.form} — ${caps.thinking.note}` });
    }
  }

  // THE TURN CEILING IS THE EFFORT-EQUIVALENT. Where the provider has no effort
  // ladder, the level the user picked still has to mean something; turns are
  // what the spend actually scales with, so that is what it means here.
  const derived = effort && !caps.effort.levels.length ? TURNS_FOR_EFFORT[effort] ?? null : null;
  const ceiling = maxTurns ?? derived;
  if (ceiling && caps.budget.maxTurns) options.maxTurns = ceiling;

  return {
    model: model || null,
    provider: name,
    transport: provider.transport,
    reachable: provider.reachable,
    missing: provider.missing,
    credentialSource: provider.source,
    env,
    options,
    capabilities: caps,
    dropped,
    // What the ambient environment was carrying that this route refused to
    // inherit — a person's intent the router is declining, so it is said aloud.
    ambient: ambientRouting(source),
  };
}

/**
 * The model menu, derived from the same verdict the spawn path reads.
 *
 * Reachability is DEFINED as "the route has a credential", so the menu cannot
 * drift from the routing the first time a provider changes. That invariant is
 * the one thing the file this replaces got right, and it only covered gateway
 * models; the first-party half was assumed reachable and never checked.
 */
export function menu({ sdkModels = [] } = {}) {
  const gateway = goldenModels().map((m) => {
    const route = routeTurn({ model: m.value });
    return {
      value: m.value,
      provider: route.provider,
      displayName: route.reachable ? (m.displayName ?? m.value) : `${m.displayName ?? m.value}  (no key)`,
      description: m.description ?? '',
      reachable: route.reachable,
      missing: route.missing,
      capabilities: route.capabilities,
    };
  });
  const first = sdkModels.map((m) => {
    const route = routeTurn({ model: m.value });
    return {
      value: m.value,
      provider: FIRST_PARTY,
      displayName: m.displayName ?? m.value,
      description: m.description ?? '',
      reachable: route.reachable,
      missing: route.missing,
      // The SDK reports these per model; the golden record spells them the same
      // way by hand. Same shape, two sources, one menu.
      capabilities: {
        ...route.capabilities,
        effort: {
          ...route.capabilities.effort,
          levels: Array.isArray(m.supportedEffortLevels)
            ? m.supportedEffortLevels
            : route.capabilities.effort.levels,
        },
      },
    };
  });
  return [...first, ...gateway];
}
