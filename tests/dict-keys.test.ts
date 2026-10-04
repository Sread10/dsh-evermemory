/**
 * Every string the settings page asks for exists in both dictionaries.
 *
 * The failure this guards against is quiet: `translatorOf` falls back to the key itself, so a
 * missing translation renders as `mem.list.empty` in the middle of a page instead of throwing. The
 * only cheap moment to catch that is here — the sources are read as text, which also keeps the
 * browser half out of this project's TypeScript program (it is excluded from the host tsconfig and
 * compiled separately).
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const clientDir = join(repo, 'src', 'client')

/** Every `key: value` pair of one dictionary literal. */
function keysOf(source: string, start: string, end?: string): string[] {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `dictionary ${start} not found`)
  const to = end === undefined ? source.length : source.indexOf(end, from)
  const body = source.slice(from, to < 0 ? source.length : to)
  return [...body.matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1] ?? '')
}

/** Keys the panel sources ask for: `t('some.key')` with a literal. */
function requestedKeys(): Set<string> {
  const keys = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      const source = readFileSync(full, 'utf8')
      for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z][\w.-]*)'/g)) keys.add(match[1] ?? '')
    }
  }
  walk(clientDir)
  return keys
}

describe('the client dictionaries', () => {
  const dict = readFileSync(join(clientDir, 'dict.ts'), 'utf8')
  const zh = keysOf(dict, 'export const ZH', 'export const EN')
  const en = keysOf(dict, 'export const EN')

  test('both languages define the same keys', () => {
    assert.ok(zh.length > 50, `only ${String(zh.length)} Chinese keys`)
    const missingInEn = zh.filter((key) => !en.includes(key))
    const missingInZh = en.filter((key) => !zh.includes(key))
    assert.deepEqual(missingInEn, [], 'keys with no English string')
    assert.deepEqual(missingInZh, [], 'keys with no Chinese string')
  })

  test('every switch key names a volatile Config field, and every field has a switch', () => {
    // The switches are generated from the volatile fields, so this is a two-way check: a field
    // without a label would render as `toggle.somethingNew`, and a label without a field is a row
    // that can never appear.
    const config = readFileSync(join(repo, 'src', 'config.ts'), 'utf8')
    const fields = config
      .split(/\r?\n/)
      .map((line) => /^\s*(\w+):\s*z\.boolean\(\).*\.volatile\(\),?\s*$/u.exec(line)?.[1])
      .filter((field): field is string => field !== undefined)
    assert.ok(fields.length >= 9, `found ${String(fields.length)} volatile boolean fields in config.ts`)

    const toggles = zh.filter((key) => key.startsWith('toggle.') && !key.endsWith('.desc'))
    assert.deepEqual([...toggles].sort(), [...fields].sort().map((field) => `toggle.${field}`))
    for (const field of fields) {
      assert.ok(zh.includes(`toggle.${field}.desc`), `toggle.${field}.desc is missing`)
      assert.ok(en.includes(`toggle.${field}.desc`), `toggle.${field}.desc has no English string`)
    }
  })

  test('every key the panel asks for is translated', () => {
    const requested = requestedKeys()
    assert.ok(requested.size > 30, `only ${String(requested.size)} keys referenced from the panels`)
    const missing = [...requested].filter((key) => !zh.includes(key)).sort()
    assert.deepEqual(missing, [], 'keys used by the page but absent from dict.ts')
  })
})
