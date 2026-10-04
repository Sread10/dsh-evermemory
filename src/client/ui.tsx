/**
 * Hand-rolled controls for the settings page.
 *
 * These exist because the official guidance is that a plugin must not depend on
 * `@deepseek-ai/dsh-client-ui-primitives`: those packages change without notice, a
 * plain-JS plugin gets no type check against them, and a component that throws blanks its
 * whole slot entry with nothing but a console line. The safe move is the documented one —
 * copy the primitive's markup and behaviour, keep only `--dsw-*` token references, and
 * rename the classes under this plugin's own prefix.
 *
 * What was copied, and why each detail matters:
 *
 *  - `Switch` is a real `<button role="switch" aria-checked=…>` whose visual state keys
 *    off `aria-checked`, not off a class. Screen readers and the host's own styling both
 *    depend on that pairing. `Button` is `type="button"` so it never submits an enclosing
 *    form, and its sizes are 36px (`md`) / 28px (`sm`).
 *  - Capsule shapes must opt out of the host's global `corner-shape: superellipse(1.5)`
 *    with `corner-shape: round`; without that a pill renders subtly wrong.
 *  - Focus is `outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`
 *    on `:focus-visible`, which the host suppresses for pointer modality.
 *
 * `Card` and `SectionHeading` have no primitive counterpart at all — the host's own
 * settings pages hand-roll their rows too, with a 0.5px `--dsw-alias-border-l2` hairline.
 */

import type { ChangeEvent, ReactElement, ReactNode } from 'react'

/** Props shared by every row that carries a label and a description. */
interface RowProps {
  /** Stable element id; also used to pair the label with its control. */
  readonly id: string
  /** Primary text. */
  readonly label: string
  /** Optional secondary line under the label. */
  readonly description?: string | undefined
}

/** A titled group of cards. */
interface SectionHeadingProps {
  readonly title: string
  readonly description?: string | undefined
}

/**
 * Render a section title with its explanatory line.
 *
 * @param props - the heading text.
 * @returns the heading element.
 */
export function SectionHeading(props: SectionHeadingProps): ReactElement {
  return (
    <div className="evm-section-head">
      <h3 className="evm-section-title">{props.title}</h3>
      {props.description !== undefined ? <p className="evm-section-desc">{props.description}</p> : null}
    </div>
  )
}

/**
 * Group rows into a card.
 *
 * @param props - the rows, plus an optional override for the card's own class.
 * @returns the card element.
 */
export function Card(props: { readonly children: ReactNode; readonly className?: string | undefined }): ReactElement {
  return <div className={`evm-card${props.className !== undefined ? ` ${props.className}` : ''}`}>{props.children}</div>
}

/** A labelled on/off row. */
interface SwitchRowProps extends RowProps {
  readonly checked: boolean
  readonly disabled?: boolean | undefined
  readonly onChange: (next: boolean) => void
}

/**
 * Render a switch row.
 *
 * @param props - the row's state and handler.
 * @returns the row element.
 */
export function SwitchRow(props: SwitchRowProps): ReactElement {
  const disabled = props.disabled === true

  return (
    <div className="evm-row">
      <div className="evm-row-text">
        <label className="evm-row-title" htmlFor={props.id}>
          {props.label}
        </label>
        {props.description !== undefined ? <p className="evm-row-desc">{props.description}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        id={props.id}
        className="evm-switch"
        aria-checked={props.checked}
        aria-label={props.label}
        disabled={disabled}
        onClick={() => props.onChange(!props.checked)}
      >
        <span className="evm-switch-thumb" />
      </button>
    </div>
  )
}

/** A labelled text input. */
interface TextFieldProps extends RowProps {
  readonly value: string
  readonly placeholder?: string | undefined
  readonly disabled?: boolean | undefined
  readonly multiline?: boolean | undefined
  readonly rows?: number | undefined
  /** `date` gives the browser's own calendar; used by the daily-log panel. */
  readonly type?: 'text' | 'date' | undefined
  readonly onChange: (next: string) => void
}

/**
 * Render a text field row.
 *
 * @param props - the field's state and handler.
 * @returns the row element.
 */
export function TextField(props: TextFieldProps): ReactElement {
  const disabled = props.disabled === true
  const shared = {
    id: props.id,
    className: 'evm-input',
    value: props.value,
    placeholder: props.placeholder ?? '',
    disabled,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => props.onChange(event.target.value),
  }

  return (
    <div className="evm-field">
      <label className="evm-row-title" htmlFor={props.id}>
        {props.label}
      </label>
      {props.description !== undefined ? <p className="evm-row-desc">{props.description}</p> : null}
      {props.multiline === true ? (
        <textarea {...shared} rows={props.rows ?? 6} />
      ) : (
        <input type={props.type ?? 'text'} {...shared} />
      )}
    </div>
  )
}

/** A button. */
interface ButtonProps {
  readonly children: ReactNode
  /** `primary` is the filled brand button; `ghost` is the default text button. */
  readonly variant?: 'primary' | 'ghost' | 'outline' | undefined
  readonly size?: 'md' | 'sm' | undefined
  readonly disabled?: boolean | undefined
  readonly onClick?: (() => void) | undefined
}

/**
 * Render a button.
 *
 * @param props - the button's appearance, state and handler.
 * @returns the button element.
 */
export function Button(props: ButtonProps): ReactElement {
  const variant = props.variant ?? 'ghost'
  const size = props.size ?? 'md'

  return (
    <button
      type="button"
      className={`evm-button evm-button-${variant} evm-button-${size}`}
      disabled={props.disabled === true}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

/** One choice in a {@link SelectField}. */
export interface SelectOption {
  readonly value: string
  readonly label: string
}

/** A labelled `<select>`. */
interface SelectFieldProps extends RowProps {
  readonly value: string
  readonly options: readonly SelectOption[]
  readonly disabled?: boolean | undefined
  readonly onChange: (next: string) => void
}

/**
 * Render a select row.
 *
 * A native `<select>` on purpose: it is the one control whose popup the host's global styles
 * cannot break, and it is what the desktop app's own settings pages use for short enumerations.
 *
 * @param props - the field's state and handler.
 * @returns the row element.
 */
export function SelectField(props: SelectFieldProps): ReactElement {
  return (
    <div className="evm-field">
      <label className="evm-row-title" htmlFor={props.id}>
        {props.label}
      </label>
      {props.description !== undefined ? <p className="evm-row-desc">{props.description}</p> : null}
      <select
        id={props.id}
        className="evm-input evm-select"
        value={props.value}
        disabled={props.disabled === true}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** One tab in a {@link Tabs}. */
export interface TabItem {
  readonly id: string
  readonly label: string
}

/**
 * Render the page's tab strip.
 *
 * @param props - the tabs, the active id, and the selection handler.
 * @returns the strip element.
 */
export function Tabs(props: {
  readonly items: readonly TabItem[]
  readonly active: string
  readonly onSelect: (id: string) => void
}): ReactElement {
  return (
    <div className="evm-tabs" role="tablist">
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === props.active}
          className="evm-tab"
          onClick={() => props.onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Render a full-width message.
 *
 * @param props - the tone and the text.
 * @returns the message element.
 */
export function Banner(props: {
  readonly kind?: 'info' | 'warn' | 'danger' | undefined
  readonly children: ReactNode
}): ReactElement {
  const kind = props.kind ?? 'info'
  const suffix = kind === 'info' ? '' : ` evm-note-${kind}`
  return (
    <p className={`evm-note${suffix}`} role={kind === 'danger' ? 'alert' : undefined}>
      {props.children}
    </p>
  )
}

/**
 * Render a small pill, used for layers, statuses and tags.
 *
 * @param props - the tone and the text.
 * @returns the pill element.
 */
export function Chip(props: { readonly tone?: 'plain' | 'muted' | 'warn' | undefined; readonly children: ReactNode }): ReactElement {
  const tone = props.tone ?? 'plain'
  return <span className={`evm-chip evm-chip-${tone}`}>{props.children}</span>
}

/**
 * Render the placeholder shown when a list is empty.
 *
 * @param props - the text.
 * @returns the placeholder element.
 */
export function Empty(props: { readonly children: ReactNode }): ReactElement {
  return <p className="evm-empty">{props.children}</p>
}

