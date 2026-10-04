/**
 * The daily-log panel: today's log, and appending to it.
 *
 * The log is the fourth memory layer and the only one a session writes on its own at turn end, so
 * this panel is the place a user can see what that produced without waiting for a distillation to
 * happen. Reading one day is a single call: `daily` takes a date and returns that day's log or
 * nothing at all, and "nothing at all" is rendered as an empty state rather than as an error,
 * because a day with no log is a normal day.
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import type { PanelOverview, PanelProjectRef } from '../../panel/protocol.js'
import { Banner, Button, Card, Chip, Empty, SectionHeading, SelectField, TextField } from '../ui.js'
import { useAction, useRemote } from '../hooks.js'
import type { Translator } from '../i18n.js'
import type { PanelClient } from '../api.js'

/** Everything the panel renders from. */
export interface DailyProps {
  readonly t: Translator
  readonly panel: PanelClient
  readonly overview: PanelOverview | undefined
  /** Called after a successful append. */
  readonly onChanged: () => void
}

/**
 * Render the daily panel.
 *
 * @param props - translator, client, overview and the change hook.
 * @returns the panel.
 */
export function DailyPanel(props: DailyProps): ReactElement {
  const { t, panel, overview, onChanged } = props
  const action = useAction()
  const [date, setDate] = useState(today())
  const [projectKey, setProjectKey] = useState('')
  const [entry, setEntry] = useState('')

  const projects = overview?.projects ?? []
  const project = projectKey === '' ? undefined : projectOf(projectKey, projects)
  const reading = useRemote(true, () => panel.daily(project, date), [date, projectKey])
  const log = reading.loadable.state === 'ready' ? reading.loadable.value.log : null
  const lines = entry
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')

  return (
    <>
      <SectionHeading title={t('daily.title')} description={t('daily.desc')} />
      {action.message !== undefined ? <Banner kind={action.tone}>{action.message}</Banner> : null}

      <Card>
        <div className="evm-grid">
          <TextField id="evm-daily-date" label={t('daily.field.date')} value={date} type="date" onChange={setDate} />
          <SelectField
            id="evm-daily-project"
            label={t('daily.field.project')}
            description={t('daily.field.project.desc')}
            value={projectKey}
            options={[
              { value: '', label: t('scope.global') },
              ...projects.map((row) => ({ value: row.projectKey, label: row.projectPath ?? row.projectKey })),
            ]}
            onChange={setProjectKey}
          />
        </div>
      </Card>

      {reading.loadable.state === 'loading' ? <Banner>{t('label.loading')}</Banner> : null}
      {reading.loadable.state === 'failed' ? <Banner kind="danger">{reading.loadable.message}</Banner> : null}

      {log === null && reading.loadable.state === 'ready' ? <Empty>{t('daily.empty')}</Empty> : null}

      {log !== null ? (
        <Card>
          <div className="evm-row">
            <div className="evm-row-text">
              <span className="evm-row-title">{log.date}</span>
              <div className="evm-chips">
                <Chip tone={log.status === 'active' ? 'plain' : 'muted'}>{log.status}</Chip>
                <Chip tone="muted">
                  {t('daily.entries')}: {String(log.entries.length)}
                </Chip>
                <Chip tone="muted">{log.updatedAt}</Chip>
              </div>
            </div>
          </div>
          {log.entries.length > 0 ? (
            <ul className="evm-list">
              {log.entries.map((item, index) => (
                <li key={`${String(index)}-${item.slice(0, 16)}`}>{item}</li>
              ))}
            </ul>
          ) : null}
          <p className="evm-row-desc evm-body">{log.text}</p>
        </Card>
      ) : null}

      <section>
        <SectionHeading title={t('daily.append')} description={t('daily.append.desc')} />
        <Card>
          <TextField
            id="evm-daily-entry"
            label={t('daily.field.entry')}
            description={t('daily.field.entry.desc')}
            value={entry}
            multiline
            rows={4}
            onChange={setEntry}
          />
          <div className="evm-footer">
            <Button
              variant="primary"
              size="sm"
              disabled={action.busy || lines.length === 0}
              onClick={() => {
                action.run(
                  () => panel.log(lines, project, date),
                  () => {
                    setEntry('')
                    reading.reload()
                    onChanged()
                  },
                  t('daily.saved'),
                )
              }}
            >
              {action.busy ? t('action.saving') : t('action.save')}
            </Button>
          </div>
        </Card>
      </section>
    </>
  )
}

/** Today, as `YYYY-MM-DD` in the user's own timezone rather than in UTC. */
function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${String(now.getFullYear())}-${month}-${day}`
}

/** Resolve a project key against the overview's list. */
function projectOf(key: string, projects: readonly { readonly projectKey: string; readonly projectPath: string | null }[]): PanelProjectRef | undefined {
  const row = projects.find((candidate) => candidate.projectKey === key)
  return row === undefined ? { key } : { key, path: row.projectPath }
}
