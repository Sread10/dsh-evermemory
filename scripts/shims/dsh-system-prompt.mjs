/**
 * Test shim for `@deepseek-ai/dsh-system-prompt`.
 *
 * The plugin imports this package as types only. Should a value import appear later, this
 * shim is where a realistic in-memory registry belongs — one that records sections and
 * contexts so a test can assert on rendered order and on the "only when the text changed"
 * behaviour that the token budget depends on.
 */

/** Package name, re-exported for parity with the real package's shape. */
export const name = '@deepseek-ai/dsh-system-prompt'

/** Prompt orders the plugin must not collide with, mirrored from the verified field map. */
export const RESERVED_ORDERS = Object.freeze({
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA_PREFIX: 0,
  TOOL_GUIDANCE: 100,
  DESTINYWIND_FULL_BANK: 216,
})
