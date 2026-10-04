/**
 * The remember panel: the conversational write path, with a text box.
 *
 * Deliberately the same call the `evermemory_remember` tool makes. A panel that wrote rows directly
 * would be a second write path with its own rules, and the first thing to drift would be the merge
 * — which is the part users notice, because it decides whether their new sentence replaces an old
 * one or sits beside it. The answer is therefore reported rather than assumed: the decision
 * (`new`, `merged`, `updated`, `ignored`, `rejected`), the reason the gate gave, and the ids it
 * superseded are all shown, because "stored" is not the same thing as "stored the way I meant".
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import type { PanelOverview, PanelProjectRef } from '../../panel/protocol.js'
import { Banner, Button, Card, Chip, SectionHeading, SelectField, SwitchRow, TextField } from '../ui.js'
import { useAction } from '../hooks.js'
import type { Translator } from '../i18n.js'
import type { PanelClient } from '../api.js'

/** Everything the panel renders from. */
export interface RememberProps {
  readonly t: Translator
  readonly panel: PanelClient
  readonly overview: PanelOverview | undefined
  /** Called after a successful write. */
  readonly onChanged: () => void
}

/**
 * Render the remember panel.
 *
 * @param props - translator, client, overview and the change hook.
 * @returns the panel.
 */
export function RememberPanel(props: RememberProps): ReactElement {
  const { t, panel, overview, onChanged } = props
  const action = useAction()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [scope, setScope] = useState('global')
  const [projectKey, setProjectKey] = useState('')
  const [pinned, setPinned] = useState(false)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)

  const projects = overview?.projects ?? []
  const project = scope === 'project' ? projectOf(projectKey, projects) : undefined
  const blocked = body.trim() === '' || (scope === 'project' && project === undefined)

  return (
    <>
      <SectionHeading title={t('add.title')} description={t('add.desc')} />
      {action.message !== undefined ? <Banner kind={action.tone}>{action.message}</Banner> : null}
      {receipt !== undefined ? <Banner kind="info">{receipt}</Banner> : null}

      <Card>
        <TextField id="evm-add-title" label={t('add.field.title')} value={title} placeholder={t('add.field.title.placeholder')} onChange={setTitle} />
        <TextField
          id="evm-add-text"
          label={t('add.field.text')}
          description={t('add.field.text.desc')}
          value={body}
          multiline
          rows={6}
          onChange={setBody}
        />
        <TextField id="evm-add-tags" label={t('mem.field.tags')} description={t('mem.field.tags.desc')} value={tags} onChange={setTags} />
        <div className="evm-grid">
          <SelectField
            id="evm-add-scope"
            label={t('add.field.scope')}
            description={t('add.field.scope.desc')}
            value={scope}
            options={[
              { value: 'global', label: t('scope.global') },
              { value: 'project', label: t('scope.project') },
            ]}
            onChange={setScope}
          />
          {scope === 'project' ? (
            <SelectField
              id="evm-add-project"
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
        <SwitchRow id="evm-add-pinned" label={t('add.field.pinned')} description={t('add.field.pinned.desc')} checked={pinned} onChange={setPinned} />
      </Card>

      <div className="evm-footer">
        <Button
          variant="primary"
          disabled={action.busy || blocked}
          onClick={() => {
            const request = {
              text: body,
              scope: scope === 'project' ? ('project' as const) : ('global' as const),
              ...(title.trim() === '' ? {} : { title }),
              ...(tags.trim() === '' ? {} : { tags: splitTags(tags) }),
              ...(pinned ? { pinned: true } : {}),
              ...(project === undefined ? {} : { project }),
            }
            action.run(
              () => panel.remember(request),
              (value) => {
                setReceipt(receiptOf(value, t))
                setBody('')
                onChanged()
              },
              t('add.saved'),
            )
          }}
        >
          {action.busy ? t('action.saving') : t('action.save')}
        </Button>
      </div>

      <p className="evm-note">{t('add.note')}</p>
      {overview !== undefined ? (
        <p className="evm-note">
          {t('mem.total')}: {String(overview.total)}
          {' · '}
          {overview.database ?? t('label.unavailable')}
        </p>
      ) : null}
      {overview !== undefined && overview.failure !== '' ? <Banner kind="danger">{overview.failure}</Banner> : null}
      {overview !== undefined && overview.status !== 'ready' ? <Chip tone="warn">{overview.status}</Chip> : null}
    </>
  )
}

/** Split a comma-or-space separated tag line. */
function splitTags(value: string): readonly string[] {
  return value
    .split(/[,，\s]+/u)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
}

/** A one-line summary of what the store did with the request. */
function receiptOf(
  value: { readonly decision: string; readonly id: number | null; readonly reason: string; readonly superseded: readonly number[] },
  t: Translator,
): string {
  const parts = [`${t('add.decision')}: ${value.decision}`]
  if (value.id !== null) parts.push(`#${String(value.id)}`)
  if (value.reason !== '') parts.push(value.reason)
  if (value.superseded.length > 0) parts.push(`${t('add.superseded')}: ${value.superseded.map((id) => `#${String(id)}`).join(' ')}`)
  return parts.join(' · ')
}

/** Resolve a project key against the overview's list. */
function projectOf(key: string, projects: readonly { readonly projectKey: string; readonly projectPath: string | null }[]): PanelProjectRef | undefined {
  if (key === '') return undefined
  const row = projects.find((candidate) => candidate.projectKey === key)
  return row === undefined ? { key } : { key, path: row.projectPath }
}
