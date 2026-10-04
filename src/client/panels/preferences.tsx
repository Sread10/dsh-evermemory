/**
 * The preferences panel: the ten volatile fields, edited through the Host's own settings service.
 *
 * This is the half of the page that is *not* plugin-specific. The Host already knows this plugin's
 * Config schema, already serves the resolved values, and already owns a write queue per entry
 * (`ctx.configForms.get(entryId)`), so a plugin that invented its own preferences endpoint would be
 * maintaining a second source of truth for values the Host can change underneath it — a
 * `cordis.patch.yml` edit, another window, or the official form.
 *
 * Two behaviours are worth naming because they are what the controller actually promises:
 *
 *  - A committed write folds into the shared mirror, so the switch follows the Host rather than the
 *    click. The local draft below exists only to keep the control responsive while that round trip
 *    is in flight, and it is dropped as soon as the snapshot agrees with it.
 *  - A refused write must be visible. If `set()` resolves `false` the draft is dropped immediately,
 *    which snaps the switch back — the honest rendering of "the Host did not accept that".
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { Banner, Button, Card, SectionHeading, SwitchRow, TextField } from '../ui.js'
import { useAction, useFormSnapshot } from '../hooks.js'
import type { Translator } from '../i18n.js'
import type { ConfigFormController, ConfigFormSnapshot } from '../services.js'

/** The switches, in the order they are shown, grouped the way a user thinks about them. */
const GROUPS: readonly { readonly title: string; readonly note: string; readonly fields: readonly string[] }[] = [
  { title: 'pref.group.write', note: 'pref.group.write.desc', fields: ['memoryEnabled', 'projectMemoryEnabled', 'dailyLogEnabled', 'distillEnabled'] },
  {
    title: 'pref.group.inject',
    note: 'pref.group.inject.desc',
    fields: ['indexInjectionEnabled', 'cardInjectionEnabled', 'constraintInjectionEnabled', 'tailReminderEnabled'],
  },
  { title: 'pref.group.rules', note: 'pref.group.rules.desc', fields: ['rulesEnabled'] },
]

/** Everything the panel renders from. */
export interface PreferencesProps {
  readonly t: Translator
  /** The Host form, when the preferences service is composed. */
  readonly forms: ConfigFormController | undefined
}

/**
 * Render the preferences panel.
 *
 * @param props - the translator and the form.
 * @returns the panel.
 */
export function PreferencesPanel(props: PreferencesProps): ReactElement {
  const { t, forms } = props
  const action = useAction()
  const snapshot = useFormSnapshot(forms)
  const [draft, setDraft] = useState<Readonly<Record<string, boolean>>>({})
  const [dirs, setDirs] = useState<string | undefined>(undefined)

  // Drop draft entries the Host has caught up with. Until then the switch shows the user's intent,
  // which is what makes a two-second round trip feel like a real switch.
  useEffect(() => {
    setDraft((previous) => {
      const kept: Record<string, boolean> = {}
      for (const [field, value] of Object.entries(previous)) {
        if (readBoolean(snapshot, field) !== value) kept[field] = value
      }
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept
    })
  }, [snapshot])

  if (forms === undefined) {
    return <Banner kind="warn">{t('pref.no-service')}</Banner>
  }

  const status = snapshot?.status ?? 'loading'
  const writable = snapshot?.writable === true
  const overridden = Object.keys(snapshot?.user ?? {})

  const write = (field: string, value: unknown): void => {
    action.run(
      () => forms.set(field, value).then((accepted) => acceptedResult(accepted, field)),
      undefined,
      t('pref.saved'),
    )
  }

  const toggle = (field: string, next: boolean): void => {
    setDraft((previous) => ({ ...previous, [field]: next }))
    action.run(
      () =>
        forms.set(field, next).then((accepted) => {
          if (!accepted) setDraft((previous) => without(previous, field))
          return acceptedResult(accepted, field)
        }),
      undefined,
      t('pref.saved'),
    )
  }

  const currentDirs = dirs ?? readDirs(snapshot)

  return (
    <>
      {status === 'unavailable' ? <Banner kind="warn">{t('pref.unavailable')}</Banner> : null}
      {status === 'loading' ? <Banner>{t('pref.loading')}</Banner> : null}
      {snapshot !== undefined && snapshot.mode === 'memory' ? <Banner kind="warn">{t('pref.ephemeral')}</Banner> : null}
      {!writable && status === 'ready' ? <Banner kind="warn">{t('label.readonly')}</Banner> : null}
      {action.message !== undefined ? <Banner kind={action.tone}>{action.message}</Banner> : null}

      {GROUPS.map((group) => (
        <section key={group.title}>
          <SectionHeading title={t(group.title)} description={t(group.note)} />
          <Card>
            {group.fields.map((field) => (
              <SwitchRow
                key={field}
                id={`evm-pref-${field}`}
                label={t(`toggle.${field}`)}
                description={t(`toggle.${field}.desc`)}
                checked={effective(snapshot, draft, field)}
                disabled={!writable}
                onChange={(next) => toggle(field, next)}
              />
            ))}
          </Card>
        </section>
      ))}

      <section>
        <SectionHeading title={t('pref.dirs')} description={t('pref.dirs.desc')} />
        <Card>
          <div className="evm-field">
            <TextField
              id="evm-pref-dirs"
              label={t('pref.dirs.label')}
              value={currentDirs}
              multiline
              rows={3}
              disabled={!writable}
              placeholder={t('pref.dirs.placeholder')}
              onChange={setDirs}
            />
            <div className="evm-footer">
              <Button
                variant="primary"
                size="sm"
                disabled={!writable || action.busy || currentDirs === readDirs(snapshot)}
                onClick={() => {
                  write('extraRuleDirs', splitDirs(currentDirs))
                  setDirs(undefined)
                }}
              >
                {t('action.save')}
              </Button>
            </div>
          </div>
        </Card>
      </section>

      {overridden.length > 0 ? (
        <div className="evm-footer">
          <Button
            variant="outline"
            size="sm"
            disabled={!writable || action.busy}
            onClick={() => {
              action.run(
                async () => {
                  for (const field of overridden) await forms.unset(field)
                  return { ok: true, value: null }
                },
                undefined,
                t('pref.resetDone'),
              )
            }}
          >
            {t('pref.reset')}
          </Button>
        </div>
      ) : null}
    </>
  )
}

/** The switch's value: the draft while a write is in flight, else the Host's resolved value. */
function effective(snapshot: ConfigFormSnapshot | undefined, draft: Readonly<Record<string, boolean>>, field: string): boolean {
  const pending = draft[field]
  if (pending !== undefined) return pending
  return readBoolean(snapshot, field) ?? false
}

/** Read one boolean out of a snapshot's resolved values. */
function readBoolean(snapshot: ConfigFormSnapshot | undefined, field: string): boolean | undefined {
  const value = snapshot?.value?.[field]
  return typeof value === 'boolean' ? value : undefined
}

/** Read the extra rule directories as one editable block, one per line. */
function readDirs(snapshot: ConfigFormSnapshot | undefined): string {
  const value = snapshot?.value?.['extraRuleDirs']
  if (!Array.isArray(value)) return ''
  return value.filter((entry): entry is string => typeof entry === 'string').join('\n')
}

/** Parse the edited block back into a list. Blank lines are dropped rather than stored. */
function splitDirs(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** Drop one draft entry. */
function without(draft: Readonly<Record<string, boolean>>, field: string): Readonly<Record<string, boolean>> {
  const next: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(draft)) if (key !== field) next[key] = value
  return next
}

/** Turn the controller's boolean answer into the shape `useAction` reports. */
function acceptedResult(accepted: boolean, field: string): { readonly ok: true; readonly value: null } | { readonly ok: false; readonly error: { code: string; message: string; details: Record<string, unknown> } } {
  if (accepted) return { ok: true, value: null }
  return {
    ok: false,
    error: { code: 'pref/refused', message: `${field}: 宿主没有接受这次修改。`, details: { field } },
  }
}
