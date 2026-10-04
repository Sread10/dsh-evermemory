/**
 * The import runner: from a path on disk to rows in the store.
 *
 * Everything the individual sources deliberately do not do happens here, in one place, so that no
 * source can invent its own policy:
 *
 * - **The quality gate and the merge decision are the ordinary ones.** An imported sentence goes
 *   through exactly the same `distillCandidates` call as a sentence mined from a live session, so
 *   an import cannot smuggle in an entry the user's own writing would have been refused.
 * - **The ledger decides what "already imported" means.** Items are hashed before any work is done
 *   and skipped wholesale, which is what lets a 40,000-item export be imported 500 items at a time
 *   without re-deciding the first 39,500 — and what stops a re-run from resurrecting an entry the
 *   user archived on purpose.
 * - **Imported entries are entries.** A ZCode note or a Claude memory section is taken whole; only
 *   transcript turns are mined for cue sentences, because a conversation is not a document.
 */

import type { MemoryScope, SourcePlatform } from '../constants.js'
import { appendDaily, isDayKey } from '../distill/daily.js'
import { classifyCandidate, extractCandidates, type Candidate } from '../distill/extract.js'
import { distillCandidates, type DistillContext } from '../distill/engine.js'
import type { MemoryRepository } from '../storage/repository.js'
import { DEFAULT_IMPORT_SCOPE, detect, supportedSources } from './detect.js'
import { expandHome, statSafe } from './fs.js'
import { itemHash, headline } from './text.js'
import { emptyScan, type ImportItem, type ScanOptions, type ScanResult, type SourceInput } from './types.js'
import { cleanZip, extractZip, isZip } from './zip.js'

/** What a caller asks for. */
export interface ImportRequest {
  /** Path the user named; `~` is expanded. */
  readonly path: string
  /** Layer for items whose source does not imply one. Defaults to global. */
  readonly scope?: 'global' | 'project'
  /** Extra tags for every imported entry. */
  readonly tags?: readonly string[]
  /** Decide everything, write nothing. */
  readonly dryRun?: boolean
  /** Ceiling for one entry, from `maxMemoryChars`. */
  readonly maxChars: number
  /** Project of the calling session, when it has one. */
  readonly projectKey?: string | null
  readonly projectPath?: string | null
  /** Caps; omitted keys take the defaults from {@link scanOptions}. */
  readonly limits?: Partial<ScanOptions>
}

/** One entry's fate, for the report. */
export interface ImportSample {
  readonly uri: string
  readonly text: string
  readonly decision: string
  readonly reason?: string
}

/** What happened. */
export interface ImportOutcome {
  readonly ok: boolean
  readonly path: string
  /** Source label, e.g. `ChatGPT export`. */
  readonly source: string
  readonly platform: SourcePlatform | null
  /** Items the source produced. */
  readonly scanned: number
  /** Items the run looked at, after caps. */
  readonly considered: number
  /** Items the source itself dropped for its own reasons. */
  readonly skipped: number
  /** Items the ledger recognised, so no work was done for them. */
  readonly known: number
  /** Items whose text was over `maxChars`. */
  readonly oversized: number
  readonly written: number
  readonly merged: number
  readonly updated: number
  readonly ignored: number
  readonly rejected: number
  /** Daily-log entries appended. */
  readonly logged: number
  readonly dryRun: boolean
  readonly truncated: boolean
  readonly errors: readonly string[]
  readonly samples: readonly ImportSample[]
}

/** How many outcomes the report quotes. */
const SAMPLE_LIMIT = 6

/** Ledger lookups are batched, because SQLite takes a bounded number of bound variables. */
const HASH_BATCH = 400

/**
 * Import a path into the store.
 *
 * @param repository - open repository.
 * @param request - what to import and how.
 * @returns a report; failures are reported, never thrown.
 */
export async function runImport(repository: MemoryRepository, request: ImportRequest): Promise<ImportOutcome> {
  const requested = expandHome(request.path)
  if (statSafe(requested) === undefined) {
    return failure(requested, `nothing at ${requested}`)
  }

  const limits: ScanOptions = { maxItems: 500, maxFiles: 200, maxBytes: 64 * 1024 * 1024, ...request.limits }
  let scan: ScanResult
  let target = requested

  if (isZip(requested)) {
    const extracted = await extractZip(requested, {
      filter: interestingEntry,
      maxBytes: limits.maxBytes,
      maxEntries: limits.maxFiles,
    })
    try {
      if (extracted.files.length === 0) {
        return failure(requested, `the archive held no conversation export (${extracted.errors.join('; ') || 'no readable entries'})`)
      }
      target = extracted.dir
      scan = scanPath({ path: target, directory: true }, limits)
      scan = { ...scan, errors: [...extracted.errors, ...scan.errors], skipped: scan.skipped + extracted.skipped, truncated: scan.truncated || extracted.truncated }
    } finally {
      cleanZip(extracted.dir)
    }
  } else {
    const entry = statSafe(requested)
    scan = scanPath({ path: requested, directory: entry?.directory === true }, limits)
  }

  return applyScan(repository, requested, scan, request, limits.maxItems)
}

/**
 * Import already-scanned items.
 *
 * Separate from {@link runImport} so tests can drive the store half with literal items and never
 * touch the filesystem, which is what keeps a failure here a policy failure rather than a parsing
 * one.
 *
 * @param repository - open repository.
 * @param path - what to report as the origin.
 * @param scan - items to import.
 * @param request - scope, tags and caps.
 * @param cap - maximum items to consider.
 * @returns a report.
 */
export function applyScan(
  repository: MemoryRepository,
  path: string,
  scan: ScanResult,
  request: ImportRequest,
  cap: number,
): ImportOutcome {
  const scope: 'global' | 'project' = request.scope ?? DEFAULT_IMPORT_SCOPE
  const tags = request.tags ?? []
  const considered = scan.items.slice(0, cap)
  const errors = [...scan.errors]
  const samples: ImportSample[] = []
  let known = 0
  let oversized = 0
  let written = 0
  let merged = 0
  let updated = 0
  let ignored = 0
  let rejected = 0
  let logged = 0

  const hashes = considered.map((item) => itemHash(scan.source, item))
  const seen = knownHashes(repository, hashes)

  for (const [index, item] of considered.entries()) {
    const hash = hashes[index] ?? ''
    if (seen.has(hash)) {
      known += 1
      continue
    }

    if (item.text.length > request.maxChars) {
      oversized += 1
      push(samples, { uri: item.uri, text: item.text, decision: 'rejected', reason: `longer than ${request.maxChars} characters` })
      continue
    }

    const layer = layerFor(item.scope, scope)
    if (layer === 'daily') {
      const date = dailyKey(item)
      const result = request.dryRun === true ? { id: 1 } : appendDaily(repository, [{ text: item.text }], { date, projectKey: request.projectKey ?? null })
      if (result === undefined && request.dryRun !== true) {
        push(samples, { uri: item.uri, text: item.text, decision: 'rejected', reason: 'the daily log refused the entry' })
        continue
      }
      logged += 1
      if (request.dryRun !== true && result !== undefined) repository.recordImport(hash, result.id)
      push(samples, { uri: item.uri, text: item.text, decision: 'logged' })
      continue
    }

    for (const candidate of candidatesFor(item)) {
      const context: DistillContext = {
        repository,
        projectKey: request.projectKey ?? null,
        hasProject: request.projectKey !== null && request.projectKey !== undefined,
        source: 'import',
        dryRun: request.dryRun === true,
        carry: {
          scope: layer,
          sourcePlatform: scan.source,
          tags: [...tags, ...(item.tags ?? [])],
          ...(item.title === undefined || item.title === '' ? {} : { title: item.title }),
          projectPath: request.projectPath ?? null,
        },
      }
      const report = distillCandidates([candidate], context)
      const outcome = report.outcomes[0]
      if (outcome === undefined) continue

      switch (outcome.decision) {
        case 'new':
          written += 1
          break
        case 'merge':
          merged += 1
          break
        case 'update':
          updated += 1
          break
        case 'ignore':
          ignored += 1
          break
        default:
          rejected += 1
          break
      }

      const record = outcome.applied?.record
      if (request.dryRun !== true && outcome.decision !== 'rejected') {
        repository.recordImport(hash, record?.id ?? null)
      }
      push(samples, {
        uri: item.uri,
        text: candidate.text,
        decision: outcome.decision,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      })
    }
  }

  if (scan.items.length === 0 && errors.length === 0) errors.push(`nothing importable at ${path}`)

  return {
    ok: errors.length === 0 || written + merged + updated + ignored + logged > 0,
    path,
    source: scan.label,
    platform: scan.source,
    scanned: scan.items.length,
    considered: considered.length,
    skipped: scan.skipped,
    known,
    oversized,
    written,
    merged,
    updated,
    ignored,
    rejected,
    logged,
    dryRun: request.dryRun === true,
    truncated: scan.truncated || scan.items.length > considered.length,
    errors,
    samples,
  }
}

/** Run detection then the source. */
function scanPath(input: SourceInput, limits: ScanOptions): ScanResult {
  const detected = detect(input)
  if (detected === undefined) {
    return emptyScan(null, 'unknown', [`${input.path} is not an export this importer recognises. It reads ${supportedSources()}.`])
  }
  return detected.scan(detected.input, limits)
}

/**
 * Which layer an item lands in.
 *
 * The identity layer is never written by an import. That layer is a file the user hand-edits and
 * the database only indexes it, so an import that wrote there would either be overwritten by the
 * file on the next read or would silently become the source of truth for who the user is. An
 * identity entry in one of our own exports therefore arrives as a global entry instead.
 *
 * @param fromSource - what the source claimed.
 * @param fallback - the run's default layer.
 * @returns the layer to write to.
 */
function layerFor(fromSource: MemoryScope | undefined, fallback: 'global' | 'project'): 'global' | 'project' | 'daily' {
  if (fromSource === undefined || fromSource === 'identity') return fallback
  return fromSource
}
/** Mine a transcript turn, or take a document entry whole. */
function candidatesFor(item: ImportItem): readonly Candidate[] {
  if (item.kind === 'utterance') return extractCandidates(item.text, 16)
  const candidate = classifyCandidate(item.text)
  return candidate.text === '' ? [] : [{ ...candidate, ...(item.title === undefined || item.title === '' ? {} : {}) }]
}

/** The day key for a daily item, preferring the source's own title. */
function dailyKey(item: ImportItem): string {
  const title = item.title ?? ''
  return isDayKey(title) ? title : (item.at ?? '').slice(0, 10)
}

/** Look up hashes in ledger-sized batches. */
function knownHashes(repository: MemoryRepository, hashes: readonly string[]): Set<string> {
  const known = new Set<string>()
  for (let index = 0; index < hashes.length; index += HASH_BATCH) {
    for (const hash of repository.knownHashes(hashes.slice(index, index + HASH_BATCH))) known.add(hash)
  }
  return known
}

/** Keep the report's sample list short and varied. */
function push(samples: ImportSample[], sample: ImportSample): void {
  if (samples.length < SAMPLE_LIMIT) samples.push({ ...sample, text: headline(sample.text, 120) })
}

/** An outcome for a path that could not be used at all. */
function failure(path: string, message: string): ImportOutcome {
  return {
    ok: false,
    path,
    source: 'unknown',
    platform: null,
    scanned: 0,
    considered: 0,
    skipped: 0,
    known: 0,
    oversized: 0,
    written: 0,
    merged: 0,
    updated: 0,
    ignored: 0,
    rejected: 0,
    logged: 0,
    dryRun: false,
    truncated: false,
    errors: [message],
    samples: [],
  }
}

/**
 * Is this archive entry worth extracting?
 *
 * Almost everything in an export is not: ChatGPT ships a `user.json`, an HTML renderer and a
 * conversation list for its own UI. Naming the three shapes that matter keeps the extraction small
 * and the temporary directory honest.
 *
 * @param name - entry name inside the archive.
 * @returns true when the importer should extract it.
 */
export function interestingEntry(name: string): boolean {
  const base = name.split('/').pop()?.toLowerCase() ?? name
  if (base === 'memories.json') return true
  if (base.startsWith('conversations') && base.endsWith('.json')) return true
  return base.endsWith('.jsonl')
}
