/**
 * capability_table.mjs — WHAT each provider can actually be asked for.
 *
 * WHY THIS IS A TABLE AND NOT A BRANCH. `server.mjs` already carried three of
 * these rules, in three places, in three shapes: effort suppressed at spawn
 * (`takesEffort`), effort re-checked on the HTTP path, and the thinking form
 * settled by a measurement recorded in a comment. Each was right. None of them
 * could see the others, and only effort had the "declared absent" idea at all —
 * so the next capability added would have been the next silent failure.
 *
 * AN UNVERIFIED CAPABILITY IS NOT AN ABSENT ONE. This is the distinction the
 * enforcement layer next door exists to make: "could not observe" consumed as
 * "nothing there" is the shape that recurs 9+ times across its own reviews. A
 * capability nobody has probed is marked `unverified` — the router declines to
 * send it, exactly as if it were absent, and says WHY it declined so the state
 * is visible rather than looking like a settled fact.
 *
 * THE FIRST-PARTY HALF IS NOT WRITTEN HERE. The SDK already reports
 * `supportsEffort`, `supportedEffortLevels`, and `supportsAdaptiveThinking` per
 * model; the golden record carries the same field names by hand for gateway
 * models. The two were shaped to merge and nothing had merged them. This does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIRST_PARTY } from './provider_registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, '..', 'models.golden.json');

/**
 * THE GOLDEN RECORD IS THE MODEL LIST. Read, never written — rainsmoke3's
 * golden gate refuses a write that drops an entry, because RM2 kept deleting
 * Kimi and qwen and the owner had to re-add them by hand at exactly the moment
 * they were out of quota and least able to spend the time.
 */
export function readGolden() {
  try { return JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); }
  catch { return { models: [] }; }
}

/**
 * Per-provider capabilities. Every field is either measured or marked unverified.
 *
 * `effort.levels` empty means the provider has no effort concept at all and the
 * parameter must not be sent — THE OWNER, 2026-08-11: "each llm has their own
 * effort keyword (qwen has no effort level at all)".
 */
/**
 * THE EFFORT-EQUIVALENT LEVER, and why it is not a reply-length cap.
 *
 * MEASURED 2026-08-11 from this user's own transcript, the qwen era (25
 * prompts, 08-10 13:48 onward, 85,271,129 tokens):
 *
 *     cache READ    68,723,722   80.6%
 *     fresh input   11,692,198   13.7%
 *     cache write    4,280,257    5.0%
 *     output            574,952    0.7%   <- the whole of the reply
 *
 * Four prompts accounted for 50,875,419 of it (60%), and the worst ran 110
 * internal agent turns. Spend is CONTEXT RE-READ x TURN COUNT: every internal
 * turn resends the accumulated conversation, and nothing compacts it until
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS. At the 1,000,000 the gateway file set, the
 * worst prompt was re-reading ~330k tokens per turn, 51 turns deep.
 *
 * So a reply-length cap would govern 0.7% of the bill. The levers that bite:
 *
 *   maxTurns      client-side, hard, and provider-agnostic — it is the one
 *                 ceiling that works identically on a gateway with no effort
 *                 concept. This is the effort-equivalent.
 *   contextTokens the multiplier on every turn. Lower it and compaction caps
 *                 the re-read; raise it and each turn costs more than the last.
 *   maxBudgetUsd  UNUSABLE on a gateway: the CLI prices by its own table, and
 *                 this transcript's qwen turns were billed at Anthropic rates
 *                 ($2,911 of imaginary money). A ceiling computed from a wrong
 *                 price is a ceiling that fires at the wrong time.
 *   taskBudget    Anthropic-side (`output_config.task_budget`, its own beta
 *                 header). Unverified against these gateways, so unsent.
 */
export const PROVIDER_CAPABILITIES = Object.freeze({
  [FIRST_PARTY]: {
    effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: true,
      note: 'reported per model by the SDK; the list here is the superset' },
    // THINKING AND EFFORT ARE COUPLED HERE, AND NOTHING ELSE SAYS SO.
    // MEASURED 2026-08-11, from a real turn on this site:
    //
    //   API Error: 400 output_config.effort 'xhigh' is not supported when
    //   thinking is disabled on this model. Use effort 'high' or below, or
    //   enable thinking.
    //
    // Claude Opus 5 accepts thinking:{type:'disabled'} only at effort `high`
    // or below. Neither the SDK's `supportedModels()` nor the golden record
    // can express a constraint BETWEEN two fields — they describe each field
    // alone — so a table that models capabilities as independent axes will
    // keep producing valid-looking invalid combinations.
    thinking: {
      form: 'anthropic',
      verified: true,
      disabledMaxEffort: 'high',
      note: "Claude Opus 5 rejects thinking:{disabled} above effort 'high'",
    },
    promptCache: {
      supported: true, verified: true, ttlSeconds: 300, explicitCreate: false,
      note: 'the CLI places its own cache_control breakpoints; 1h TTL exists but the SDK does not expose the choice',
    },
    budget: { maxTurns: true, taskBudget: true, maxBudgetUsd: true, verified: true },
  },
  qwen: {
    budget: {
      maxTurns: true,
      // Priced by the CLI's own table, which does not know this gateway.
      maxBudgetUsd: false,
      taskBudget: false,
      verified: true,
      note: 'maxTurns is the effort-equivalent here; see the measurement above',
    },
    // The gateway rejects a parameter it does not know and the turn comes back
    // dead — which reads as a model failure rather than a menu that offered
    // something that was never there.
    effort: { levels: [], verified: true,
      note: 'the owner states qwen has no effort level at all' },
    thinking: { form: 'anthropic', verified: true,
      note: 'probed against the Alibaba gateway 2026-08-10: thinking:{type:"disabled"} suppresses the blocks; qwen\'s own enable_thinking:false is ignored there' },
    promptCache: {
      supported: true, verified: true, ttlSeconds: 300, explicitCreate: true,
      note: 'the owner states a cache is created explicitly, lives 5 minutes, and reads at about 1/3 the price of a miss',
    },
  },
  moonshot: {
    effort: { levels: [], verified: false, note: 'never probed' },
    thinking: { form: 'none', verified: false, note: 'never probed' },
    promptCache: { supported: false, verified: false, note: 'never probed' },
    budget: { maxTurns: true, maxBudgetUsd: false, taskBudget: false, verified: false,
      note: 'maxTurns is client-side, so it holds without probing the gateway' },
  },
});

/** A provider nobody has described yet: send nothing, and say that is why. */
const UNKNOWN_PROVIDER = Object.freeze({
  effort: { levels: [], verified: false, note: 'this provider has no capability entry' },
  thinking: { form: 'none', verified: false, note: 'this provider has no capability entry' },
  promptCache: { supported: false, verified: false, note: 'this provider has no capability entry' },
  budget: { maxTurns: true, maxBudgetUsd: false, taskBudget: false, verified: false,
    note: 'maxTurns is enforced by the CLI, not the provider, so it needs no entry' },
});

/**
 * What an effort level MEANS to a provider that has no effort ladder.
 *
 * THE OWNER, 2026-08-11: "we MIGHT need to give it reply in X tokens where X
 * commensurate with effort level of other models." The instinct is right — a
 * budget lever is needed — but the measurement above puts the reply at 0.7% of
 * spend, so the ceiling is drawn around TURNS, which is what the other 99.3%
 * scales with. `max` deliberately has no ceiling: it is the level that means
 * "spend what it takes", and a ceiling nobody chose is the failure this whole
 * layer exists to stop.
 */
export const TURNS_FOR_EFFORT = Object.freeze({
  low: 8, medium: 20, high: 50, xhigh: 100, max: null,
});

/** Weakest to strongest, so a cap can be compared rather than special-cased. */
export const EFFORT_ORDER = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The capabilities in force for one model, provider defaults narrowed by the
 * model's own record.
 *
 * THE MODEL NARROWS, IT NEVER WIDENS. A record may say this model takes fewer
 * effort levels than its provider; it may not claim one the provider has not
 * been shown to serve. The widening direction is how a menu comes to offer
 * something the gateway rejects.
 */
export function capabilitiesFor(providerName, record = null) {
  const base = PROVIDER_CAPABILITIES[providerName] ?? UNKNOWN_PROVIDER;
  const declared = Array.isArray(record?.supportedEffortLevels) ? record.supportedEffortLevels : null;
  const levels = declared === null
    ? base.effort.levels
    : declared.filter((l) => base.effort.levels.includes(l));
  return {
    provider: providerName,
    effort: { ...base.effort, levels },
    thinking: { ...base.thinking },
    promptCache: { ...base.promptCache },
    budget: { ...base.budget },
    // ONE OWNER FOR THE WINDOW. The CLI does not recognise a gateway model and
    // falls back to assuming 200k, then auto-compacts — a 1M model silently
    // losing 800k. Read from the record here so the menu and the spawn path
    // cannot disagree, and never from whatever was in the environment.
    contextTokens: record?.contextTokens ?? null,
  };
}

/** The gateway half of the model list: golden-record entries, still-live only. */
export function goldenModels() {
  return (readGolden().models ?? []).filter((m) => !m.retired);
}

/** The golden record's entry for one model name, or null if it is first-party. */
export function goldenRecordFor(model) {
  if (!model) return null;
  return goldenModels().find((m) => m.value === model) ?? null;
}
