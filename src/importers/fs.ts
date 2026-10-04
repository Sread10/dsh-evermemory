/**
 * Filesystem helpers for the import sources.
 *
 * Nothing here throws. An import runs inside a tool call, and a user who types a path that does
 * not exist needs a sentence back, not a stack trace — so every reader returns either a value or
 * an error string, and every caller is forced to decide what to say.
 *
 * Reads are capped: an export file can be hundreds of megabytes, and this plugin's job is to
 * mine sentences out of it, never to hold it all in memory at once.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** One directory entry, with the few facts the sources care about. */
export interface Entry {
  readonly name: string
  readonly path: string
  readonly directory: boolean
  readonly size: number
  readonly modified: number
}

/** A read that either produced text or explained itself. */
export type ReadResult = { readonly ok: true; readonly text: string; readonly truncated: boolean } | { readonly ok: false; readonly error: string }

/** A parse that either produced a value or explained itself. */
export type JsonResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }

/**
 * Expand a leading `~` against the current user's home.
 *
 * Users type `~/.zcode/cli/memories` because that is how the path is documented, and the shell
 * that would normally expand it is not in the loop by the time the path reaches a tool argument.
 *
 * @param path - path that may start with `~`.
 * @returns an absolute path.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : join(process.cwd(), path)
}

/**
 * Stat a path without throwing.
 *
 * @param path - path to inspect.
 * @returns the entry, or undefined when it does not exist or cannot be read.
 */
export function statSafe(path: string): Entry | undefined {
  try {
    const stats = statSync(path)
    const name = path.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? path
    return {
      name,
      path,
      directory: stats.isDirectory(),
      size: stats.isFile() ? stats.size : 0,
      modified: stats.mtimeMs,
    }
  } catch {
    return undefined
  }
}

/**
 * Test for a directory.
 *
 * @param path - path to test.
 * @returns true when it is a readable directory.
 */
export function isDirectory(path: string): boolean {
  return statSafe(path)?.directory === true
}

/**
 * Test for a regular file.
 *
 * @param path - path to test.
 * @returns true when it is a readable file.
 */
export function isFile(path: string): boolean {
  const entry = statSafe(path)
  return entry !== undefined && !entry.directory
}

/**
 * List a directory, newest first, without throwing.
 *
 * Newest first because every capped scan wants the most recent material, and a caller that wants
 * the whole directory is unaffected by the order.
 *
 * @param path - directory to list.
 * @returns entries, or an empty list when the directory cannot be read.
 */
export function listDir(path: string): readonly Entry[] {
  let names: string[]
  try {
    names = readdirSync(path)
  } catch {
    return []
  }
  const entries: Entry[] = []
  for (const name of names) {
    const entry = statSafe(join(path, name))
    if (entry) entries.push(entry)
  }
  return entries.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name))
}

/**
 * List only the files under a directory, newest first.
 *
 * @param path - directory to list.
 * @param suffix - optional lowercase extension filter, e.g. `.jsonl`.
 * @returns matching files.
 */
export function listFiles(path: string, suffix?: string): readonly Entry[] {
  return listDir(path).filter(
    (entry) => !entry.directory && (suffix === undefined || entry.name.toLowerCase().endsWith(suffix)),
  )
}

/**
 * Read a text file, up to a byte cap.
 *
 * The cap is enforced by reading one byte past it, so a caller can distinguish "this is the whole
 * file" from "there is more" — which is the difference between a complete import and one the user
 * has to run again.
 *
 * @param path - file to read.
 * @param maxBytes - maximum bytes to read.
 * @returns the text and whether it was cut, or an error string.
 */
export function readText(path: string, maxBytes: number): ReadResult {
  const entry = statSafe(path)
  if (!entry) return { ok: false, error: `cannot read ${path}` }
  if (entry.directory) return { ok: false, error: `${path} is a directory` }
  let handle: number | undefined
  try {
    handle = openSync(path, 'r')
    const wanted = Math.min(entry.size, maxBytes + 1)
    const buffer = Buffer.allocUnsafe(wanted)
    let filled = 0
    while (filled < wanted) {
      const read = readSync(handle, buffer, filled, wanted - filled, filled)
      if (read <= 0) break
      filled += read
    }
    const truncated = entry.size > maxBytes
    return { ok: true, text: buffer.subarray(0, Math.min(filled, maxBytes)).toString('utf8'), truncated }
  } catch (error) {
    return { ok: false, error: `cannot read ${path}: ${describe(error)}` }
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

/**
 * Read and parse a JSON file.
 *
 * @param path - file to read.
 * @param maxBytes - maximum bytes to read.
 * @returns the parsed value, or an error string.
 */
export function readJson(path: string, maxBytes: number): JsonResult {
  const text = readText(path, maxBytes)
  if (!text.ok) return text
  try {
    return { ok: true, value: JSON.parse(text.text) }
  } catch (error) {
    return { ok: false, error: `${path} is not valid JSON: ${describe(error)}` }
  }
}

/**
 * Does the path exist at all?
 *
 * @param path - path to test.
 * @returns true when it exists.
 */
export function exists(path: string): boolean {
  return existsSync(path)
}

/**
 * Render an unknown thrown value as one line.
 *
 * @param error - the caught value.
 * @returns a message with no newlines.
 */
export function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/gu, ' ').trim()
}
