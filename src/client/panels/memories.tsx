/**
 * The memories panel: what is actually stored, and the four things a user does about it.
 *
 * The list is the Host's own answer, never a local cache of one: `list` returns one page plus the
 * total for the same filter, and a write is followed by a reload rather than by a local splice. That
 * matters more here than in most panels, because a `remember` can merge into an existing row, so the
 * row a user just saved may not be the row they typed — the reload is what shows them that.
 *
 * Search switches the source: with a query the panel calls `search`, which runs the same retrieval
 * engine the injection path uses, so the ranking a user sees is the ranking a session sees. Without
 * one it calls `list`, which is the store order a curator wants.
 *
 * Archive, not delete, everywhere. `forget` archives — the store keeps its history — and the page
 * says so in the button's confirmation text instead of implying a delete it cannot perform.
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { MEMORY_SCOPES, SEARCH_LIMIT_DEFAULT } from '../../constants.js'
import type { MemoryScope, MemoryStatus } from '../../constants.js'
import type { PanelMemory, PanelOverview, PanelProjectRef, PanelSearchHit } from '../../panel/protocol.js'
import { Banner, Button, Card, Chip, Empty, SectionHeading, SelectField, TextField } from '../ui.js'
import { useAction, useRemote } from '../hooks.js'
import type { Translator } from '../i18n.js'
import type { PanelClient } from '../api.js'

/** Page size. Small enough that a page renders instantly, large enough to be worth scrolling. */
const PAGE = 20

/** How a row's layer is shown. */
const SCOPE_LABEL: Readonly<Record<MemoryScope, string>> = {
  identity: 'scope.identity',
  global: 'scope.global',
  project: 'scope.project',
  daily: 'scope.daily',
}

/** How a row's status is shown. */
const STATUS_LABEL: Readonly<Record<MemoryStatus, string>> = {
  active: 'status.active',
  outdated: 'status.outdated',
  archived: 'status.archived',
  pending: 'status.pending',
}

/**
 * What a row has to carry to be rendered.
 *
 * Narrower than `PanelMemory` on purpose. A retrieval hit and a list row are different answers — a
 * ranked hit knows nothing about project ownership or provenance — so the panel asks both for the
 * fields they share instead of inventing values for the rest. Editing has its own escape hatch:
 * `panel.get` fetches the whole row before the editor opens.
 */
interface Row {
  readonly id: number
  readonly title: string
  readonly text: string
  readonly scope: MemoryScope
  readonly status: MemoryStatus
  readonly pinned: boolean
  readonly tags: readonly string[]
  readonly projectPath: string | null
}

/** One page of rows, from either source, with the flags the footer needs. */
interface Listing {
  readonly rows: readonly Row[]
  /** Rows matching the filter; for a retrieval, the number of hits returned. */
  readonly total: number
  /** True when the answer came from the retrieval engine, which does not page. */
  readonly ranked: boolean
}

/** Everything the panel renders from. */
export interface MemoriesProps {
  readonly t: Translator
  readonly panel: PanelClient
  readonly overview: PanelOverview | undefined
  /** Called after a write, so the shell can refresh the overview. */
  readonly onChanged: () => void
}

/** The row currently being edited. */
interface Draft {
  readonly id: number
  readonly title: string
  readonly text: string
  readonly tags: string
}

/**
 * Render the memories panel.
 *
 * @param props - translator, client, overview and the change hook.
 * @returns the panel.
 */
export function MemoriesPanel(props: MemoriesProps): ReactElement {
  const { t, panel, overview, onChanged } = props
  const action = useAction()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [status, setStatus] = useState('active')
  const [projectKey, setProjectKey] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)

  const projects = overview?.projects ?? []
  const project = projectKey === '' ? undefined : projectOf(projectKey, projects)
  const layers = scope === 'all' ? undefined : [scope as MemoryScope]
  const statuses = status === 'all' ? undefined : [status as MemoryStatus]

  const listing = useRemote<Listing>(
    true,
    async () => {
      const term = query.trim()
      if (term === '') {
        const answer = await panel.list({
          ...(layers === undefined ? {} : { scope: layers }),
          ...(statuses === undefined ? {} : { status: statuses }),
          ...(project === undefined ? {} : { project }),
          limit,
          offset: 0,
          orderBy: 'used',
        })
        return answer.ok
          ? { ok: true, value: { rows: answer.value.items.map(rowOfMemory), total: answer.value.total, ranked: false } }
          : answer
      }
      const answer = await panel.search({
        query: term,
        ...(layers === undefined ? {} : { scope: layers }),
        limit: SEARCH_LIMIT_DEFAULT,
        ...(project === undefined ? {} : { project }),
      })
      return answer.ok
        ? { ok: true, value: { rows: answer.value.hits.map(rowOfHit), total: answer.value.hits.length, ranked: true } }
        : answer
    },
    [query, scope, status, projectKey, limit],
  )

  const refresh = (): void => {
    listing.reload()
    onChanged()
  }

  const rows = listing.loadable.state === 'ready' ? listing.loadable.value.rows : []
  const total = listing.loadable.state === 'ready' ? listing.loadable.value.total : undefined
  const ranked = listing.loadable.state === 'ready' && listing.loadable.value.ranked

  return (
    <>
      <SectionHeading title={t('mem.list.title')} description={t('mem.list.desc')} />
      {action.message !== undefined ? <Banner kind={action.tone}>{action.message}</Banner> : null}

      <Card>
        <TextField id="evm-mem-query" label={t('mem.search')} value={query} placeholder={t('mem.search.placeholder')} onChange={setQuery} />
        <div className="evm-grid">
          <SelectField
            id="evm-mem-scope"
            label={t('mem.filter.scope')}
            value={scope}
            options={[{ value: 'all', label: t('filter.all') }, ...MEMORY_SCOPES.map((value) => ({ value, label: t(SCOPE_LABEL[value]) }))]}
            onChange={setScope}
          />
          <SelectField
            id="evm-mem-status"
            label={t('mem.filter.status')}
            value={status}
            options={[
              { value: 'active', label: t('status.active') },
              { value: 'outdated', label: t('status.outdated') },
              { value: 'archived', label: t('status.archived') },
              { value: 'pending', label: t('status.pending') },
              { value: 'all', label: t('filter.all') },
            ]}
            onChange={setStatus}
          />
          <SelectField
            id="evm-mem-project"
            label={t('mem.filter.project')}
            value={projectKey}
            options={[
              { value: '', label: t('filter.all') },
              ...projects.map((row) => ({ value: row.projectKey, label: `${row.projectPath ?? row.projectKey} (${String(row.count)})` })),
            ]}
            onChange={setProjectKey}
          />
        </div>
      </Card>

      {listing.loadable.state === 'loading' ? <Banner>{t('label.loading')}</Banner> : null}
      {listing.loadable.state === 'failed' ? <Banner kind="danger">{listing.loadable.message}</Banner> : null}

      {rows.length === 0 && listing.loadable.state === 'ready' ? <Empty>{t('mem.list.empty')}</Empty> : null}

      {rows.map((row) => (
        <Card key={row.id}>
          {draft?.id === row.id ? (
            <EditRow
              t={t}
              draft={draft}
              busy={action.busy}
              onChange={setDraft}
              onCancel={() => setDraft(undefined)}
              onSave={() => {
                action.run(
                  () =>
                    panel.update(
                      row.id,
                      {
                        title: draft.title,
                        text: draft.text,
                        tags: draft.tags
                          .split(',')
                          .map((tag) => tag.trim())
                          .filter((tag) => tag !== ''),
                      },
                      project,
                    ),
                  () => {
                    setDraft(undefined)
                    refresh()
                  },
                  t('mem.saved'),
                )
              }}
            />
          ) : (
            <>
              <div className="evm-row">
                <div className="evm-row-text">
                  <span className="evm-row-title">
                    {row.pinned ? '★ ' : ''}
                    {row.title === '' ? `#${String(row.id)}` : row.title}
                  </span>
                  <div className="evm-chips">
                    <Chip>{t(SCOPE_LABEL[row.scope])}</Chip>
                    <Chip tone={row.status === 'active' ? 'plain' : 'muted'}>{t(STATUS_LABEL[row.status])}</Chip>
                    {row.projectPath !== null ? <Chip tone="muted">{row.projectPath}</Chip> : null}
                    {row.tags.map((tag) => (
                      <Chip key={tag} tone="muted">
                        #{tag}
                      </Chip>
                    ))}
                  </div>
                </div>
              </div>
              <p className="evm-row-desc evm-body">{row.text}</p>
              <div className="evm-footer">
                <Button
                  size="sm"
                  disabled={action.busy}
                  onClick={() => {
                    action.run(() => panel.update(row.id, { pinned: !row.pinned }, project), refresh, row.pinned ? t('mem.unpinned') : t('mem.pinned'))
                  }}
                >
                  {row.pinned ? t('mem.unpin') : t('mem.pin')}
                </Button>
                <Button
                  size="sm"
                  disabled={action.busy}
                  onClick={() => {
                    void panel.get(row.id).then((result) => {
                      if (!result.ok) {
                        action.say(result.error.message, 'danger')
                        return
                      }
                      setDraft(draftOf(result.value.item))
                    })
                  }}
                >
                  {t('mem.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={action.busy || row.status === 'archived'}
                  onClick={() => {
                    action.run(() => panel.forget(row.id, project), refresh, t('mem.archived'))
                  }}
                >
                  {t('mem.archive')}
                </Button>
              </div>
            </>
          )}
        </Card>
      ))}

      {total !== undefined && !ranked && total > rows.length ? (
        <div className="evm-footer">
          <Button size="sm" disabled={action.busy} onClick={() => setLimit((value) => value + PAGE)}>
            {t('mem.more')}
          </Button>
        </div>
      ) : null}
      {total !== undefined ? <p className="evm-note">{t('mem.total')}: {String(total)}</p> : null}
    </>
  )
}

/** The inline editor for one row. */
function EditRow(props: {
  readonly t: Translator
  readonly draft: Draft
  readonly busy: boolean
  readonly onChange: (next: Draft) => void
  readonly onCancel: () => void
  readonly onSave: () => void
}): ReactElement {
  const { t, draft } = props
  return (
    <>
      <TextField id={`evm-edit-title-${String(draft.id)}`} label={t('mem.field.title')} value={draft.title} onChange={(title) => props.onChange({ ...draft, title })} />
      <TextField
        id={`evm-edit-text-${String(draft.id)}`}
        label={t('mem.field.text')}
        value={draft.text}
        multiline
        rows={6}
        onChange={(text) => props.onChange({ ...draft, text })}
      />
      <TextField id={`evm-edit-tags-${String(draft.id)}`} label={t('mem.field.tags')} value={draft.tags} description={t('mem.field.tags.desc')} onChange={(tags) => props.onChange({ ...draft, tags })} />
      <div className="evm-footer">
        <Button variant="primary" size="sm" disabled={props.busy} onClick={props.onSave}>
          {t('action.save')}
        </Button>
        <Button size="sm" disabled={props.busy} onClick={props.onCancel}>
          {t('action.discard')}
        </Button>
      </div>
    </>
  )
}

/** Rows out of a list answer. */
function rowOfMemory(row: PanelMemory): Row {
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    scope: row.scope,
    status: row.status,
    pinned: row.pinned,
    tags: row.tags,
    projectPath: row.projectPath,
  }
}

/**
 * A retrieval hit as a row.
 *
 * `search` answers with fewer fields than `list`: a ranked hit carries no project ownership and no
 * provenance. The absent ones become `null` rather than a guess — a hit shown under a project it may
 * not belong to is a wrong answer, while an empty slot is visibly no answer at all.
 */
function rowOfHit(hit: PanelSearchHit): Row {
  return {
    id: hit.id,
    title: hit.title,
    text: hit.text,
    scope: hit.scope,
    status: hit.status,
    pinned: hit.pinned,
    tags: hit.tags,
    projectPath: null,
  }
}

/** The row as the editor wants it: text whole, tags as one editable line. */
function draftOf(row: Row): Draft {
  return { id: row.id, title: row.title, text: row.text, tags: row.tags.join(', ') }
}

/** Resolve a project key against the overview's project list. */
function projectOf(key: string, projects: readonly { readonly projectKey: string; readonly projectPath: string | null }[]): PanelProjectRef {
  const row = projects.find((candidate) => candidate.projectKey === key)
  return row === undefined ? { key } : { key, path: row.projectPath }
}
