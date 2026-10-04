/**
 * Browser half of dsh-evermemory.
 *
 * Loaded by the DSH client module system as the package's `./client` export, wrapped in
 * `window.__ModuleLoader__.load({ id, factory })` by scripts/bundle-client.mjs. The
 * factory's `require` resolves only against the framework's fixed module table — `react`,
 * `@deepseek-ai/cordis`, and a handful of client packages. Nothing else is importable.
 *
 * Which is why this half deliberately imports almost nothing. The DSH client UI
 * primitives exist and work, but the official cordis-plugin-development skill is explicit
 * that a plugin should not depend on them: they change without notice, a plain-JS plugin
 * gets no type check, and a component that throws blanks its slot entry with only a
 * console line (`slot entry crashed in '<slot>'`). So the controls are hand-rolled against
 * `--dsw-*` tokens, with markup and behaviour copied from the primitives — that keeps the
 * visual result native while the only shared dependency is the token set.
 *
 * Theme following is free: dark mode is `body[data-ds-dark-theme]` redefining the same
 * custom properties, so no JavaScript here reads or branches on the theme.
 */

import type { Context } from '@deepseek-ai/cordis'

import { PLUGIN_NAME } from '../constants.js'
import { EN, ZH } from './dict.js'
import { NS } from './locale.js'
import { clientServices } from './services.js'
import { registerSection } from './settings-section.js'

/**
 * Client plugins this one wants active first.
 *
 * These order activation only; they grant no module access. `dsh.client.inject` in
 * package.json carries the same list for the Host's composition step. `connection` and
 * `configForms` are deliberately absent: both are read through `ctx.get` and both are
 * allowed to be missing, because a Host without them still has rules and memory.
 */
export const inject = ['slots', 'locale']

/**
 * Mount the browser half.
 *
 * @param ctx - the client plugin context.
 */
export function apply(ctx: Context): void {
  const { locale } = clientServices(ctx)

  // Both registrations are effects, so a reload or unload removes the section and the
  // dictionaries together rather than stacking duplicates.
  ctx.effect(() => locale.register(NS, 'zh', ZH), `${PLUGIN_NAME}: zh dictionary`)
  ctx.effect(() => locale.register(NS, 'en', EN), `${PLUGIN_NAME}: en dictionary`)

  registerSection(ctx)
}
