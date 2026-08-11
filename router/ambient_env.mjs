/**
 * ambient_env.mjs — the environment a turn starts from, with nothing inherited
 * that anyone could have meant as routing.
 *
 * WHAT WENT WRONG WITHOUT IT. `server.mjs` read provider.env into its own
 * `process.env` at startup, and the pod was handed the same variables by
 * `podman --env-file`. Both are ambient: nothing declared them for any
 * particular turn, and every turn that declared no environment of its own got
 * them anyway. Selecting opus on a machine whose server had loaded a qwen
 * gateway sent opus to qwen — no error, just a rate limit belonging to another
 * account (measured 2026-08-11).
 *
 * SO THE BASE IS SUBTRACTIVE. Everything the router owns is removed first, and
 * a route adds back exactly what it declares. The removal list is DERIVED FROM
 * THE REGISTRY, not written out again here, so a variable a new provider
 * introduces cannot be the one nobody remembered to strip.
 *
 * `routing.mjs` already did this for one variable — it deleted
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS before setting it from the golden record,
 * because the author's own shell carried one. That reasoning was right and its
 * scope was one line long; this file is the same argument applied to all of it.
 */
import { declaredVars } from './provider_registry.mjs';

/**
 * A complete child environment with every router-owned variable removed.
 *
 * COMPLETE, NOT A PATCH. The SDK passes `options.env` to the child verbatim —
 * a provided env REPLACES `{...process.env}` rather than merging with it — so
 * a partial env spawns a CLI with no PATH and no HOME.
 */
export function baseEnv(source = process.env) {
  const owned = declaredVars();
  const out = {};
  for (const [k, v] of Object.entries(source)) if (!owned.has(k)) out[k] = v;
  return out;
}

/**
 * Which router-owned variables the ambient environment was carrying.
 *
 * REPORTED, NOT ONLY REMOVED. A stripped variable is a person's intent that
 * this process is declining to honour — the shell export, the service file,
 * the `--env-file`. Silently dropping it would be the same shape as silently
 * inheriting it: a decision with no witness. The page shows this, so "the
 * server is ignoring the gateway I exported" is a visible state.
 */
export function ambientRouting(source = process.env) {
  const owned = declaredVars();
  return Object.keys(source).filter((k) => owned.has(k)).sort();
}
