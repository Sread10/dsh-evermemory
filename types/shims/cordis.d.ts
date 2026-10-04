/**
 * Minimal stand-in for `@deepseek-ai/cordis`.
 *
 * The real package is injected by the DSH host process. On the npm registry it exists but
 * at versions older than the installed runtime, so pinning it as a devDependency would
 * type-check this plugin against an API surface it will never run against — worse than not
 * type-checking it at all.
 *
 * So this shallow declaration supplies exactly what the plugin touches, and
 * `scripts/peer-hooks.mjs` serves the matching runtime object to the test loader. Neither
 * reaches the published artifact: the build treats every `@deepseek-ai/*` specifier as
 * external, so the host resolves the real thing.
 *
 * Consumed as `import type { Context } from '@deepseek-ai/cordis'`.
 */

/** Disposer returned by every registration; each registration is a Cordis effect. */
export type Disposer = () => void

/** A plugin context. Services are reached by name through `get()`. */
export interface Context {
  /** Register a cleanup callback, run when the plugin unloads. */
  effect(callback: () => Disposer | void, label: string): Disposer

  /**
   * Run `body` once a service is available, optionally injecting it.
   *
   * @param names - service names to wait for.
   * @param body - receives a context that definitely carries those services.
   */
  inject(names: string[], body: (ctx: Context) => void): void

  /** Emit an event. */
  emit(name: string, payload: unknown): void

  /** Read a service, or `undefined` when it is not mounted. */
  get(name: string): unknown

  /** Subscribe to an event; returns the disposer. */
  on(name: string, listener: (...args: never[]) => unknown, options?: object): Disposer

  /** The Cordis Loader, for reading companion entries. */
  loader?: { entries(): readonly { options: { id?: string; name?: string; disabled?: boolean } }[] }
}
