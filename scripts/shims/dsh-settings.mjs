/**
 * Test shim for `@deepseek-ai/dsh-settings`.
 *
 * The plugin imports this package as types only — the host half contributes its settings
 * form by exporting a `Config` schema, not by calling a service. This shim carries the
 * descriptor shape so a later step's tests can build fake `describe()` output and check how
 * the page distinguishes a deployment-fixed value from a user-chosen one.
 */

/** Error code the real service throws on a stale write. */
export const SETTINGS_CONFLICT = 'SETTINGS_CONFLICT'

/**
 * Build the descriptor shape the page consumes.
 *
 * @param ns - the namespace, which is the Loader entry id.
 * @param overrides - fields to override.
 * @returns a descriptor.
 */
export function fakeDescriptor(ns, overrides = {}) {
  return {
    ns,
    autoGenerate: true,
    value: {},
    base: {},
    user: {},
    revision: 1,
    writable: true,
    ...overrides,
  }
}
