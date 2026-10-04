/**
 * The three pieces of state every panel needs, and nothing else.
 *
 * All three exist for the same reason: the page talks to a host that can be slow, refuse, or
 * disappear, so "what is on screen right now" has to be explicit rather than inferred from a
 * pending promise. A panel that rendered whatever the last response happened to leave in a
 * variable would show stale rows after a failed write with no way to tell.
 *
 *  - `useRemote` owns one read: its four states, its cancellation on unmount, and a reload.
 *  - `useFormSnapshot` mirrors the shared preferences controller.
 *  - `useAction` owns one write: its pending flag, its message, and the reload that follows it.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type { RemoteResult } from './services.js'
import type { ConfigFormController, ConfigFormSnapshot } from './services.js'

/** A read's four states. */
export type Loadable<T> =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'failed'; readonly message: string }

/** What `useRemote` returns. */
export interface RemoteState<T> {
  readonly loadable: Loadable<T>
  /** Re-run the read. Stable across renders. */
  readonly reload: () => void
}

/**
 * Run one host read and track its state.
 *
 * @param enabled - when false the read is skipped entirely and the state is `idle`; used by panels
 *   that are not on screen.
 * @param load - the call. Re-created every render, but only ever invoked through a ref, so an
 *   inline arrow does not re-trigger the effect.
 * @param deps - what the read depends on: changing any value re-runs it.
 * @returns the state and a reload callback.
 */
export function useRemote<T>(
  enabled: boolean,
  load: () => Promise<RemoteResult<T>>,
  deps: readonly unknown[],
): RemoteState<T> {
  const [tick, setTick] = useState(0)
  const [loadable, setLoadable] = useState<Loadable<T>>({ state: 'idle' })
  const latest = useRef(load)
  latest.current = load

  useEffect(() => {
    if (!enabled) {
      setLoadable({ state: 'idle' })
      return
    }
    let cancelled = false
    setLoadable({ state: 'loading' })
    void latest.current().then((result) => {
      if (cancelled) return
      setLoadable(result.ok ? { state: 'ready', value: result.value } : { state: 'failed', message: result.error.message })
    })
    return () => {
      cancelled = true
    }
    // `deps` is spread on purpose: callers list the request fields, and the array is rebuilt each
    // render, so React's dependency comparison is what decides whether to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tick, ...deps])

  return useMemo(() => ({ loadable, reload: () => setTick((value) => value + 1) }), [loadable])
}

/**
 * Mirror the shared preferences controller.
 *
 * @param controller - the form, when the host serves it.
 * @returns the current snapshot, or `undefined` when there is no form at all.
 */
export function useFormSnapshot(controller: ConfigFormController | undefined): ConfigFormSnapshot | undefined {
  const [snapshot, setSnapshot] = useState<ConfigFormSnapshot | undefined>(() => controller?.getSnapshot())

  useEffect(() => {
    if (controller === undefined) {
      setSnapshot(undefined)
      return
    }
    setSnapshot(controller.getSnapshot())
    return controller.subscribe(() => setSnapshot(controller.getSnapshot()))
  }, [controller])

  return snapshot
}

/** What `useAction` returns. */
export interface ActionState {
  /** A write is in flight. */
  readonly busy: boolean
  /** Last message, when there is one. */
  readonly message: string | undefined
  /** How to render {@link ActionState.message}. */
  readonly tone: 'info' | 'danger'
  /**
   * Run one write.
   *
   * @param task - the call.
   * @param done - called with the value after a successful result, for the reload that follows a
   *   write and for whatever the answer said (a merge decision, a receipt).
   * @param ok - message to show on success.
   */
  readonly run: <T>(task: () => Promise<RemoteResult<T>>, done?: ((value: T) => void) | undefined, ok?: string | undefined) => void
  /** Show a message without a write. */
  readonly say: (message: string, tone?: 'info' | 'danger') => void
  /** Clear the message. */
  readonly clear: () => void
}

/**
 * Track one write.
 *
 * @returns the state and the runner.
 */
export function useAction(): ActionState {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [tone, setTone] = useState<'info' | 'danger'>('info')

  return {
    busy,
    message,
    tone,
    say: (next, nextTone = 'info') => {
      setMessage(next)
      setTone(nextTone)
    },
    clear: () => setMessage(undefined),
    run: (task, done, ok) => {
      setBusy(true)
      setMessage(undefined)
      void task().then((result) => {
        setBusy(false)
        if (!result.ok) {
          setTone('danger')
          setMessage(result.error.message)
          return
        }
        if (ok !== undefined) {
          setTone('info')
          setMessage(ok)
        }
        done?.(result.value)
      })
    },
  }
}
