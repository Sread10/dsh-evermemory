import { resolve, normalize } from 'node:path'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  GIT_PROBE_TIMEOUT_MS,
  GIT_PROBE_TTL_MS,
  PROJECT_MARKERS,
} from '../constants.js'

/**
 * Project identity.
 *
 * Constraint #4 of the design: the git repository root IS the project identity, and every
 * worktree of that repository shares one memory. Everything below exists to turn a working
 * directory into a stable key, and to keep doing so when git is not installed at all — which
 * is the situation on the machine this plugin was developed on, so it is not a hypothetical
 * branch.
 */

/** How a project identity was established, ordered from most to least trustworthy. */
export type IdentitySource = 'git-repo' | 'git-worktree' | 'marker' | 'cwd' | 'unresolved'

export interface ProjectIdentity {
  /**
   * Stable key shared by every checkout of one project. Two worktrees of the same repository
   * produce the same key, and so does the checkout they were branched from; two unrelated
   * directories that happen to share a basename do not.
   */
  readonly key: string
  /** Absolute path of the directory that anchored the identity. */
  readonly root: string
  /** Last path segment of `root`, for display only. */
  readonly name: string
  /**
   * Distinguishes a worktree from its siblings. `undefined` for a normal checkout, where
   * there is nothing to distinguish.
   */
  readonly subId?: string
  readonly source: IdentitySource
  /** True when the answer is good enough to write project-scoped memory against. */
  readonly trustworthy: boolean
}

/**
 * Runs one git command. Injected so the three git outcomes — absent, repo, worktree — are
 * all testable on a machine with no git binary.
 */
export type GitRunner = (args: readonly string[], cwd: string) => GitResult

export interface GitResult {
  /** True when the process ran and exited 0. */
  readonly ok: boolean
  readonly stdout: string
}

const HASH_LENGTH = 16
const NOT_GIT: GitResult = { ok: false, stdout: '' }

/**
 * The real runner: `spawnSync` with a short timeout.
 *
 * A missing binary must not throw. `spawnSync` reports it as `status === null` with an
 * `error` set, and on Windows it can also surface as a non-zero status, so both are treated
 * as "git is not usable here" rather than as a failure worth propagating.
 */
export const spawnGit: GitRunner = (args, cwd) => {
  try {
    const result = spawnSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error !== undefined && result.error !== null) return NOT_GIT
    if (result.status !== 0) return NOT_GIT
    return { ok: true, stdout: (result.stdout ?? '').trim() }
  } catch {
    return NOT_GIT
  }
}

let probeCache: { at: number, available: boolean } | undefined

/**
 * Whether git can be run at all, cached briefly.
 *
 * The cache exists because `resolveIdentity` is called from a per-turn path and a `spawnSync`
 * per step would be a visible cost for an answer that changes approximately never. The TTL
 * bounds the damage from installing git mid-session.
 *
 * @param runner - git runner to probe with.
 * @param now - current time in milliseconds.
 * @param ttlMs - cache lifetime.
 */
export function gitAvailable(runner: GitRunner = spawnGit, now = Date.now(), ttlMs = GIT_PROBE_TTL_MS): boolean {
  if (probeCache !== undefined && now - probeCache.at < ttlMs) return probeCache.available
  const available = runner(['--version'], process.cwd()).ok
  probeCache = { at: now, available }
  return available
}

/** Clears the cached git probe. Exported for tests, which must not inherit a previous answer. */
export function resetGitProbe(): void {
  probeCache = undefined
}

/**
 * `git rev-parse --show-toplevel` — the repository root, with nested repositories resolving
 * to the innermost one, which is git's own behaviour and the behaviour we want: a vendored
 * repository inside a project is its own project. The answer is canonicalised, so the root
 * this returns is comparable with the path the process was handed, whatever spelling git used.
 */
export function gitToplevel(cwd: string, runner: GitRunner = spawnGit): string | undefined {
  const result = runner(['rev-parse', '--show-toplevel'], cwd)
  if (!result.ok || result.stdout === '') return undefined
  return canonical(result.stdout)
}

/**
 * `git rev-parse --git-common-dir` — the `.git` directory shared by all worktrees.
 *
 * For a normal checkout this is `<root>/.git`; for a linked worktree it is the main
 * repository's `.git`. That difference is the entire worktree-sharing mechanism, so the
 * comparison is made against the resolved absolute path rather than against a string that
 * might be relative. Measured shapes: a normal checkout is told `.git` at its root and
 * `../../.git` from a subdirectory — relative to the working directory, which is why the
 * resolution below uses `cwd` and not `process.cwd()` — while a linked worktree is told the
 * main repository's `.git` as an absolute path.
 */
export function gitCommonDir(cwd: string, runner: GitRunner = spawnGit): string | undefined {
  const result = runner(['rev-parse', '--git-common-dir'], cwd)
  if (!result.ok || result.stdout === '') return undefined
  return canonical(resolve(cwd, result.stdout))
}

/**
 * True when `commonDir` is not the `.git` directory sitting directly inside `root`.
 *
 * Compared as directories, not as strings: on Windows git may print `C:/repo/.git` while the
 * filesystem hands back `C:\repo\.git`, and a string comparison would then call every ordinary
 * checkout a worktree — which would give it a different project key from the same repository's
 * other checkouts, breaking constraint #4 in the quietest possible way. The CI runner produced the
 * same outcome from a different spelling again — a temporary directory handed over as
 * `C:\Users\RUNNER~1\...` against git's long answer — which is why the comparison resolves real
 * paths and folds case rather than normalising separators alone.
 */
export function isLinkedWorktree(root: string, commonDir: string): boolean {
  return comparable(commonDir) !== comparable(resolve(root, '.git'))
}

/**
 * The comparison {@link isLinkedWorktree} needs: two spellings of one directory, and nothing else.
 *
 * Case is folded because the project key folds it (see {@link keyFor}): git on Windows answers in
 * whatever case its caller used, and `C:\Repo\.git` and `c:\repo\.git` are one directory. Paths
 * the filesystem cannot spell back — a directory that does not exist, a `.git` file inside a
 * worktree — fall back to their normalized form, so the comparison never throws.
 */
function comparable(path: string): string {
  return canonical(path).toLowerCase()
}

/**
 * Walks up from `cwd` looking for the nearest directory containing a project marker.
 *
 * This is the fallback for a project that is not under version control. It deliberately
 * checks for `.git` last among equals but still checks it, so a repository that git cannot
 * read — a corrupt one, or one whose git binary is missing — still produces a stable root
 * instead of collapsing to `cwd`.
 */
export function findMarkerRoot(cwd: string): string | undefined {
  let current = canonical(cwd)
  for (;;) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(resolve(current, marker))) return current
    }
    const parent = resolve(current, '..')
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * A path in the spelling the filesystem itself reports, for comparison and display.
 *
 * Resolving the real path is what makes two answers comparable at all on Windows: a temporary
 * directory is routinely handed to a process under its 8.3 short name (`C:\Users\RUNNER~1\...`)
 * while git answers with the long one, and a comparison that counts those as two directories calls
 * every ordinary checkout a linked worktree — which is what the CI runner did on both Windows jobs
 * before this resolved anything. The fallback matters just as much: a directory that does not exist
 * yet still has to be walked up from, so a path the filesystem refuses to spell back is normalized
 * instead of rejected.
 */
function canonical(path: string): string {
  const normal = normalize(resolve(path))
  try {
    return realpathSync.native(normal)
  } catch {
    return normal
  }
}

/** Short, stable, collision-resistant project key. */
function keyFor(namespace: string, path: string): string {
  const digest = createHash('sha1').update(`${namespace}\0${normalize(path).toLowerCase()}`).digest('hex')
  return digest.slice(0, HASH_LENGTH)
}

export interface ResolveOptions {
  /** Defaults to `process.cwd()`. */
  readonly cwd?: string
  readonly runner?: GitRunner
  /** Set false to skip the git probe entirely, e.g. when the feature is switched off. */
  readonly useGit?: boolean
}

/**
 * Resolves a working directory to a project identity.
 *
 * The fallback chain, in order:
 *  1. a git work tree, where `--git-common-dir` decides whether this checkout shares an
 *     identity with its siblings;
 *  2. the nearest directory holding a project marker file;
 *  3. the working directory itself, marked untrustworthy;
 *  4. nothing at all, when even the working directory cannot be determined — in which case
 *     the caller must keep the memory session-scoped and never write it to the project layer.
 *
 * Step 3 exists because a wrong-but-plausible project key silently files one project's memory
 * under another, and no later layer is in a position to notice.
 */
export function resolveIdentity(options: ResolveOptions = {}): ProjectIdentity {
  const cwd = canonical(options.cwd ?? process.cwd())
  const runner = options.runner ?? spawnGit
  const useGit = options.useGit ?? true

  if (useGit && gitAvailable(runner)) {
    const root = gitToplevel(cwd, runner)
    if (root !== undefined) {
      const name = basename(root)
      // The key is derived from the common directory in every checkout, never from the work tree
      // that was asked about. That is the whole of constraint #4: a worktree and the checkout it
      // was branched from share one `.git`, so they must file their memory under one project.
      // Keying the ordinary checkout on its own root instead gives the two different keys even
      // though `isLinkedWorktree` has already recognised them as one repository — measured, by
      // `tests/identity-git.test.ts` against a real repository.
      const commonDir = gitCommonDir(cwd, runner) ?? resolve(root, '.git')
      if (isLinkedWorktree(root, commonDir)) {
        // `subId` keeps the checkouts distinguishable where a caller cares (the daily log does).
        return {
          key: keyFor('git-project', commonDir),
          root,
          name,
          subId: keyFor('worktree', root),
          source: 'git-worktree',
          trustworthy: true,
        }
      }
      return {
        key: keyFor('git-project', commonDir),
        root,
        name,
        source: 'git-repo',
        trustworthy: true,
      }
    }
  }

  const markerRoot = findMarkerRoot(cwd)
  if (markerRoot !== undefined) {
    return {
      key: keyFor('marker', markerRoot),
      root: markerRoot,
      name: basename(markerRoot),
      source: 'marker',
      trustworthy: true,
    }
  }

  if (existsSync(cwd) && statSync(cwd).isDirectory()) {
    // A directory with no marker above it is still a usable key — it is stable and it is
    // isolated — but it is not trustworthy, because the same project opened one level up
    // would produce a different key. Untrustworthy identities are read-only for the project
    // layer so a user who opens the wrong folder does not split their memory in two.
    return { key: keyFor('cwd', cwd), root: cwd, name: basename(cwd), source: 'cwd', trustworthy: false }
  }

  return { key: '', root: '', name: '', source: 'unresolved', trustworthy: false }
}

/** Last path segment, tolerating a trailing separator and a bare drive root. */
function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? trimmed
}

/**
 * Narrowing helper for exhaustive handling of {@link IdentitySource} in callers. Throws for
 * an unknown value rather than falling through, so adding a source is a compile error at
 * every switch that must handle it.
 */
export function describeIdentitySource(source: IdentitySource): string {
  switch (source) {
    case 'git-repo': return 'git repository'
    case 'git-worktree': return 'git worktree'
    case 'marker': return 'project marker'
    case 'cwd': return 'working directory'
    case 'unresolved': return 'unresolved'
    default: throw new Error(`unhandled identity source: ${String(source)}`)
  }
}
