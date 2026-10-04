/**
 * Probe: import a real store on this machine into a throwaway database.
 *
 * The unit tests build their own fixtures, which means they can only prove the parsers agree with
 * what I BELIEVE the formats are. This runs against files the user's tools actually wrote, which is
 * the only way to find out whether that belief was right — it is how the WorkBuddy layout
 * (`~/.workbuddy/memory/<workspace-id>_memory.md`, with a JSON trailer duplicating the whole block)
 * was caught. Read-only with respect to the sources: everything it writes goes to a temp file.
 *
 * Usage:
 *   node --import ./scripts/peer-hooks.mjs --experimental-transform-types scripts/probe-import.ts <path> [scope]
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runImport } from '../src/importers/run.ts'
import { openStore } from '../src/storage/db.ts'
import { MemoryRepository } from '../src/storage/repository.ts'

const target = process.argv[2]
const scope = process.argv[3] === 'project' ? ('project' as const) : ('global' as const)

if (target === undefined) {
  process.stderr.write('usage: probe-import.ts <path> [global|project]\n')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'evm-probe-'))
const store = await openStore({ path: join(dir, 'probe.sqlite') })
const repository = new MemoryRepository(store.db)

try {
  const outcome = await runImport(repository, { path: target, scope, maxChars: 8000 })

  process.stdout.write(`source      ${outcome.source} (${outcome.platform ?? 'no platform'})\n`)
  process.stdout.write(`scanned     ${outcome.scanned} item(s) from ${outcome.source === '' ? '?' : ''}files\n`)
  process.stdout.write(
    `considered  ${outcome.considered} · known ${outcome.known} · oversized ${outcome.oversized} · truncated ${outcome.truncated}\n`,
  )
  process.stdout.write(
    `decisions   new ${outcome.written} · merged ${outcome.merged} · updated ${outcome.updated} · ignored ${outcome.ignored} · rejected ${outcome.rejected} · logged ${outcome.logged}\n`,
  )
  for (const error of outcome.errors) process.stdout.write(`error       ${error}\n`)
  for (const sample of outcome.samples) {
    process.stdout.write(`sample      [${sample.decision}] ${sample.text.slice(0, 100)}${sample.reason === undefined ? '' : ` (${sample.reason})`}\n`)
  }

  const rows = repository.list({ scope: ['global', 'project', 'daily'], limit: 200 })
  process.stdout.write(`\nstored ${rows.length} row(s)\n`)
  for (const row of rows.slice(0, 12)) {
    process.stdout.write(`  ${String(row.id).padStart(4)} [${row.scope}/${row.sourcePlatform ?? '-'}] ${row.title.slice(0, 90)}\n`)
  }
} finally {
  store.db.close()
  rmSync(dir, { recursive: true, force: true })
}
