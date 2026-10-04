import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import {
  describeIdentitySource,
  findMarkerRoot,
  gitAvailable,
  gitCommonDir,
  gitToplevel,
  isLinkedWorktree,
  resetGitProbe,
  resolveIdentity,
  spawnGit,
  type GitResult,
  type GitRunner,
} from '../src/identity/resolve.ts'

/**
 * Every test here runs against a real directory tree in a temporary folder, and the git
 * outcomes come from an injected runner. That is not a stylistic choice: git is NOT installed
 * on the machine this plugin is being developed on, so a test suite that shelled out to git
 * would be unable to verify any of the three git paths — including the one that matters most,
 * where git is simply absent.
 */

const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evm-identity-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  // The probe caches its answer globally; leaving it set would let the first test in this
  // file decide what every later test believes about git being installed.
  resetGitProbe()
})

/** A runner that answers a fixed script of git invocations, and records what was asked. */
function fakeGit(responses: Record<string, GitResult>): { runner: GitRunner, calls: string[][] } {
  const calls: string[][] = []
  const runner: GitRunner = (args) => {
    calls.push([...args])
    return responses[args.join(' ')] ?? { ok: false, stdout: '' }
  }
  return { runner, calls }
}

const VERSION_OK: GitResult = { ok: true, stdout: 'git version 2.43.0' }
const VERSION_MISSING: GitResult = { ok: false, stdout: '' }

describe('git probes tolerate a missing git', () => {
  test('the real runner reports failure instead of throwing when git is absent', () => {
    // This machine has no git. The point of the assertion is that asking anyway is harmless:
    // a plugin that threw here would fail its host's plugin tree at boot on any machine
    // without git installed.
    assert.doesNotThrow(() => spawnGit(['--version'], process.cwd()))
    const result = spawnGit(['--version'], process.cwd())
    assert.equal(typeof result.ok, 'boolean')
    assert.equal(typeof result.stdout, 'string')
  })

  test('an unreadable repository yields no toplevel rather than an error', () => {
    const { runner } = fakeGit({ 'rev-parse --show-toplevel': { ok: false, stdout: '' } })
    assert.equal(gitToplevel(process.cwd(), runner), undefined)
  })

  test('empty output is not mistaken for a path', () => {
    // `git rev-parse` can exit 0 with empty stdout in a bare repository; returning '' would
    // become the project root and then the empty project key.
    const { runner } = fakeGit({ 'rev-parse --show-toplevel': { ok: true, stdout: '' } })
    assert.equal(gitToplevel(process.cwd(), runner), undefined)
  })

  test('the availability probe is cached and can be reset', () => {
    const { runner, calls } = fakeGit({ '--version': VERSION_MISSING })
    resetGitProbe()
    assert.equal(gitAvailable(runner, 1_000), false)
    assert.equal(gitAvailable(runner, 1_100), false, 'second call inside the TTL')
    assert.equal(calls.length, 1, 'the probe must not spawn once per step')
    assert.equal(gitAvailable(runner, 1_000 + 30_001), false, 'past the TTL it re-probes')
    assert.equal(calls.length, 2)
  })
})

describe('worktree detection', () => {
  test('an ordinary checkout is not a worktree', () => {
    const root = tempDir()
    // Windows paths are handed back with either separator; the comparison must survive that.
    const separator = process.platform === 'win32' ? '\\' : '/'
    assert.equal(isLinkedWorktree(root, `${root}${separator}.git`), false)
  })

  test('a shared common directory is a worktree', () => {
    const root = tempDir()
    const elsewhere = tempDir()
    assert.equal(isLinkedWorktree(root, join(elsewhere, '.git')), true)
  })

  test('sibling worktrees produce identical keys and distinct sub-ids', () => {
    const shared = join(tempDir(), '.git')
    const one = tempDir()
    const two = tempDir()
    const runnerFor = (cwd: string): GitRunner => fakeGit({
      '--version': VERSION_OK,
      'rev-parse --show-toplevel': { ok: true, stdout: cwd },
      'rev-parse --git-common-dir': { ok: true, stdout: shared },
    }).runner

    resetGitProbe()
    const a = resolveIdentity({ cwd: one, runner: runnerFor(one) })
    resetGitProbe()
    const b = resolveIdentity({ cwd: two, runner: runnerFor(two) })
    assert.equal(a.source, 'git-worktree')
    assert.equal(b.source, 'git-worktree')
    assert.equal(a.trustworthy, true)
    assert.equal(a.key, b.key, 'worktrees share the project memory')
    assert.equal(a.root, one)
    assert.equal(b.root, two)
    assert.notEqual(a.subId, b.subId, 'but remain individually identifiable')
  })

  test('a worktree and the checkout it was branched from share one key', () => {
    // The two shapes real git prints, measured against git 2.56: a normal checkout is told
    // `--git-common-dir` relative to its working directory (`.git` at the root, `../../.git` from
    // a subdirectory), a linked worktree is told the main repository's absolute `.git`. A key
    // derived from the work tree rather than from that shared directory splits one project's
    // memory in two — `tests/identity-git.test.ts` runs the same case against a real repository,
    // so this fake cannot flatter the product.
    const main = tempDir()
    const worktree = tempDir()
    const mainRunner = fakeGit({
      '--version': VERSION_OK,
      'rev-parse --show-toplevel': { ok: true, stdout: main },
      'rev-parse --git-common-dir': { ok: true, stdout: '.git' },
    }).runner
    const worktreeRunner = fakeGit({
      '--version': VERSION_OK,
      'rev-parse --show-toplevel': { ok: true, stdout: worktree },
      'rev-parse --git-common-dir': { ok: true, stdout: join(main, '.git') },
    }).runner

    resetGitProbe()
    const checkout = resolveIdentity({ cwd: main, runner: mainRunner })
    resetGitProbe()
    const linked = resolveIdentity({ cwd: worktree, runner: worktreeRunner })

    assert.equal(checkout.source, 'git-repo')
    assert.equal(linked.source, 'git-worktree')
    assert.equal(linked.key, checkout.key, 'one repository, one project memory')
    assert.equal(checkout.subId, undefined, 'the ordinary checkout has nothing to distinguish')
    assert.equal(typeof linked.subId, 'string')
    assert.notEqual(linked.subId, checkout.subId)
  })

  test('a relative common directory is resolved against the working directory', () => {
    const root = tempDir()
    // In a normal checkout git prints `--git-common-dir` relative to cwd, so resolving it
    // against process.cwd() instead of the passed cwd would point at the wrong repository.
    const { runner } = fakeGit({ 'rev-parse --git-common-dir': { ok: true, stdout: '.git' } })
    assert.equal(gitCommonDir(root, runner), resolve(root, '.git'))
  })
})

describe('marker fallback', () => {
  test('finds the nearest directory holding a marker', () => {
    const root = tempDir()
    writeFileSync(join(root, 'package.json'), '{}')
    const nested = join(root, 'packages', 'inner', 'src')
    mkdirSync(nested, { recursive: true })
    assert.equal(findMarkerRoot(nested), root)
  })

  test('picks the innermost marker when projects are nested', () => {
    const outer = tempDir()
    writeFileSync(join(outer, 'package.json'), '{}')
    const inner = join(outer, 'vendor', 'thing')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(inner, 'pyproject.toml'), '')
    assert.equal(findMarkerRoot(inner), inner)
  })

  test('a .git directory counts as a marker even when git cannot read it', () => {
    // The fallback exists for a repository git is unable to report on. If `.git` were
    // skipped, the root would move up to whatever ancestor happens to hold another marker.
    const root = tempDir()
    const nested = join(root, 'work')
    mkdirSync(join(nested, '.git'), { recursive: true })
    assert.equal(findMarkerRoot(nested), nested)
  })

  test('carries no identity for a directory with no ancestors holding a marker', () => {
    // The temp directory sits under a path that may or may not hold a marker depending on
    // the machine, so this asserts only that the walk terminates and returns something
    // sane: either a real ancestor or undefined, never a crash or a partial path.
    const root = tempDir()
    const found = findMarkerRoot(root)
    assert.ok(found === undefined || typeof found === 'string')
  })
})

describe('resolveIdentity', () => {
  test('prefers the git repository root and reports it as trustworthy', () => {
    const repo = tempDir()
    const nested = join(repo, 'src', 'deep')
    mkdirSync(nested, { recursive: true })
    const { runner } = fakeGit({
      '--version': VERSION_OK,
      'rev-parse --show-toplevel': { ok: true, stdout: repo },
      // Absolute, which is the form git prints for a checkout whose `.git` is a directory
      // inside the root. A relative `.git` would be resolved against the PROCESS working
      // directory inside `gitCommonDir` — correct for real git, which always runs in `cwd`,
      // but it would make this test assert something other than what it reads as.
      'rev-parse --git-common-dir': { ok: true, stdout: join(repo, '.git') },
    })
    resetGitProbe()

    const identity = resolveIdentity({ cwd: nested, runner })
    assert.equal(identity.source, 'git-repo')
    assert.equal(identity.root, repo)
    assert.equal(identity.name, repo.split(/[\\/]/).pop())
    assert.equal(identity.trustworthy, true)
    assert.equal(identity.subId, undefined, 'a normal checkout has nothing to distinguish')
    assert.equal(identity.key.length, 16)
  })

  test('nested repositories resolve to the innermost one', () => {
    // git reports the innermost root itself, so the assertion is that the answer is used
    // verbatim rather than being re-derived by walking up from cwd.
    const outer = tempDir()
    const vendor = join(outer, 'vendor', 'lib')
    mkdirSync(vendor, { recursive: true })
    const { runner } = fakeGit({
      '--version': VERSION_OK,
      'rev-parse --show-toplevel': { ok: true, stdout: vendor },
      'rev-parse --git-common-dir': { ok: true, stdout: join(vendor, '.git') },
    })
    resetGitProbe()
    assert.equal(resolveIdentity({ cwd: vendor, runner }).root, vendor)
  })

  test('falls back to a marker root when git is not installed', () => {
    const root = tempDir()
    writeFileSync(join(root, 'package.json'), '{}')
    const nested = join(root, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    resetGitProbe()

    const { runner, calls } = fakeGit({ '--version': VERSION_MISSING })
    const identity = resolveIdentity({ cwd: nested, runner })
    assert.equal(identity.source, 'marker')
    assert.equal(identity.root, root)
    assert.equal(identity.trustworthy, true)
    // The decisive part: with no git, no rev-parse is attempted at all.
    assert.deepEqual(calls, [['--version']], 'no git subcommand may run when git is absent')
  })

  test('falls back to a marker root when the repository is unreadable', () => {
    const root = tempDir()
    writeFileSync(join(root, 'pyproject.toml'), '')
    const nested = join(root, 'pkg')
    mkdirSync(nested, { recursive: true })
    resetGitProbe()

    const { runner } = fakeGit({ '--version': VERSION_OK })
    const identity = resolveIdentity({ cwd: nested, runner })
    // git is installed but declines to answer, so the marker chain takes over.
    assert.equal(identity.source, 'marker')
    assert.equal(identity.root, root)
  })

  test('a directory with no marker is usable but NOT trustworthy', () => {
    const bare = tempDir()
    resetGitProbe()
    const identity = resolveIdentity({
      cwd: bare,
      runner: fakeGit({ '--version': VERSION_MISSING }).runner,
    })
    // It may resolve to an ancestor marker if one exists above the temp directory; the
    // contract under test is only that an unresolvable chain never claims trust.
    if (identity.source === 'cwd') {
      assert.equal(identity.trustworthy, false)
      assert.equal(identity.root, bare)
    } else {
      assert.equal(identity.source, 'marker')
    }
  })

  test('useGit: false skips the probe entirely', () => {
    const root = tempDir()
    writeFileSync(join(root, 'package.json'), '{}')
    const nested = join(root, 'src')
    mkdirSync(nested, { recursive: true })
    const { runner, calls } = fakeGit({ '--version': VERSION_OK, 'rev-parse --show-toplevel': { ok: true, stdout: root } })
    resetGitProbe()
    const identity = resolveIdentity({ cwd: nested, runner, useGit: false })
    assert.deepEqual(calls, [], 'the switch must save the spawn, not just the answer')
    assert.equal(identity.source, 'marker')
  })

  test('an identity is stable across calls and differs between projects', () => {
    const one = tempDir()
    const two = tempDir()
    writeFileSync(join(one, 'package.json'), '{}')
    writeFileSync(join(two, 'package.json'), '{}')
    const runner = fakeGit({ '--version': VERSION_MISSING }).runner
    resetGitProbe()
    const a = resolveIdentity({ cwd: one, runner })
    resetGitProbe()
    const again = resolveIdentity({ cwd: one, runner })
    resetGitProbe()
    const b = resolveIdentity({ cwd: two, runner })
    assert.equal(a.key, again.key, 'the same directory must not drift')
    assert.notEqual(a.key, b.key, 'two projects must not collide')
  })

  test('paths differing only by case agree, because Windows treats them as one', (t) => {
    const root = tempDir()
    writeFileSync(join(root, 'package.json'), '{}')

    // The rule underneath is unconditional, because the project key folds case: a common
    // directory spelled in another case is the same repository, not a linked worktree. CI runs
    // this line on a Windows runner and on Linux, so the halves are separated — this one holds
    // everywhere, and the filesystem half below is checked rather than assumed.
    assert.equal(isLinkedWorktree(root, join(root, '.git').toUpperCase()), false)
    assert.equal(isLinkedWorktree(root, join(root, 'elsewhere', '.git')), true)

    if (!existsSync(root.toUpperCase())) {
      t.skip('this filesystem is case-sensitive, so the other spelling is a different directory')
      return
    }

    const runner = fakeGit({ '--version': VERSION_MISSING }).runner
    resetGitProbe()
    const lower = resolveIdentity({ cwd: root, runner })
    resetGitProbe()
    const upper = resolveIdentity({ cwd: root.toUpperCase(), runner })
    assert.equal(lower.key, upper.key)
  })

  test('every identity source has a description and an unknown one throws', () => {
    assert.equal(describeIdentitySource('git-repo'), 'git repository')
    assert.equal(describeIdentitySource('git-worktree'), 'git worktree')
    assert.equal(describeIdentitySource('marker'), 'project marker')
    assert.equal(describeIdentitySource('cwd'), 'working directory')
    assert.equal(describeIdentitySource('unresolved'), 'unresolved')
    assert.throws(() => describeIdentitySource('nonsense' as never), /unhandled identity source/)
  })
})
