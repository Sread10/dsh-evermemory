/**
 * Structural reading of values this plugin receives from the host.
 *
 * The host hands listeners plain objects whose types this plugin does not import — the real
 * `SessionEventMap`, `PreStepDecision` and friends live inside the host's own build. Reading a
 * field by name, with a check, keeps the plugin working across host versions where a type import
 * would have been a compile error against an API that had merely moved.
 */

/** Own enumerable keys of a value, or `[]` for anything that is not a plain object. */
export function keysOf(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.keys(value)
}

/** Read a string field, or `undefined` when it is absent or not a string. */
export function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}

/** Read a number field, or `undefined` when it is absent or not a number. */
export function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'number' ? field : undefined
}
