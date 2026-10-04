/**
 * Locale namespace for the browser half.
 *
 * Dictionaries are registered per language through `ctx.locale.register(ns, lang, dict)`,
 * which returns the disposer. `t` resolves by walking the active language's fallback
 * chain in this namespace, then the same chain in `common`, then finally displaying the
 * key itself — so a missing key degrades to a visible identifier rather than blank text.
 */
export const NS = 'dsh-evermemory'
