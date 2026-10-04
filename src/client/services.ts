/**
 * The slice of the client service surface this plugin touches.
 *
 * Declared structurally instead of augmenting `@deepseek-ai/cordis`: the framework's own
 * context typings are not part of the third-party contract, and a hand-written structural
 * type fails at the call site (where the reader can check it) rather than at the import
 * (where the failure is an arcane module-resolution error).
 *
 * The two services are obtained by name through `ctx.get(...)`, because a client plugin's
 * own `inject` array only orders activation — it does not put the services on the typed
 * context.
 */

import type { ComponentType } from 'react'

/** One clickable action, as the client's slot registry expects it. */
export interface SlotEntry {
  readonly options: {
    readonly id?: string
    readonly order?: number
    readonly priority?: number
    readonly label?: string | (() => string)
  }
}

/** The client slot registry. */
export interface SlotsService {
  /**
   * Run `body` once the named slot is declared, and again on every fresh declaration.
   *
   * @param slot - the slot key, e.g. `'settings.section'`.
   * @param body - installs the entry; returns its disposer.
   */
  inject(slot: string, body: () => () => void): void

  /**
   * Register an entry against a declared slot.
   *
   * @param options - must carry `name` equal to the slot key, plus `id` for a list slot.
   * @param component - the React component rendered for the entry. Its props are the framework's
   *   five shares plus whatever {@link SlotRegistration.inject} returns, which is why the component
   *   type is the caller's to choose.
   * @returns the disposer.
   */
  register<P extends Record<string, unknown>>(
    options: SlotRegistration,
    component: ComponentType<P>,
  ): () => void

  /** Entries currently registered against a slot, for building navigation. */
  entries(slot: string): readonly SlotEntry[]
}

/** Options accepted by {@link SlotsService.register}. */
export interface SlotRegistration {
  readonly name: string
  readonly id?: string
  readonly order?: number
  readonly priority?: number
  readonly label?: string | (() => string)
  readonly locale?: string
  /**
   * The business share: values the framework hands the component as props.
   *
   * Called per registration, so services that mount late are still reachable.
   */
  readonly inject?: () => Record<string, unknown>
}

/** The client locale registry. */
export interface LocaleService {
  /**
   * Register one language's dictionary under a namespace.
   *
   * @param ns - the namespace, e.g. `'dsh-evermemory'`.
   * @param locale - a BCP 47-style language tag, e.g. `'zh'`.
   * @param dict - key to text.
   * @returns the disposer.
   */
  register(ns: string, locale: string, dict: Record<string, string>): () => void

  /**
   * Bind a namespace to a translator.
   *
   * @param ns - the namespace.
   * @returns `t(key)`, falling back through the language chain, then `common`, then the key.
   */
  bind(ns: string): (key: string) => string
}

/** The two services, as resolved from the client context. */
export interface ClientServices {
  readonly slots: SlotsService
  readonly locale: LocaleService
}

/** A failure reported by the Host, in the connection's own shape. */
export interface RemoteFailure {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

/**
 * What one remote call resolves to.
 *
 * A carrier problem and a business failure are deliberately different things: a transport failure
 * rejects, while a refusal from the Host resolves with `ok: false`. Panel code therefore reads
 * `ok` instead of wrapping every call in `try`/`catch`, and only the truly unreachable host needs
 * the catch.
 */
export type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RemoteFailure }

/** Narrow a remote result to its failure branch. */
export function isRemoteFailure<T>(result: RemoteResult<T>): result is { readonly ok: false; readonly error: RemoteFailure } {
  return !result.ok
}

/** The browser side of the connection service: how a plugin calls the Host. */
export interface ConnectionService {
  readonly rpc: {
    /**
     * Call one endpoint of a channel.
     *
     * @param channel - the registered channel, e.g. `/dsh-evermemory`.
     * @param endpoint - the method name, which is also the last path segment.
     * @param payload - JSON-serialisable request body.
     * @param signal - optional abort signal.
     * @returns the Host's answer, never a rejection for a business failure.
     */
    call<T>(channel: string, endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<RemoteResult<T>>
  }
}

/** One accepted value and the write queue for a Host plugin entry's preferences. */
export interface ConfigFormController {
  /** Current state. `value` is the resolved configuration, `user` only what the user overrode. */
  getSnapshot(): ConfigFormSnapshot
  /** Observe snapshot changes. */
  subscribe(listener: () => void): () => void
  /** Write one field. Resolves `false` when the Host refused it. */
  set(field: string, value: unknown): Promise<boolean>
  /** Remove one override, restoring inheritance. */
  unset(field: string): Promise<boolean>
}

/** One look at a Host entry's preferences. */
export interface ConfigFormSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value?: Readonly<Record<string, unknown>>
  readonly base?: Readonly<Record<string, unknown>>
  readonly user?: Readonly<Record<string, unknown>>
  readonly revision?: number
  readonly writable: boolean
  readonly mode: 'host' | 'memory'
}

/** The preferences service, keyed by Host plugin entry id. */
export interface ConfigFormsService {
  /**
   * The shared form for one Host entry.
   *
   * @param entryId - the Host plugin entry id, which is this plugin's `PLUGIN_NAME`.
   */
  get(entryId: string): ConfigFormController
}

/** Services that a page can live without. */
export interface OptionalServices {
  readonly connection: ConnectionService | undefined
  readonly configForms: ConfigFormsService | undefined
}

/**
 * Resolve the services this plugin needs.
 *
 * @param ctx - the client plugin context.
 * @returns both services.
 * @throws when either is missing, which means `inject` was not honoured and the section
 *   would otherwise fail later with a less obvious error.
 */
export function clientServices(ctx: unknown): ClientServices {
  const get = (ctx as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') {
    throw new Error('dsh-evermemory: client context has no get() — cannot reach slots/locale')
  }

  const slots = get.call(ctx, 'slots') as SlotsService | undefined
  const locale = get.call(ctx, 'locale') as LocaleService | undefined

  if (slots === undefined) throw new Error('dsh-evermemory: client service "slots" is unavailable')
  if (locale === undefined) throw new Error('dsh-evermemory: client service "locale" is unavailable')

  return { slots, locale }
}

/**
 * Resolve the services a page uses when they are there.
 *
 * `connection` is what carries panel data and `configForms` is what carries the preferences. A
 * deployment can lack either — a page opened without the connection service cannot reach the Host
 * at all, and the preferences service is not composed in every profile — so both are returned as
 * possibly-undefined and the page degrades to a message instead of throwing during registration.
 *
 * @param ctx - the client plugin context.
 * @returns whichever of the two services are mounted.
 */
export function optionalServices(ctx: unknown): OptionalServices {
  const get = (ctx as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return { connection: undefined, configForms: undefined }
  return {
    connection: get.call(ctx, 'connection') as ConnectionService | undefined,
    configForms: get.call(ctx, 'configForms') as ConfigFormsService | undefined,
  }
}
