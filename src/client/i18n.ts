/**
 * The translator contract, in one place.
 *
 * `locale.bind(ns)` returns a function that walks the active language's fallback chain and finally
 * shows the key itself, which is the behaviour worth relying on: a missing string is visible as
 * `mem.list.empty` in the page rather than as an empty element, and that is a fixable bug rather
 * than a silent one. The shell may also hand a page a translator through the slot's business share;
 * both are the same shape, and {@link translatorOf} picks whichever arrived.
 */

import { NS } from './locale.js'

/** A key-to-text function. */
export type Translator = (key: string) => string

/** Shows the key. Used when neither the shell nor the locale service provided a translator. */
export const identityTranslator: Translator = (key) => key

/**
 * Coerce a value from the framework into a translator.
 *
 * @param value - whatever arrived: a bound translator, a locale service, or nothing.
 * @returns a usable translator, never `undefined`, so components do not branch on it.
 */
export function translatorOf(value: unknown): Translator {
  if (typeof value === 'function') return value as Translator
  const bind = (value as { bind?: (ns: string) => unknown } | undefined)?.bind
  if (typeof bind === 'function') {
    const bound = bind.call(value, NS)
    if (typeof bound === 'function') return bound as Translator
  }
  return identityTranslator
}

/** The namespace, re-exported here so a caller needs one import rather than two. */
export { NS } from './locale.js'
