import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import {
  MAX_RULE_FILE_BYTES,
  RULES_HEADER,
  compareRuleNames,
  globalRulesDir,
  listRuleFiles,
  loadRules,
  projectRulesDir,
  resetRuleCache,
} from '../src/rules/loader.ts'
import {
  RULES_TTL_MS,
  createRulesState,
  mountRulesSection,
  newRuleTickState,
  refreshRules,
} from '../src/rules/section.ts'
import { DSH_HOME_ENV } from '../src/constants.ts'

/**
 * The rules channel is the only content that reaches the model verbatim and unescaped, so the
 * tests below treat every failure mode as a PROMPT failure rather than a file error: a missing
 * directory, an unreadable file and an oversized file must all end in "the prompt still
 * assembles". The one behaviour worth pinning hardest is the render order — a project rule that
 * arrives after a contradicting global rule is a rule the model may follow the wrong half of.
 */

interface Sandbox {
  readonly root: string
  readonly home: string
  readonly project: string
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'evm-rules-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  return { root, home, project }
}

function writeRule(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, text, 'utf8')
  return path
}

afterEach(() => {
  resetRuleCache()
  delete process.env[DSH_HOME_ENV]
})

describe('rule discovery', () => {
  test('reads .md files only', () => {
    const { home } = sandbox()
    const dir = globalRulesDir(home)
    writeRule(dir, 'a.md', 'rule a')
    writeRule(dir, 'notes.txt', 'not a rule')
    writeRule(dir, 'script.js', 'console.log(1)')
    const names = listRuleFiles(dir).map((p) => p.split(/[\\/]/).pop())
    assert.deepEqual(names, ['a.md'])
  })

  test('skips hidden files', () => {
    const { home } = sandbox()
    const dir = globalRulesDir(home)
    writeRule(dir, 'visible.md', 'x')
    writeRule(dir, '.draft.md', 'x')
    assert.equal(listRuleFiles(dir).length, 1)
  })

  test('sorts numerically, because 10 does not come before 2', () => {
    const { home } = sandbox()
    const dir = globalRulesDir(home)
    for (const name of ['10-late.md', '2-early.md', '1-first.md']) writeRule(dir, name, name)
    const names = listRuleFiles(dir).map((p) => p.replace(/^.*[\\/]/, ''))
    assert.deepEqual(names, ['1-first.md', '2-early.md', '10-late.md'])
    assert.ok(compareRuleNames('2-a.md', '10-a.md') < 0)
  })

  test('a missing directory yields no files and no throw', () => {
    const { root } = sandbox()
    assert.deepEqual(listRuleFiles(join(root, 'nope')), [])
  })

  test('paths are the documented ones', () => {
    assert.equal(projectRulesDir('C:\\p'), join('C:\\p', '.dsh', 'rules'))
    assert.equal(globalRulesDir('/home/u/.dsh'), join('/home/u/.dsh', 'rules'))
  })
})

describe('rule merging', () => {
  test('no rules anywhere renders empty, so nothing is injected at all', () => {
    const { home, project } = sandbox()
    const set = loadRules({ cwd: project, dshHome: home })
    assert.equal(set.text, '')
    assert.equal(set.files.length, 0)
    assert.equal(set.degraded, false)
  })

  test('project rules are rendered before global rules', () => {
    const { home, project } = sandbox()
    writeRule(globalRulesDir(home), 'global.md', 'GLOBAL-RULE')
    writeRule(projectRulesDir(project), 'project.md', 'PROJECT-RULE')
    const set = loadRules({ cwd: project, dshHome: home })
    assert.ok(set.text.startsWith(RULES_HEADER))
    assert.ok(
      set.text.indexOf('PROJECT-RULE') < set.text.indexOf('GLOBAL-RULE'),
      'a project rule must be read first when the two contradict',
    )
    assert.deepEqual(set.files.map((f) => f.scope), ['project', 'global'])
  })

  test('includeGlobal false leaves project rules only', () => {
    const { home, project } = sandbox()
    writeRule(globalRulesDir(home), 'global.md', 'GLOBAL-RULE')
    writeRule(projectRulesDir(project), 'project.md', 'PROJECT-RULE')
    const set = loadRules({ cwd: project, dshHome: home, includeGlobal: false })
    assert.ok(set.text.includes('PROJECT-RULE'))
    assert.ok(!set.text.includes('GLOBAL-RULE'))
  })

  test('several files are labelled, one file is not', () => {
    const { project } = sandbox()
    writeRule(projectRulesDir(project), 'style.md', 'STYLE-RULE')
    const single = loadRules({ cwd: project })
    assert.ok(!single.text.includes('### 规则：'))

    writeRule(projectRulesDir(project), 'review.md', 'REVIEW-RULE')
    const both = loadRules({ cwd: project })
    assert.ok(both.text.includes('### 规则：review'))
    assert.ok(both.text.includes('### 规则：style'))
  })

  test('extra directories are read and rank with project rules', () => {
    const { root, project } = sandbox()
    const extra = join(root, 'extra')
    writeRule(extra, 'x.md', 'EXTRA-RULE')
    const set = loadRules({ cwd: project, extraDirs: [extra] })
    assert.ok(set.text.includes('EXTRA-RULE'))
    assert.equal(set.files[0]?.scope, 'project')
  })

  test('a blank extra directory entry is ignored rather than resolving to cwd', () => {
    const { project } = sandbox()
    writeRule(projectRulesDir(project), 'p.md', 'P')
    const set = loadRules({ cwd: project, extraDirs: ['', '   '] })
    assert.equal(set.files.length, 1)
    assert.equal(set.degraded, false)
  })

  test('an empty file contributes nothing', () => {
    const { project } = sandbox()
    writeRule(projectRulesDir(project), 'empty.md', '   \n\n  ')
    assert.equal(loadRules({ cwd: project }).text, '')
  })

  test('a rule file past the size cap is skipped, not injected', () => {
    const { project } = sandbox()
    writeRule(projectRulesDir(project), 'huge.md', 'x'.repeat(MAX_RULE_FILE_BYTES + 1))
    writeRule(projectRulesDir(project), 'small.md', 'SMALL-RULE')
    const set = loadRules({ cwd: project })
    assert.equal(set.files.length, 1)
    assert.ok(set.text.includes('SMALL-RULE'))
  })

  test('a missing extra directory is reported as degraded, not thrown', () => {
    const { root, project } = sandbox()
    const set = loadRules({ cwd: project, extraDirs: [join(root, 'absent')] })
    assert.equal(set.degraded, true)
    assert.equal(set.text, '')
  })
})

describe('the rules cache', () => {
  test('an unchanged file is served from cache and a changed one is re-read', () => {
    const { project } = sandbox()
    const path = writeRule(projectRulesDir(project), 'a.md', 'FIRST')
    assert.ok(loadRules({ cwd: project }).text.includes('FIRST'))

    // Same second, same size: without the cache this still passes, with a stale cache it fails.
    writeFileSync(path, 'SECOND', 'utf8')
    assert.ok(loadRules({ cwd: project }).text.includes('SECOND'))
  })

  test('resetRuleCache makes a same-mtime edit visible', () => {
    const { project } = sandbox()
    const path = writeRule(projectRulesDir(project), 'a.md', 'ALPHA')
    loadRules({ cwd: project })
    writeFileSync(path, 'BRAVO', 'utf8')
    resetRuleCache()
    assert.ok(loadRules({ cwd: project }).text.includes('BRAVO'))
  })
})

describe('the rules section state', () => {
  // `refreshRules` resolves `$DSH_HOME` itself, because the section it feeds runs inside prompt
  // assembly where there is no context to pass one in. Pinning the environment variable is
  // therefore the only honest way to test the global level — and leaving it unset would make
  // these tests read the developer's real `~/.dsh/rules`.
  function withHome(home: string): void {
    process.env[DSH_HOME_ENV] = home
  }

  const unlimited = { maxChars: 100_000 }

  test('refresh fills the text and reports the file count', () => {
    const { home, project } = sandbox()
    withHome(home)
    writeRule(projectRulesDir(project), 'a.md', 'RULE-A')
    const state = createRulesState()
    assert.equal(state.text, '')
    const tick = refreshRules(state, unlimited, { cwd: project, tick: newRuleTickState(), force: true })
    assert.equal(tick.changed, true)
    assert.equal(tick.read, true)
    assert.ok(state.text.includes('RULE-A'))
    assert.equal(state.fileCount, 1)
  })

  test('the TTL suppresses a second read inside the window and permits one after it', () => {
    const { project } = sandbox()
    writeRule(projectRulesDir(project), 'a.md', 'RULE-A')
    const state = createRulesState()
    const tick = newRuleTickState()

    assert.equal(refreshRules(state, unlimited, { cwd: project, tick, now: 1_000, force: true }).read, true)
    assert.equal(refreshRules(state, unlimited, { cwd: project, tick, now: 1_000 + RULES_TTL_MS - 1 }).read, false)
    assert.equal(refreshRules(state, unlimited, { cwd: project, tick, now: 1_000 + RULES_TTL_MS + 1 }).read, true)
  })

  test('force reads regardless of the clock', () => {
    const { project } = sandbox()
    const state = createRulesState()
    const tick = newRuleTickState()
    refreshRules(state, unlimited, { cwd: project, tick, now: 5_000, force: true })
    assert.equal(refreshRules(state, unlimited, { cwd: project, tick, now: 5_000, force: true }).read, true)
  })

  test('changed is false when the rendered text is the same as before', () => {
    const { project } = sandbox()
    writeRule(projectRulesDir(project), 'a.md', 'SAME')
    const state = createRulesState()
    const tick = newRuleTickState()
    assert.equal(refreshRules(state, unlimited, { cwd: project, tick, force: true }).changed, true)
    assert.equal(refreshRules(state, unlimited, { cwd: project, tick, force: true }).changed, false)
  })

  test('an edit shows up through the TTL, without a restart', () => {
    const { project } = sandbox()
    const path = writeRule(projectRulesDir(project), 'a.md', 'OLD-RULE')
    const state = createRulesState()
    const tick = newRuleTickState()
    refreshRules(state, unlimited, { cwd: project, tick, now: 0, force: true })
    writeFileSync(path, 'NEW-RULE', 'utf8')
    resetRuleCache()
    refreshRules(state, unlimited, { cwd: project, tick, now: RULES_TTL_MS + 1 })
    assert.ok(state.text.includes('NEW-RULE'))
  })

  test('the maxChars cap bounds the section text', () => {
    const { project } = sandbox()
    writeRule(projectRulesDir(project), 'a.md', 'x'.repeat(5_000))
    const state = createRulesState()
    refreshRules(state, { maxChars: 200 }, { cwd: project, tick: newRuleTickState(), force: true })
    assert.ok([...state.text].length <= 200)
  })

  test('a change of DSH home counts as a change even with identical rules', () => {
    // Otherwise moving DSH_HOME would leave the previously read rules in the prompt with no
    // signal that they came from somewhere else.
    const { home, root } = sandbox()
    const other = join(root, 'other-home')
    const state = createRulesState()
    withHome(home)
    assert.equal(refreshRules(state, unlimited, { force: true }).changed, true)
    withHome(other)
    assert.equal(refreshRules(state, unlimited, { force: true }).changed, true)
  })
})

describe('mounting the rules section', () => {
  /**
   * A stand-in for a cordis Context.
   *
   * The stub implements `get('systemPrompt')` rather than hanging the service off the context
   * directly, because that accessor IS the contract: `systemPromptOf` reads the service through
   * `ctx.get`, which is what a real plugin sees. A fake that exposed `ctx.systemPrompt` would
   * pass while the real registration silently did nothing.
   */
  function fakeContext(): {
    ctx: unknown
    calls: { name: string, order: number, text: () => string }[]
  } {
    const calls: { name: string, order: number, text: () => string }[] = []
    const service = {
      section(contribution: { name: string, order: number, text: () => string }) {
        calls.push(contribution)
        return () => undefined
      },
      context: () => () => undefined,
    }
    const ctx = {
      get: (name: string) => (name === 'systemPrompt' ? service : undefined),
    }
    return { ctx, calls }
  }

  test('registers one section whose text is read late, not captured', () => {
    const { project } = sandbox()
    writeRule(projectRulesDir(project), 'a.md', 'MOUNTED-RULE')
    const state = createRulesState()
    refreshRules(state, { maxChars: 100_000 }, { cwd: project, tick: newRuleTickState(), force: true })

    const fake = fakeContext()
    assert.equal(mountRulesSection(fake.ctx, state, 50), true)
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0]?.name, 'evermemory-rules')
    assert.equal(fake.calls[0]?.order, 50)
    // The callback must be a live read: the section is assembled long after registration, and a
    // captured string would freeze the rules at whatever they were during `apply`.
    assert.ok(fake.calls[0]?.text().includes('MOUNTED-RULE'))

    writeRule(projectRulesDir(project), 'b.md', 'SECOND-RULE')
    resetRuleCache()
    refreshRules(state, { maxChars: 100_000 }, { cwd: project, tick: newRuleTickState(), force: true })
    assert.ok(fake.calls[0]?.text().includes('SECOND-RULE'))
  })

  test('an empty rule set renders an empty section, which assembly then drops', () => {
    const state = createRulesState()
    const fake = fakeContext()
    mountRulesSection(fake.ctx, state, 50)
    assert.equal(fake.calls[0]?.text(), '')
  })

  test('a context without a system prompt is refused rather than thrown at', () => {
    // A Host that never loaded `dsh-system-prompt` still gets memory and tools; the rules are
    // simply not injected. Throwing here would take the whole plugin down with it.
    assert.equal(mountRulesSection({}, createRulesState(), 50), false)
    assert.equal(mountRulesSection(undefined, createRulesState(), 50), false)
  })
})
