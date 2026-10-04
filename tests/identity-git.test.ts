/**
 * Project identity against a real git binary.
 *
 * `tests/identity.test.ts` drives resolution with an injected runner, which is what keeps the three
 * git outcomes — absent, repository, worktree — testable on a machine that has no git at all. What
 * that leaves unproven is the real runner: `spawnGit`'s argv, its working directory, the trimming of
 * git's output, and the difference between the relative `--git-common-dir` a normal checkout prints
 * and the absolute one a linked worktree prints. This suite runs the product's own runner against a
 * real repository and a real worktree, so git itself answers instead of a string this project wrote.
 *
 * The suite skips when no git binary is on `PATH`, because a checkout without git must still be able
 * to run `npm test` — and the machine this plugin was built on is such a checkout.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { after, describe, test } from 'node:test'

import { resolveIdentity } from '../src/identity/resolve.ts'

const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0
const SKIP = HAS_GIT ? false : 'no git binary on PATH; the injected-runner suite covers the rest'

const scratch: string[] = []

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** A temporary directory that is removed when the suite ends. */
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evm-real-git-'))
  scratch.push(dir)
  return dir
}

/** Run git for the fixture's own setup, failing the test rather than the assertion when it cannot. */
function runGit(args: readonly string[], cwd: string): void {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
}

/** A repository with one commit, so a worktree can be added to it. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  runGit(['init'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8')
  runGit(['add', '-A'], dir)
  runGit(
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'init'],
    dir,
  )
}

/** Paths are compared the way the product compares them: resolved and case-insensitive on Windows. */
function samePath(left: string, right: string): boolean {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase()
}

describe('project identity against a real git binary', { skip: SKIP }, () => {
  test('a real checkout answers with its repository root, not with a marker file', () => {
    const repo = join(temporary(), 'project')
    initRepo(repo)

    // A marker inside the repository is the interesting case: `package.json` would be enough on its
    // own, and git has to win anyway, or a monorepo package would become its own project.
    const nested = join(repo, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'package.json'), '{ "name": "app" }\n', 'utf8')

    const identity = resolveIdentity({ cwd: nested })

    assert.equal(identity.source, 'git-repo')
    assert.ok(samePath(identity.root, repo), `root ${identity.root} should be the repository root ${repo}`)
    assert.equal(identity.name, 'project')
    assert.equal(identity.subId, undefined, 'a normal checkout has no sibling to distinguish')
    assert.equal(identity.trustworthy, true)
  })

  test('a linked worktree shares the project key and carries its own sub-id', () => {
    const parent = temporary()
    const repo = join(parent, 'project')
    initRepo(repo)
    const sibling = join(parent, 'project-feature')
    runGit(['worktree', 'add', '-b', 'feature', sibling], repo)

    const main = resolveIdentity({ cwd: repo })
    const worktree = resolveIdentity({ cwd: sibling })

    assert.equal(main.source, 'git-repo')
    assert.equal(worktree.source, 'git-worktree', 'git prints an absolute common dir for a worktree')
    assert.equal(worktree.key, main.key, 'worktrees of one repository share one memory')
    assert.ok(worktree.subId !== undefined, 'a worktree is distinguishable from its siblings')
    assert.notEqual(worktree.subId, main.subId)
    assert.ok(samePath(worktree.root, sibling), `root ${worktree.root} should be the worktree ${sibling}`)
  })

  test('two checkouts with the same directory name do not share a key', () => {
    const parent = temporary()
    const first = join(parent, 'one', 'project')
    const second = join(parent, 'two', 'project')
    initRepo(first)
    initRepo(second)

    const a = resolveIdentity({ cwd: first })
    const b = resolveIdentity({ cwd: second })

    assert.equal(a.name, b.name, 'the display name is the same, which is exactly the trap')
    assert.notEqual(a.key, b.key, 'the key is the path, so two same-named projects stay apart')
  })
})
