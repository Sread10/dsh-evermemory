/**
 * The packaging contract.
 *
 * Three identifiers have to agree or the plugin silently fails to mount, and all three
 * failures look different from each other:
 *
 *   - `insert.id` ≠ the exported cordis `name`  → the Loader mounts an entry whose name
 *     resolves to nothing, and (because the entry id is also the settings namespace) the
 *     preferences form appears under a namespace no plugin claims.
 *   - `insert.name` ≠ the package name          → `dsh plugin add` records a dependency
 *     whose row can never resolve to a module.
 *   - version drift between `version.ts` and `package.json` → the settings page reports a
 *     version that does not match the installed package, which is a support nightmare.
 *
 * These are text-level assertions on purpose: they are checking the files a human edits,
 * not the behaviour those files produce.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)

/** @param relative - path from the package root. @returns the file's text. */
function read(relative: string): string {
  return readFileSync(new URL(relative, root), 'utf8')
}

const pkg = JSON.parse(read('package.json')) as {
  name: string
  version: string
  engines: { node: string; dsh?: string }
  dsh: {
    manifestVersion: number
    bundle: { patch: string }
    client: { platform: string; inject?: string[] }
  }
}

/**
 * Strings only React's own source contains.
 *
 * The marker for "React was bundled" cannot be the word `react`: the distillation marker list
 * legitimately holds the framework names a project might build with, so the word appears in a
 * correct host artifact. These strings cannot appear there any other way.
 */
const REACT_INTERNALS = ['ReactCurrentOwner', '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED']

/** First capture group of `pattern` in `text`. @returns the capture, or undefined. */
function firstGroup(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1]
}

test('insert.id matches the exported cordis plugin name', () => {
  const patch = read('cordis.patch.yml')
  const id = firstGroup(patch, /^\s*-?\s*id:\s*(\S+)\s*$/m)
  const pluginName = firstGroup(read('src/constants.ts'), /export const PLUGIN_NAME = '([^']+)'/)

  assert.ok(id !== undefined, 'cordis.patch.yml has no insert id')
  assert.ok(pluginName !== undefined, 'src/constants.ts has no PLUGIN_NAME')
  assert.equal(id, pluginName, 'cordis.patch.yml insert.id must equal the exported cordis name')
})

test('insert.name is the package name', () => {
  const patch = read('cordis.patch.yml')
  const name = firstGroup(patch, /^\s*-?\s*name:\s*(\S+)\s*$/m)

  assert.equal(name, pkg.name, 'cordis.patch.yml insert.name must be the package name')
})

test('the exported name equals PLUGIN_NAME', () => {
  // `apply` re-exports the constant, so this catches an edit that changes one and not the
  // other without touching cordis.patch.yml.
  assert.match(read('src/index.ts'), /export const name = PLUGIN_NAME/)
})

test('version.ts and package.json agree', () => {
  const version = firstGroup(read('src/version.ts'), /export const VERSION = '([^']+)'/)

  assert.equal(version, pkg.version, 'src/version.ts VERSION must match package.json version')
})

test('the declared engines and manifest version are present', () => {
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject !== undefined && pkg.dsh.client.inject.length > 0)
  assert.equal(pkg.engines.dsh, '>=0.1.7-rc.2')
})

test('every path named in the manifest exists', () => {
  for (const relative of [pkg.dsh.bundle.patch, 'src/index.ts', 'src/client/index.tsx', 'src/client/style.css']) {
    assert.doesNotThrow(() => read(relative), `${relative} is named by the build but missing`)
  }
})

test('the client bundle output is declared as an export', () => {
  const exports = JSON.parse(read('package.json')).exports as Record<string, unknown>

  assert.ok(Object.hasOwn(exports, './client'), "exports must carry './client' or the browser half cannot load")
  assert.ok(Object.hasOwn(exports, './cordis.patch.yml'), "exports must carry './cordis.patch.yml'")
})

/**
 * Artifact assertions, skipped when `lib/` has not been built.
 *
 * These check the built output rather than the sources, because the two failure modes they
 * cover are invisible in source review: a bundled React produces a working build and then
 * breaks hooks in the browser, and a browser half that is not wrapped in the module-table
 * call simply never loads.
 */
const hasBuild = ((): boolean => {
  try {
    read('lib/index.js')
    return true
  } catch {
    return false
  }
})()

test('the host artifact imports only host-provided packages', { skip: !hasBuild }, () => {
  const host = read('lib/index.js')
  const bareImports = [...host.matchAll(/(?:^|\n)import\s[^'"]*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')

  for (const specifier of bareImports) {
    assert.ok(
      specifier.startsWith('@deepseek-ai/') || specifier.startsWith('node:'),
      `lib/index.js imports "${specifier}", which the host does not provide`,
    )
  }
})

test('the host artifact carries no browser framework', { skip: !hasBuild }, () => {
  // A bundled React in the host half would be dead weight rather than a broken hook, since the
  // host runs no components — but it also means the bundler resolved a browser package, which is
  // the same mistake that breaks the browser half. The specifier check above covers an import
  // that stayed an import; this covers one that was inlined.
  const host = read('lib/index.js')

  for (const marker of REACT_INTERNALS) {
    assert.ok(!host.includes(marker), `lib/index.js contains "${marker}", so React was bundled`)
  }
})

test('the browser artifact is wrapped for the client module table', { skip: !hasBuild }, () => {
  const client = read('lib/client.js')

  assert.match(client, /window\.__ModuleLoader__\.load\(/, 'lib/client.js must load through the module table')
  assert.match(client, /exports\.apply\s*=/, 'the browser half must export apply')
  assert.match(client, /exports\.inject\s*=/, 'the browser half must export inject')
})

test('the browser artifact does not inline React', { skip: !hasBuild }, () => {
  // Bundling React hands the plugin a second React instance: hooks throw at render time
  // while every build-time signal stays green. scripts/bundle-client.mjs also fails the
  // build on this, and the duplication is deliberate — the build guard can be deleted by
  // someone who does not know why it is there, but a failing test cannot be.
  const client = read('lib/client.js')

  for (const marker of REACT_INTERNALS) {
    assert.ok(!client.includes(marker), `lib/client.js contains "${marker}", so React was bundled`)
  }
})

test('the browser artifact requires only module-table specifiers', { skip: !hasBuild }, () => {
  const client = read('lib/client.js')
  const required = new Set([...client.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1] ?? ''))

  for (const specifier of required) {
    assert.ok(
      /^react(-dom)?($|\/)/.test(specifier) || specifier.startsWith('@deepseek-ai/'),
      `lib/client.js requires "${specifier}", which is not in the client module table`,
    )
  }
})

test('the intermediate client body is not left in the published output', { skip: !hasBuild }, () => {
  // The two-step build writes lib/client.body.cjs and folds it into lib/client.js. Leaving
  // it behind would ship a second, unwrapped copy of the browser half.
  assert.throws(() => read('lib/client.body.cjs'), 'lib/client.body.cjs must be removed after bundling')
})

test('no source file contains an undecodable character', () => {
  // A PowerShell round-trip (`Get-Content -Raw` then `Set-Content`) silently rewrote this
  // repository's UTF-8 sources in the console codepage and turned every em-dash into U+FFFD.
  // No compiler complains about that: the damage is entirely inside comments and string
  // literals, so it survives review and only surfaces when a user sees the mangled text.
  const damaged: string[] = []

  /** @param directory - absolute directory to walk. @param prefix - path for messages. */
  function walk(directory: URL, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'lib') continue
        walk(new URL(`${entry.name}/`, directory), relative)
      } else if (/\.(ts|tsx|css|json|yml|md)$/.test(entry.name)) {
        const bytes = readFileSync(new URL(entry.name, directory))
        // Decoding as UTF-8 with a fatal decoder is the real test: it rejects invalid byte
        // sequences, which is what a codepage-mangled file actually contains.
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          damaged.push(`${relative} (invalid UTF-8 bytes)`)
          continue
        }
        if (bytes.includes(0xef) && new TextDecoder().decode(bytes).includes('\uFFFD')) {
          damaged.push(relative)
        }
      }
    }
  }

  walk(root, '')
  assert.deepEqual(damaged, [], 'source files must be valid UTF-8 with no U+FFFD replacement characters')
})

test('no stray declaration files sit beside the sources', () => {
  // `npm run types` used to emit with no rootDir, which scattered `tests/*.d.ts` and
  // `tsdown.config.d.ts` next to their sources. They are inert until something resolves a
  // `.d.ts` in preference to the `.ts` it shadows, at which point type checking quietly
  // stops describing the code being edited. Cheap to assert, annoying to debug.
  const strays: string[] = []

  /** @param directory - absolute directory to walk. @param prefix - path for messages. */
  function walk(directory: URL, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        // `lib` is build output, `node_modules` is not ours, `types` holds hand-written shims.
        if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'types') continue
        walk(new URL(`${entry.name}/`, directory), relative)
      } else if (entry.name.endsWith('.d.ts')) {
        strays.push(relative)
      }
    }
  }

  walk(root, '')
  assert.deepEqual(strays, [], 'declaration files must live under lib/ (generated) or types/ (hand-written)')
})
