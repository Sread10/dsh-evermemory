/**
 * Test shim for `@deepseek-ai/cordis`.
 *
 * The plugin imports this package as types only, so nothing here is exercised by normal
 * runs. It exists so the loader hook's contract holds — every entry in its SHIMS map
 * resolves to a real file — and so a future value import fails on a missing export rather
 * than on a missing module.
 */

/** Disposer label, re-exported for parity with the real package's shape. */
export const name = '@deepseek-ai/cordis'
