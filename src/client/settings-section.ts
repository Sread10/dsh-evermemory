/**
 * `settings.section` registration.
 *
 * The slot is a **list** scoped to `root`, declared by the settings shell
 * (`@deepseek-ai/dsh-client-ui-settings-general`), so a `list` entry must carry an `id`
 * or SlotCore throws `list slot "settings.section" requires options.id`. Entries sort by
 * `(priority, order)` and the settings navigation is built from them.
 *
 * Registration is wrapped in `slots.inject(...)` because a slot can only be filled once
 * some parent has declared it. The inject callback runs while the declaration is on the
 * ledger, is re-installed against each fresh declaration, and returns the disposer — so
 * this is correct regardless of whether the settings shell mounted before or after us.
 *
 * `order: 16` matches the one settings-slot value already established in the field
 * (`dsh-destinywind-memory`). It is a sort position among sections, unrelated to the
 * prompt section orders in constants.ts.
 *
 * `inject` is the business share. The framework hands an entry its five shares and nothing
 * else — there are no `state`, `value` or `onSave` props to fill in — so the page's three
 * dependencies travel through here, and each is resolved per registration rather than
 * captured at module load, which is what lets the page work when the connection service
 * arrives after the settings shell does.
 */

import { PLUGIN_NAME } from '../constants.js'
import { panelClient } from './api.js'
import { NS } from './locale.js'
import { MemoryPanelPage } from './page.js'
import { clientServices, optionalServices } from './services.js'

/** Position in the settings navigation. */
const SECTION_ORDER = 16

/**
 * Declare the "记忆与规则" section.
 *
 * @param ctx - the client plugin context.
 */
export function registerSection(ctx: unknown): void {
  const { slots, locale } = clientServices(ctx)

  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: PLUGIN_NAME,
        order: SECTION_ORDER,
        label: () => locale.bind(NS)('nav.title'),
        locale: NS,
        inject: () => {
          const optional = optionalServices(ctx)
          const connection = optional.connection
          return {
            t: locale.bind(NS),
            // The preferences form is keyed by the Host plugin entry id, which is this plugin's
            // own name — see the contract note in cordis.patch.yml.
            forms: optional.configForms?.get(PLUGIN_NAME),
            ...(connection === undefined ? {} : { panel: panelClient(connection) }),
          }
        },
      },
      MemoryPanelPage,
    ),
  )
}
