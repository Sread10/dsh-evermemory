/**
 * Loading the behavioural rules that go into the prompt head.
 *
 * Two levels, merged: `$DSH_HOME/rules/*.md` is global, `<cwd>/.dsh/rules/*.md` belongs to the
 * project. Project rules are placed FIRST in the rendered text, because a model reading a list
 * of instructions is more reliably governed by the ones it read first when two of them conflict,
 * and the user's project-level rule is the more specific intent.
 *
 * Why `.md` rather than any file: the rules channel is the one thing in this plugin whose content
 * reaches the model verbatim and unescaped, so it is also the one that can be edited by anything
 * that can write to the filesystem — including, in a shared repository, a `git pull`. Restricting
 * the extension keeps a stray binary or a `.env` from being pasted into the system prompt. It is
 * a hygiene measure, not a security boundary: a repository that wants to inject instructions into
 * your model can do so with a `.md` file too, and that is inherent to reading a repo's rules.
 *
 * Reads are synchronous because the section callback is synchronous. The content is cached by
 * path and mtime, so the cost is one `statSync` per file per call after the first — and the
 * result feeds a section whose rendered text is then deduplicated by the host, meaning an
 * unchanged rule set costs the prefix cache nothing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/** Extension a file must have to be treated as a rule. */
export const RULE_EXTENSION = '.md'

/** Directory name for rules, under both `$DSH_HOME` and `<project>/.dsh`. */
export const RULES_DIR_NAME = 'rules'

/** Header used when the rendered rules are non-empty. */
export const RULES_HEADER = '## 行为引导规则（用户编写，优先级高于你的默认习惯）'

/** Where the rules came from. */
export interface RuleFile {
  /** Absolute path. */
  readonly path: string
  /** Display path, with the home directory abbreviated. */
  readonly display: string
  /** The file's text, trimmed. */
  readonly text: string
  /** `project` rules are rendered first. */
  readonly scope: 'global' | 'project'
  /** Short label for the file, used as a sub-heading when several files are present. */
  readonly label: string
}

/** Everything the section needs to render. */
export interface RuleSet {
  readonly files: readonly RuleFile[]
  /**
   * The merged rule text, or `''` when there is nothing to inject.
   *
   * Empty means "do not inject at all" rather than "inject a header with no rules": a header
   * announcing rules that are not there is a false statement in the system prompt.
   */
  readonly text: string
  /** A source failed to read. Surfaced in the panel; never thrown, the prompt still assembles. */
  readonly degraded: boolean
}

/** Inputs, all overridable so tests do not need a real home directory. */
export interface LoadRuleOptions {
  /** Project root. Rules are read from `<cwd>/.dsh/rules`. */
  readonly cwd?: string | undefined
  /** `$DSH_HOME`. Rules are read from `<dshHome>/rules`. */
  readonly dshHome?: string | undefined
  /** Additional rule directories, highest priority last. From the config. */
  readonly extraDirs?: readonly string[] | undefined
  /** Include the global level. `false` leaves project rules only. */
  readonly includeGlobal?: boolean | undefined
}

/**
 * Cache entry, keyed by absolute path and invalidated by mtime AND size.
 *
 * Size is part of the key because mtime alone is not enough: filesystem timestamps on Windows
 * have a coarser resolution than the write itself, so an editor that saves twice inside the same
 * tick leaves the mtime identical. Adding the byte count catches every edit that changes the
 * length, which is nearly all of them, and costs nothing — `statSync` already returned it.
 */
interface CacheEntry {
  readonly mtimeMs: number
  readonly size: number
  readonly text: string
}

const cache = new Map<string, CacheEntry>()

/** Clear the read cache. Tests depend on this; a long-running host does not need it. */
export function resetRuleCache(): void {
  cache.clear()
}

/**
 * Sort rule files naturally: `10-style.md` before `2-style.md` is *not* what a user means, so
 * numeric runs compare as numbers. Falls back to a locale comparison for everything else.
 */
export function compareRuleNames(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })
}

/** The project-level rules directory. */
export function projectRulesDir(cwd: string): string {
  return join(cwd, '.dsh', RULES_DIR_NAME)
}

/** The global rules directory. */
export function globalRulesDir(dshHome: string): string {
  return join(dshHome, RULES_DIR_NAME)
}

function readRuleFile(path: string, scope: 'global' | 'project', display: string): RuleFile | undefined {
  let mtimeMs: number
  let size: number
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    mtimeMs = stat.mtimeMs
    size = stat.size
  } catch {
    // Absent is the normal case for the first run, not an error.
    return undefined
  }
  // A rule file past this size is not a rule, it is a document. Reading it would spend the whole
  // prompt budget on one file and silently displace every other rule.
  if (size > MAX_RULE_FILE_BYTES) return undefined

  const cached = cache.get(path)
  const fresh = cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size
  const text = fresh ? cached.text : readText(path)
  if (text === undefined) return undefined
  if (!fresh) cache.set(path, { mtimeMs, size, text })

  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return {
    path,
    display,
    text: trimmed,
    scope,
    label: basenameWithoutExtension(path),
  }
}

/** A rule file larger than this is skipped rather than injected. */
export const MAX_RULE_FILE_BYTES = 32 * 1024

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function basenameWithoutExtension(path: string): string {
  const name = basename(path)
  return name.endsWith(RULE_EXTENSION) ? name.slice(0, -RULE_EXTENSION.length) : name
}

/** List the `.md` files in a directory, sorted. A missing directory yields `[]`. */
export function listRuleFiles(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.toLowerCase().endsWith(RULE_EXTENSION) && !name.startsWith('.'))
    .sort(compareRuleNames)
    .map((name) => join(dir, name))
}

function loadDir(dir: string, scope: 'global' | 'project', home: string | undefined): RuleFile[] {
  const files = new Array<RuleFile>()
  for (const path of listRuleFiles(dir)) {
    const absolute = resolve(path)
    const file = readRuleFile(absolute, scope, displayPath(absolute, home))
    if (file !== undefined) files.push(file)
  }
  return files
}

/** Abbreviate the home directory, matching how storage paths are displayed. */
export function displayPath(absolute: string, dshHome: string | undefined): string {
  if (dshHome === undefined || dshHome === '') return absolute
  const home = resolve(dshHome)
  return absolute.startsWith(home) ? `~${absolute.slice(home.length)}` : absolute
}

/**
 * Read and merge the rules.
 *
 * Never throws: a rule file that cannot be read degrades to "that file is missing", and the
 * system prompt still assembles. The alternative — propagating the error — would take down the
 * prompt for every agent in the session because one file in one project was unreadable.
 */
export function loadRules(options: LoadRuleOptions = {}): RuleSet {
  const files = new Array<RuleFile>()
  let degraded = false

  const extra = options.extraDirs ?? []
  for (const dir of extra) {
    if (dir.trim() === '') continue
    const absolute = resolve(dir)
    const found = loadDir(absolute, 'project', options.dshHome)
    if (found.length === 0) degraded = degraded || directoryUnreadable(absolute)
    files.push(...found)
  }

  if (options.cwd !== undefined && options.cwd !== '') {
    files.push(...loadDir(projectRulesDir(resolve(options.cwd)), 'project', options.dshHome))
  }

  if (options.includeGlobal !== false && options.dshHome !== undefined && options.dshHome !== '') {
    files.push(...loadDir(globalRulesDir(resolve(options.dshHome)), 'global', options.dshHome))
  }

  if (files.length === 0) return { files, text: '', degraded }

  // Project rules first. The merge is a concatenation rather than an override because a rule the
  // user wrote globally does not stop applying in a project that has its own rules; only an
  // explicit contradiction between the two is resolved, and it is resolved by reading order.
  const ordered = [...files].sort((a, b) => rank(a) - rank(b))

  const blocks = ordered.map((file) => {
    const heading = ordered.length > 1 ? `### 规则：${file.label}\n` : ''
    return `${heading}${file.text}`
  })

  return { files: ordered, text: `${RULES_HEADER}\n\n${blocks.join('\n\n')}`, degraded }
}

function rank(file: RuleFile): number {
  return file.scope === 'project' ? 0 : 1
}

function directoryUnreadable(dir: string): boolean {
  try {
    statSync(dir)
    return false
  } catch {
    return true
  }
}
