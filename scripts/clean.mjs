/**
 * Build-output housekeeping.
 *
 * Run as `node scripts/clean.mjs` before a build, or `node scripts/clean.mjs --post` to drop
 * the incremental build metadata tsc leaves behind. The `build`, `types` and `prepack`
 * scripts all call it, so no path into a publish can ship a stale or generated file.
 *
 * The metadata is deliberately kept at `.tsbuildinfo/` in the project root rather than under
 * `lib/types/`: everything under `lib/` is published, and a `.tsbuildinfo` is
 * machine-specific noise. Removing it after the fact is not a substitute — `npm pack` runs
 * `prepack`, which re-runs `types`, which writes the files straight back.
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const libUrl = new URL('../lib', import.meta.url)
const buildInfoUrl = new URL('../.tsbuildinfo', import.meta.url)
const post = process.argv.includes('--post')

/**
 * Delete every `*.tsbuildinfo` at or below `directory`.
 *
 * @param directory - absolute path to walk.
 * @returns how many files were removed.
 */
function removeBuildInfo(directory) {
  let removed = 0
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return removed
  }

  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) removed += removeBuildInfo(full)
    else if (entry.name.endsWith('.tsbuildinfo')) {
      rmSync(full, { force: true })
      removed += 1
    }
  }
  return removed
}

if (post) {
  // Both locations: the root one is where tsc writes today, and the sweep under lib/ catches
  // a stray file from an older checkout.
  const removed = removeBuildInfo(fileURLToPath(buildInfoUrl)) + removeBuildInfo(fileURLToPath(libUrl))
  process.stdout.write(`clean: removed ${removed} build-info file(s)\n`)
} else {
  rmSync(libUrl, { recursive: true, force: true })
  rmSync(buildInfoUrl, { recursive: true, force: true })
  // `statSync` only confirms the directory is gone; the existence check keeps the message
  // honest if a future change makes removal conditional.
  process.stdout.write(`clean: lib/ ${statSync(libUrl, { throwIfNoEntry: false }) === undefined ? 'removed' : 'still present'}\n`)
}
