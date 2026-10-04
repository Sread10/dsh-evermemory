/**
 * The settings page: one entry in the Host's settings navigation.
 *
 * What the shell gives a slot entry is fixed and small — a translator, the entry's own value and
 * state, and whatever this plugin declared in `inject` — so this component asks for exactly three
 * things and degrades instead of throwing when any of them is missing:
 *
 *  - `panel`, the data client. Without a connection service there is no panel data at all, and the
 *    page says so rather than rendering empty tables.
 *  - `forms`, the preferences controller for this plugin's own Config. Without the preferences
 *    service the preferences tab explains which service is missing; the data tabs still work.
 *  - `t`, the translator. Without one, keys show through, which is a bug a user can report rather
 *    than a blank page.
 *
 * The page is deliberately one component tree with tabs instead of five registered sections. The
 * settings shell owns navigation between *plugins*, and a plugin that added five entries for its own
 * views would be five times as noisy in a list its user reads to find something else.
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { PLUGIN_NAME } from '../constants.js'
import { VERSION } from '../version.js'
import { DailyPanel } from './panels/daily.js'
import { DataPanel } from './panels/data.js'
import { MemoriesPanel } from './panels/memories.js'
import { PreferencesPanel } from './panels/preferences.js'
import { RememberPanel } from './panels/remember.js'
import { Banner, Chip, Tabs } from './ui.js'
import { useRemote } from './hooks.js'
import { translatorOf } from './i18n.js'
import type { Translator } from './i18n.js'
import type { PanelClient } from './api.js'
import type { ConfigFormController } from './services.js'

/** The tabs, in the order a user meets them. */
const TABS: readonly { readonly id: string; readonly key: string }[] = [
  { id: 'pref', key: 'tab.pref' },
  { id: 'mem', key: 'tab.mem' },
  { id: 'add', key: 'tab.add' },
  { id: 'daily', key: 'tab.daily' },
  { id: 'data', key: 'tab.data' },
]

/** What the slot's business share supplies. */
export interface PageProps {
  /** Bound translator for this plugin's namespace, when the locale service is there. */
  readonly t?: Translator | undefined
  /** The data client, built from the connection service by `settings-section.ts`. */
  readonly panel?: PanelClient | undefined
  /** This plugin's preferences form. */
  readonly forms?: ConfigFormController | undefined
  /** The slot framework's own props, which this page tolerates but does not read. */
  readonly [key: string]: unknown
}

/**
 * Render the page.
 *
 * @param props - the business share declared in `inject`, plus the framework's props.
 * @returns the page.
 */
export function MemoryPanelPage(props: PageProps): ReactElement {
  const t = props.t ?? translatorOf(undefined)
  const panel = props.panel

  return (
    <div className="evm-page">
      <div className="evm-page-head">
        <h2 className="evm-page-title">{t('page.title')}</h2>
        <p className="evm-page-subtitle">{t('page.subtitle')}</p>
        <div className="evm-chips">
          <Chip tone="muted">
            {PLUGIN_NAME} {VERSION}
          </Chip>
        </div>
      </div>
      {panel === undefined ? <Banner kind="danger">{t('page.no-connection')}</Banner> : null}
      <Body t={t} panel={panel} forms={props.forms} />
    </div>
  )
}

/** The page once we know whether the Host is reachable. */
function Body(props: {
  readonly t: Translator
  readonly panel: PanelClient | undefined
  readonly forms: ConfigFormController | undefined
}): ReactElement {
  const { t, panel, forms } = props
  const [tab, setTab] = useState('pref')
  const [tick, setTick] = useState(0)

  // One overview for the whole page: it carries the store's status, the project list every other
  // panel filters by, and the totals the empty states refer to. Reloading it after a write is what
  // makes those counts trustworthy.
  const overview = useRemote(panel !== undefined, () => requirePanel(panel).overview(), [tick])
  const value = overview.loadable.state === 'ready' ? overview.loadable.value : undefined
  const changed = (): void => setTick((current) => current + 1)

  return (
    <>
      <Tabs items={TABS.map((entry) => ({ id: entry.id, label: t(entry.key) }))} active={tab} onSelect={setTab} />

      {value !== undefined ? (
        <div className="evm-chips">
          <Chip tone={value.status === 'ready' ? 'plain' : 'warn'}>{value.status}</Chip>
          {value.database !== null ? <Chip tone="muted">{value.database}</Chip> : null}
        </div>
      ) : null}
      {overview.loadable.state === 'failed' ? <Banner kind="danger">{overview.loadable.message}</Banner> : null}
      {value !== undefined && value.failure !== '' ? <Banner kind="danger">{value.failure}</Banner> : null}

      {tab === 'pref' ? <PreferencesPanel t={t} forms={forms} /> : null}
      {tab !== 'pref' && panel === undefined ? <Banner kind="warn">{t('page.no-connection')}</Banner> : null}
      {tab === 'mem' && panel !== undefined ? <MemoriesPanel t={t} panel={panel} overview={value} onChanged={changed} /> : null}
      {tab === 'add' && panel !== undefined ? <RememberPanel t={t} panel={panel} overview={value} onChanged={changed} /> : null}
      {tab === 'daily' && panel !== undefined ? <DailyPanel t={t} panel={panel} overview={value} onChanged={changed} /> : null}
      {tab === 'data' && panel !== undefined ? <DataPanel t={t} panel={panel} overview={value} onChanged={changed} /> : null}
    </>
  )
}

/**
 * The client, asserted present.
 *
 * `useRemote` is only enabled when there is a client, so the load callback cannot run without one;
 * this keeps that fact in one place instead of an assertion inside the callback expression.
 *
 * @param panel - the client, possibly absent.
 * @returns the client.
 */
function requirePanel(panel: PanelClient | undefined): PanelClient {
  if (panel === undefined) throw new Error('dsh-evermemory: panel client is not connected')
  return panel
}
