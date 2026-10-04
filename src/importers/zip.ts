/**
 * Minimal ZIP reader, for exports that arrive as an archive.
 *
 * Both ChatGPT and claude.ai email a `.zip`, and the file inside is the one that matters. Node has
 * no archive API, and the prior-art importer reaches for `fflate` to get one — a dependency this
 * plugin does not take, because a plugin that the host resolves bare specifiers for should not ship
 * a decompressor to read four files.
 *
 * So: find the end-of-central-directory record, walk the central directory, and inflate only the
 * entries the caller asked for. Extraction goes to a temporary directory rather than to memory,
 * which is the whole point — a ChatGPT `conversations.json` is hundreds of megabytes, and the
 * streaming reader in `json.ts` wants a file to walk, not a string to hold.
 *
 * ZIP64 is refused with a sentence rather than mis-parsed. An archive that large is somebody
 * else's problem to solve, and a wrong offset would look like a corrupt export.
 */

import { createReadStream, createWriteStream, mkdtempSync, readSync, openSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'

import { describe } from './fs.js'

/** One central-directory entry, reduced to what extraction needs. */
export interface ZipEntry {
  readonly name: string
  readonly method: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  /** Offset of the local file header. */
  readonly offset: number
}

/** What an extraction produced. */
export interface ZipExtraction {
  /** Extracted files, in archive order. */
  readonly files: readonly string[]
  /** Directory holding them; remove it when the import finishes. */
  readonly dir: string
  /** Entries in the archive, whether or not they were extracted. */
  readonly entries: number
  /** Entries skipped because the filter rejected them or a cap cut them off. */
  readonly skipped: number
  readonly errors: readonly string[]
  readonly truncated: boolean
}

/** Caps and filters for one extraction. */
export interface UnzipOptions {
  /** Only these entries are extracted. Called with the entry name. */
  readonly filter: (name: string) => boolean
  /** Maximum uncompressed bytes for one entry. */
  readonly maxBytes: number
  /** Maximum entries to extract. */
  readonly maxEntries: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_MARKER = 0xffffffff
const TAIL = 66 * 1024

/**
 * Is this file a ZIP archive?
 *
 * The extension is checked as well as the magic bytes, because an export is often renamed on its
 * way to the user, and a mislabelled archive should still be recognised.
 *
 * @param path - file to test.
 * @returns true when the file starts with a local file header or is named `.zip`.
 */
export function isZip(path: string): boolean {
  if (path.toLowerCase().endsWith('.zip')) return true
  try {
    const head = Buffer.alloc(4)
    const handle = openSync(path, 'r')
    try {
      if (readSync(handle, head, 0, 4, 0) < 4) return false
    } finally {
      closeSync(handle)
    }
    return head.readUInt32LE(0) === LOCAL_SIGNATURE
  } catch {
    return false
  }
}

/**
 * Read the central directory.
 *
 * @param path - archive to read.
 * @returns its entries, or an error string.
 */
export function listZip(path: string): { entries: readonly ZipEntry[] } | { error: string } {
  let size: number
  try {
    size = statSync(path).size
  } catch (error) {
    return { error: `cannot read ${path}: ${describe(error)}` }
  }
  let handle: number
  try {
    handle = openSync(path, 'r')
  } catch (error) {
    return { error: `cannot read ${path}: ${describe(error)}` }
  }
  try {
    const tailLength = Math.min(size, TAIL)
    const tail = Buffer.alloc(tailLength)
    readSync(handle, tail, 0, tailLength, size - tailLength)
    let eocd = -1
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
        eocd = index
        break
      }
    }
    if (eocd === -1) return { error: `${path} is not a ZIP archive (no end-of-directory record)` }
    const count = tail.readUInt16LE(eocd + 10)
    const centralSize = tail.readUInt32LE(eocd + 12)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || centralSize === ZIP64_MARKER || centralOffset === ZIP64_MARKER) {
      return { error: `${path} is a ZIP64 archive, which this importer does not read; unzip it and import the files directly` }
    }
    const central = Buffer.alloc(centralSize)
    readSync(handle, central, 0, centralSize, centralOffset)
    const entries: ZipEntry[] = []
    let cursor = 0
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break
      const method = central.readUInt16LE(cursor + 10)
      const compressedSize = central.readUInt32LE(cursor + 20)
      const uncompressedSize = central.readUInt32LE(cursor + 24)
      const nameLength = central.readUInt16LE(cursor + 28)
      const extraLength = central.readUInt16LE(cursor + 30)
      const commentLength = central.readUInt16LE(cursor + 32)
      const offset = central.readUInt32LE(cursor + 42)
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      cursor += 46 + nameLength + extraLength + commentLength
      if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || offset === ZIP64_MARKER) {
        return { error: `${path} is a ZIP64 archive, which this importer does not read; unzip it and import the files directly` }
      }
      entries.push({ name, method, compressedSize, uncompressedSize, offset })
    }
    return { entries }
  } catch (error) {
    return { error: `cannot read ${path}: ${describe(error)}` }
  } finally {
    closeSync(handle)
  }
}

/**
 * Read where an entry's data starts.
 *
 * @param handle - open archive handle.
 * @param entry - the entry.
 * @returns the byte offset of its first data byte.
 */
function dataOffset(handle: number, entry: ZipEntry): number {
  const header = Buffer.alloc(30)
  readSync(handle, header, 0, 30, entry.offset)
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error(`entry "${entry.name}" has no local header`)
  }
  return entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
}

/** Passes bytes through, refusing to exceed a cap. */
function limiter(max: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length
      if (seen > max) {
        callback(new Error(`entry is larger than ${max} bytes`))
        return
      }
      callback(null, chunk)
    },
  })
}

/**
 * Extract the entries a caller asks for into a fresh temporary directory.
 *
 * @param path - archive to read.
 * @param options - filter and caps.
 * @returns what was extracted, plus any errors.
 */
export async function extractZip(path: string, options: UnzipOptions): Promise<ZipExtraction> {
  const dir = mkdtempSync(join(tmpdir(), 'evermemory-import-'))
  const listed = listZip(path)
  if ('error' in listed) return { files: [], dir, entries: 0, skipped: 0, errors: [listed.error], truncated: false }

  const files: string[] = []
  const errors: string[] = []
  let skipped = 0
  let truncated = false

  for (const entry of listed.entries) {
    if (entry.name.endsWith('/')) continue
    if (!options.filter(entry.name)) {
      skipped += 1
      continue
    }
    if (files.length >= options.maxEntries) {
      truncated = true
      break
    }
    if (entry.uncompressedSize > options.maxBytes) {
      errors.push(`${basename(entry.name)} is ${describeSize(entry.uncompressedSize)}, over the per-file limit`)
      skipped += 1
      continue
    }
    if (entry.method !== 0 && entry.method !== 8) {
      errors.push(`${basename(entry.name)} uses compression method ${entry.method}, which this importer does not read`)
      skipped += 1
      continue
    }
    const target = join(dir, `${files.length}-${basename(entry.name).replace(/[^\w.-]+/gu, '_')}`)
    if (entry.compressedSize === 0) {
      // An empty entry has no data range to stream: `end` would land before `start` and Node would
      // refuse the range. Write the empty file the archive says it is.
      writeFileSync(target, '')
      files.push(target)
      continue
    }
    const handle = openSync(path, 'r')
    let start: number
    try {
      start = dataOffset(handle, entry)
    } catch (error) {
      errors.push(describe(error))
      skipped += 1
      continue
    } finally {
      closeSync(handle)
    }
    const source = createReadStream(path, { start, end: start + entry.compressedSize - 1 })
    const sink = createWriteStream(target)
    try {
      if (entry.method === 0) {
        await pipeline(source, limiter(options.maxBytes), sink)
      } else {
        await pipeline(source, createInflateRaw(), limiter(options.maxBytes), sink)
      }
      files.push(target)
    } catch (error) {
      errors.push(`${basename(entry.name)}: ${describe(error)}`)
      skipped += 1
      rmSync(target, { force: true })
    }
  }

  return { files, dir, entries: listed.entries.length, skipped, errors, truncated }
}

/**
 * Remove an extraction directory.
 *
 * @param dir - directory returned by {@link extractZip}.
 */
export function cleanZip(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A leftover temporary directory is not worth failing an import over.
  }
}

/** A size a person can read: megabytes once they matter, bytes while they do not. */
function describeSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`
  return `${bytes} bytes`
}
