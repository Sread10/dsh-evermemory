/**
 * Loader hook that lets the tests import plugin source with no host and no network.
 *
 * The `@deepseek-ai/*` packages are supplied by the DSH host process at runtime and are not
 * installable from the registry at the installed runtime's version. Without a substitution
 * the test runner cannot load `src/config.ts` at all, because it imports schemastery for
 * real value — which would make the token-budget and merge-logic units untestable in CI.
 *
 * So this hook redirects a fixed set of bare specifiers to shims under `scripts/shims/`.
 * The substitution is deliberately narrow: only the packages in `packages.json` are
 * touched, and each needs a matching file here. A missing shim throws at load time with the
 * path it expected, rather than silently resolving to something else.
 *
 * Wired up by the `test` script and read by any direct `node --import` invocation.
 */

import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Bare specifier to shim module, relative to this file. */
const SHIMS = {
  '@deepseek-ai/cordis': './shims/cordis.mjs',
  '@deepseek-ai/dsh-llm': './shims/dsh-llm.mjs',
  '@deepseek-ai/dsh-settings': './shims/dsh-settings.mjs',
  '@deepseek-ai/dsh-system-prompt': './shims/dsh-system-prompt.mjs',
  '@deepseek-ai/dsh-tools': './shims/dsh-tools.mjs',
  '@deepseek-ai/schemastery': './shims/schemastery.mjs',
  react: './shims/react.mjs',
  'react/jsx-runtime': './shims/react-jsx-runtime.mjs',
}

/**
 * Specifiers imported as types only, which type stripping removes before the loader sees
 * them — so reaching the value-import guard below with one of these is impossible.
 */
const TYPE_ONLY = new Set(['@deepseek-ai/cordis'])

/**
 * Rewrite a `./x.js` specifier onto the `./x.ts` source that is actually on disk.
 *
 * Type stripping erases annotations but does not touch module specifiers, and this project
 * writes `.js` in imports because that is what the compiled output needs. Under tsc and
 * tsdown the rewrite is automatic; under bare `node --experimental-strip-types` it is not,
 * so the hook does it.
 *
 * Scoped to `src/` and `tests/` so nothing outside this package is affected.
 *
 * @param specifier - the import specifier.
 * @param parentURL - the importing module, when known.
 * @returns the rewritten specifier, or undefined to leave it alone.
 */
function toTypeScriptSource(specifier, parentURL) {
  if (parentURL === undefined || !specifier.startsWith('.') || !specifier.endsWith('.js')) return undefined
  if (!/\/(src|tests)\//.test(new URL(parentURL).pathname)) return undefined

  const candidate = new URL(specifier.slice(0, -3) + '.ts', parentURL)
  return existsSync(fileURLToPath(candidate)) ? candidate.href : undefined
}

registerHooks({
  /**
   * Map a plugin peer specifier onto its shim, and a `.js` import onto its `.ts` source.
   *
   * @param specifier - the import specifier.
   * @param context - resolution context, carrying the importing parent.
   * @param nextResolve - the default resolver, tried first so real packages still win.
   * @returns the resolved URL.
   */
  resolve(specifier, context, nextResolve) {
    const shim = SHIMS[specifier]
    if (shim !== undefined) {
      const url = new URL(shim, import.meta.url)
      if (!existsSync(fileURLToPath(url))) {
        throw new Error(`peer-hooks: no shim at ${fileURLToPath(url)} for "${specifier}"`)
      }
      // No `format` hint: supplying one makes Node skip its own TypeScript translation for
      // the target, which breaks `.ts` sources with no visible error beyond a parse failure.
      return { url: url.href, shortCircuit: true }
    }

    const source = toTypeScriptSource(specifier, context.parentURL)
    if (source !== undefined) return { url: source, shortCircuit: true }

    // A type-only import disappears under type stripping, so reaching this branch means a
    // value import of a DSH package nobody wrote a shim for. Say so plainly.
    if (specifier.startsWith('@deepseek-ai/') && !TYPE_ONLY.has(specifier)) {
      throw new Error(
        `peer-hooks: "${specifier}" is imported for value but has no shim. ` +
          `Add one to SHIMS in scripts/peer-hooks.mjs and a matching declaration under types/shims/.`,
      )
    }

    return nextResolve(specifier, context)
  },
})
