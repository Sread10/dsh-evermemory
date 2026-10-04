/**
 * The data panel: Markdown out, other tools' memories in.
 *
 * The export is the project's one documented interchange format — SQLite is the only store, and
 * Markdown exists so a human can read or move the contents — so the button renders the document in
 * the page before offering it as a file. That order matters: an export a user cannot see is an
 * export they cannot check, and the whole point of the format is that it is legible.
 *
 * The import is step 7's engine, driven from here instead of from a tool call. It runs the same
 * `runImport`, so the panel inherits its detection, its ledger and its four-state merge; the only
 * thing this file adds is the shape of the report. `dryRun` is offered prominently rather than
 * hidden behind a confirm dialog, because "show me what you would do" is the honest first move when
 * pointing a memory system at a directory it did not write.
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import type { PanelExportResult, PanelImportResult, PanelOverview, PanelProjectRef } from '../../panel/protocol.js'
import { Banner, Button, Card, Chip, SectionHeading, SelectField, SwitchRow, TextField } from '../ui.js'
import { useAction } from '../hooks.js'
import type { Translator } from '../i18n.js'
import type { PanelClient } from '../api.js'

/** Characters of Markdown shown in the preview before the download is the only way to see the rest. */
const PREVIEW_CHARS = 4000

/** Everything the panel renders from. */
export interface DataProps {
  readonly t: Translator
  readonly panel: PanelClient
  readonly overview: PanelOverview | undefined
  /** Called after a real import, so counts refresh. */
  readonly onChanged: () => void
}

/**
 * Render the data panel.
 *
 * @param props - translator, client, overview and the change hook.
 * @returns the panel.
 */
export function DataPanel(props: DataProps): ReactElement {
  const { t, panel, overview, onChanged } = props
  const action = useAction()
  const [includeArchived, setIncludeArchived] = useState(false)
  const [document, setDocument] = useState<PanelExportResult | undefined>(undefined)
  const [path, setPath] = useState('')
  const [dryRun, setDryRun] = useState(true)
  const [scope, setScope] = useState('global')
  const [projectKey, setProjectKey] = useState('')
  const [report, setReport] = useState<PanelImportResult | undefined>(undefined)

  const projects = overview?.projects ?? []
  const project = scope === 'project' ? projectOf(projectKey, projects) : undefined
  const importerBlocked = path.trim() === '' || (scope === 'project' && project === undefined)

  return (
    <>
      <SectionHeading title={t('data.export.title')} description={t('data.export.desc')} />
      {action.message !== undefined ? <Banner kind={action.tone}>{action.message}</Banner> : null}

      <Card>
        <SwitchRow
          id="evm-data-archived"
          label={t('data.export.archived')}
          description={t('data.export.archived.desc')}
          checked={includeArchived}
          onChange={setIncludeArchived}
        />
        <div className="evm-footer">
          <Button
            variant="primary"
            size="sm"
            disabled={action.busy}
            onClick={() => {
              action.run(
                () => panel.exportDocument({ includeArchived }),
                setDocument,
                t('data.export.ready'),
              )
            }}
          >
            {t('data.export.build')}
          </Button>
          {document !== undefined ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                save(document.filename, document.markdown)
              }}
            >
              {t('data.export.download')}
            </Button>
          ) : null}
          {document !== undefined ? (
            <Chip tone="muted">
              {String(document.count)} · {formatBytes(document.bytes)}
            </Chip>
          ) : null}
        </div>
        {document !== undefined ? (
          <pre className="evm-pre">{document.markdown.slice(0, PREVIEW_CHARS)}</pre>
        ) : null}
      </Card>

      <section>
        <SectionHeading title={t('data.import.title')} description={t('data.import.desc')} />
        <Card>
          <TextField
            id="evm-data-path"
            label={t('data.import.path')}
            description={t('data.import.path.desc')}
            value={path}
            placeholder={t('data.import.path.placeholder')}
            onChange={setPath}
          />
          <SwitchRow
            id="evm-data-dry"
            label={t('data.import.dry')}
            description={t('data.import.dry.desc')}
            checked={dryRun}
            onChange={setDryRun}
          />
          <div className="evm-grid">
            <SelectField
              id="evm-data-scope"
              label={t('data.import.scope')}
              value={scope}
              options={[
                { value: 'global', label: t('scope.global') },
                { value: 'project', label: t('scope.project') },
              ]}
              onChange={setScope}
            />
            {scope === 'project' ? (
              <SelectField
                id="evm-data-project"
                label={t('mem.filter.project')}
                value={projectKey}
                options={[
                  { value: '', label: t('add.field.project.pick') },
                  ...projects.map((row) => ({ value: row.projectKey, label: row.projectPath ?? row.projectKey })),
                ]}
                onChange={setProjectKey}
              />
            ) : null}
          </div>
          <div className="evm-footer">
            <Button
              variant="primary"
              size="sm"
              disabled={action.busy || importerBlocked}
              onClick={() => {
                action.run(
                  () =>
                    panel.importPath({
                      path,
                      dryRun,
                      scope: scope === 'project' ? 'project' : 'global',
                      ...(project === undefined ? {} : { project }),
                    }),
                  (value) => {
                    setReport(value)
                    if (!value.dryRun) onChanged()
                  },
                  t('data.import.done'),
                )
              }}
            >
              {action.busy ? t('action.saving') : dryRun ? t('data.import.preview') : t('data.import.run')}
            </Button>
          </div>
        </Card>

        {report !== undefined ? <Report t={t} report={report} /> : null}
      </section>
    </>
  )
}

/** The import report: the engine's own numbers, then the sample decisions behind them. */
function Report(props: { readonly t: Translator; readonly report: PanelImportResult }): ReactElement {
  const { t, report } = props
  // A preview writes nothing, but the engine still counts what it WOULD write — so the label has to
  // say "would write" or the number reads as a completed action.
  const counters: readonly (readonly [string, number])[] = [
    ['data.field.scanned', report.scanned],
    ['data.field.considered', report.considered],
    ['data.field.known', report.known],
    [report.dryRun ? 'data.field.wouldWrite' : 'data.field.written', report.written],
    ['data.field.merged', report.merged],
    ['data.field.updated', report.updated],
    ['data.field.ignored', report.ignored],
    ['data.field.rejected', report.rejected],
    ['data.field.oversized', report.oversized],
    ['data.field.logged', report.logged],
  ]

  return (
    <Card>
      <div className="evm-row">
        <div className="evm-row-text">
          <span className="evm-row-title">{report.path}</span>
          <div className="evm-chips">
            <Chip>{report.source}</Chip>
            {report.platform !== null ? <Chip tone="muted">{report.platform}</Chip> : null}
            <Chip tone={report.ok ? 'plain' : 'warn'}>{report.ok ? t('data.report.ok') : t('data.report.failed')}</Chip>
            {report.dryRun ? <Chip tone="warn">{t('data.report.dry')}</Chip> : null}
            {report.truncated ? <Chip tone="warn">{t('data.report.truncated')}</Chip> : null}
          </div>
        </div>
      </div>
      <div className="evm-chips">
        {counters
          .filter(([, value]) => value > 0)
          .map(([key]) => (
            <Chip key={key} tone="muted">
              {t(key)}
            </Chip>
          ))}
      </div>
      <ul className="evm-list">
        {counters
          .filter(([key]) => key !== 'data.field.source')
          .map(([key, value]) => (
            <li key={key}>
              {t(key)}: <strong>{String(value)}</strong>
            </li>
          ))}
      </ul>
      {report.errors.length > 0 ? (
        <ul className="evm-list">
          {report.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      {report.samples.length > 0 ? (
        <ul className="evm-list">
          {report.samples.map((sample) => (
            <li key={sample.uri}>
              <Chip tone={sample.decision === 'rejected' ? 'warn' : 'muted'}>{sample.decision}</Chip> {sample.text}
              {sample.reason === undefined ? null : ` — ${sample.reason}`}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  )
}

/** Hand the document to the browser as a file. */
function save(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/** Bytes as `kB`/`MB`, the way a file manager shows them. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Resolve a project key against the overview's list. */
function projectOf(key: string, projects: readonly { readonly projectKey: string; readonly projectPath: string | null }[]): PanelProjectRef | undefined {
  const row = projects.find((candidate) => candidate.projectKey === key)
  return row === undefined ? { key } : { key, path: row.projectPath }
}
