/**
 * Shapes shared by every import source.
 *
 * A source's whole job is to turn somebody else's file into a list of `ImportItem`s. It does not
 * decide layers, does not touch the database, and does not judge whether an item is a memory —
 * `src/importers/run.ts` owns all three, so a new source cannot quietly invent its own policy.
 */

import type { MemoryScope, SourcePlatform } from '../constants.js'

/** One candidate memory recovered from an external store. */
export interface ImportItem {
  /** The sentence or entry itself, already trimmed. */
  readonly text: string
  /** Where it came from, for the report: `<file>` or `<file>#<conversation>`. */
  readonly uri: string
  /**
   * Stable identity from the source, when the source has one.
   *
   * Used only to build the ledger hash — the same identity twice in one export must import once.
   * When absent the normalised text stands in, which is the right fallback: two identical
   * statements are one memory no matter where they were found.
   */
  readonly itemId?: string
  /** A title the source already carries (a ZCode `name:`, a Markdown heading). */
  readonly title?: string
  /** Provenance tags the source implies, e.g. `workbuddy:alpha`. */
  readonly tags?: readonly string[]
  /**
   * The layer the source itself implies.
   *
   * Absent means "whatever the run defaults to". A source that knows its material is
   * project-scoped sets `'project'`; the run then files it into the *calling session's* project,
   * because an imported `~/.claude/projects/<slug>` cannot be mapped onto our project keys.
   */
  readonly scope?: MemoryScope
  /** When the source recorded it, ISO-8601. */
  readonly at?: string
  /**
   * What the text is.
   *
   * `'entry'` (the default) is already a memory — a ZCode note, a Claude memory section, a line of
   * somebody's Markdown — and is taken whole. `'utterance'` is one turn of a conversation, which is
   * not a memory but may contain one, so the runner mines it for cue sentences instead. Getting this
   * wrong in either direction is expensive: taking a turn whole stores "好的，我明白了" forever, and
   * mining a note throws away everything the note said.
   */
  readonly kind?: 'entry' | 'utterance'
}

/** What a source produced, including what it could not read. */
export interface ScanResult {
  /** Platform this scan's items belong to, or `null` for a plain Markdown/JSONL file. */
  readonly source: SourcePlatform | null
  /** Short human label for the report, e.g. `ChatGPT 导出`. */
  readonly label: string
  readonly items: readonly ImportItem[]
  /** Files actually opened. */
  readonly files: number
  /** Items the source recognised and deliberately dropped, with the reason in `notes`. */
  readonly skipped: number
  /** Non-fatal problems, already formatted for the user. */
  readonly errors: readonly string[]
  /** True when a cap cut the scan short, so the report can say "run it again". */
  readonly truncated: boolean
}

export interface ScanOptions {
  /** Maximum items to collect before stopping. */
  readonly maxItems: number
  /** Maximum files to open. */
  readonly maxFiles: number
  /** Maximum bytes read from any one file. */
  readonly maxBytes: number
}

/** What a source is pointed at. */
export interface SourceInput {
  /** Absolute path to the file or directory the user named. */
  readonly path: string
  /** True when `path` is a directory. */
  readonly directory: boolean
}

/** The signature every source module implements. */
export type Scan = (input: SourceInput, options: ScanOptions) => ScanResult

/** A scan that produced nothing, used for early returns and for error paths. */
export function emptyScan(
  source: SourcePlatform | null,
  label: string,
  errors: readonly string[] = [],
  files = 0,
): ScanResult {
  return { source, label, items: [], files, skipped: 0, errors, truncated: false }
}
