/**
 * Minimal stand-in for `@deepseek-ai/dsh-settings`.
 *
 * Referenced only for types today — the host half reaches settings through the exported
 * `Config` schema rather than a service call, because in 0.1.7 the Loader entry id *is* the
 * namespace and `SettingsForms` discovers the form itself.
 *
 * The service surface is declared because a later step reads the resolved document to
 * report what the deployment fixed versus what the user chose.
 */

/** One entry's settings descriptor, as `describe()` returns it. */
export interface SettingsDescriptor {
  readonly ns: string
  /** Whether the host auto-generated a form for this entry. */
  readonly autoGenerate: boolean
  /** Live resolved config. */
  readonly value: unknown
  /** What the layers below the profile supply. */
  readonly base: unknown
  /** The profile's own override layer. */
  readonly user: unknown
  readonly revision: number
  readonly writable: boolean
}

/** The service behind `ctx.settings`. */
export interface SettingsService {
  /** List descriptors for entries whose fiber is currently active. */
  describe(options?: object): readonly SettingsDescriptor[]

  /** Merge-patch one namespace; a stale revision throws with code `SETTINGS_CONFLICT`. */
  update(ns: string, patch: unknown, expectedRevision?: number): Promise<void>
}
