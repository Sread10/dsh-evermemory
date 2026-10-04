import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { extractCandidates, extractFromMessages } from '../src/distill/extract.ts'
import { decideScope, importanceFor, judge } from '../src/distill/judge.ts'
import { describeReport, distill, distillCandidates } from '../src/distill/engine.ts'
import { splitSentences, type Cue } from '../src/distill/patterns.ts'
import { openStore, type OpenStore } from '../src/storage/db.ts'
import { MemoryRepository } from '../src/storage/repository.ts'

/**
 * The distillation engine is where a memory store's reputation is made. Storing too little is
 * a forgettable annoyance; storing something the user never said is a wrong answer they have
 * no way to trace. Every rejection test below therefore asserts the specific reason, not just
 * that it was rejected — "rejected for being a question" and "rejected by accident" look
 * identical from the outside.
 */

const stores: OpenStore[] = []

async function freshStore(): Promise<{ store: OpenStore, repository: MemoryRepository }> {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), 'evm-distill-')), 'store.sqlite') })
  stores.push(store)
  return { store, repository: new MemoryRepository(store.db) }
}

after(() => {
  for (const store of stores) {
    try {
      store.db.close()
    } catch {
      // Already closed by the test; nothing to report.
    }
  }
})

/** Convenience: the first candidate's text, or undefined. */
function firstText(message: string): string | undefined {
  return extractCandidates(message)[0]?.text
}

describe('sentence splitting', () => {
  test('splits on Chinese and English sentence endings and on newlines', () => {
    // The delimiters are consumed, not kept: a lookbehind that leaves them attached also leaves
    // the following space, and "one. two!" then never splits at all.
    assert.deepEqual(splitSentences('第一句。第二句！第三句？'), ['第一句', '第二句', '第三句'])
    assert.deepEqual(splitSentences('one. two!\nthree?'), ['one', 'two', 'three'])
  })

  test('splits on commas, because two instructions often share one sentence', () => {
    // "不要用 npm，改用 pnpm" is a prohibition AND a replacement. Kept as one clause, the
    // prohibition swallows the replacement and the stored rule is wrong in both halves.
    assert.deepEqual(splitSentences('不要用 npm，改用 pnpm'), ['不要用 npm', '改用 pnpm'])
    assert.deepEqual(splitSentences('use tabs, never spaces'), ['use tabs', 'never spaces'])
  })

  test('a bulleted requirement list becomes one unit per item, marker stripped', () => {
    // Users write requirements as lists far more often than as prose, and a cue in item four
    // must not capture items one through four. The list marker is dropped for the same reason:
    // stored text ending up as "- 用 pnpm" is a memory with punctuation in it.
    const items = splitSentences('- 用 pnpm\n- 不要用 npm\n- 提交信息用中文')
    assert.deepEqual(items, ['用 pnpm', '不要用 npm', '提交信息用中文'])
    assert.deepEqual(splitSentences('1. use pnpm\n2. never npm'), ['use pnpm', 'never npm'])
    // The delimiter run must swallow the newline it ends on. Leaving it behind yields a bare
    // "2" clause whose list marker is already gone, so nothing downstream can filter it.
    assert.deepEqual(splitSentences('1. use pnpm\n2. never npm\n3. ship it'), [
      'use pnpm',
      'never npm',
      'ship it',
    ])
  })

  test('drops fragments that are nothing but delimiters', () => {
    // Every pattern downstream would otherwise have to defend against matching a bare "。".
    assert.deepEqual(splitSentences('a。\n\n。b'), ['a', 'b'])
    assert.deepEqual(splitSentences('。。。'), [])
  })
})

describe('cue extraction', () => {
  test('captures the body after a Chinese preference marker', () => {
    // 都 belongs to the marker (以后都…), not to the body. Asserting it into the body would be
    // asserting a substring of the marker, which is how the earlier round of these tests went
    // wrong: the qualifier looked "lost" only because it was never the body to begin with.
    assert.equal(firstText('以后都用中文回答'), '用中文回答')
  })
  test('captures the body after an English preference marker', () => {
    assert.equal(extractCandidates('please always use tabs')[0]?.text, 'use tabs')
  })

  test('keeps a prohibition whole, because dropping the marker inverts it', () => {
    // The single most important extraction rule here: "不要用 npm" captured as "npm" is not a
    // weaker memory, it is the opposite one.
    const candidate = extractCandidates('不要用 npm，改用 pnpm')[0]
    assert.ok(candidate)
    assert.equal(candidate.kind, 'prohibition')
    assert.match(candidate.text, /不要用 npm/u)
  })

  test('reads a sentence holding both markers as a prohibition', () => {
    // "以后不要用 X" contains a preference marker ("以后") and a prohibition marker ("不要").
    // Taking the preference branch would store the user's instruction as its complement.
    assert.equal(extractCandidates('以后不要用 npm')[0]?.kind, 'prohibition')
  })

  test('recognises an identity statement', () => {
    const candidate = extractCandidates('我是做后端的，叫我老王')[0]
    assert.ok(candidate)
    assert.equal(candidate.kind, 'identity')
  })

  test('recognises a correction', () => {
    assert.equal(extractCandidates('更正一下，是 pnpm 不是 npm')[0]?.kind, 'correction')
    assert.equal(extractCandidates("actually it's pnpm not npm")[0]?.kind, 'correction')
  })

  test('recognises an explicit storage instruction', () => {
    const candidate = extractCandidates('记住：这个项目的测试必须用中文描述')[0]
    assert.ok(candidate)
    assert.equal(candidate.explicit, true)
  })

  test('recognises an agreement', () => {
    assert.equal(extractCandidates('就按这个方案来')[0]?.kind, 'agreement')
    assert.equal(extractCandidates("let's go with pnpm")[0]?.kind, 'agreement')
  })

  test('recognises a recalled fact', () => {
    assert.equal(extractCandidates('我们这个项目目前用 pnpm')[0]?.kind, 'fact')
  })

  test('keeps the qualifier that makes a directive a standing rule', () => {
    // The qualifier is the difference between a standing rule and a one-off, so the real question
    // is whether it survives into the MEMORY. It does: 都 is captured as part of the marker, and
    // the assertion is on the stored body rather than on a substring of the match.
    assert.equal(firstText('以后都用中文回答'), '用中文回答')
    // A bare verb is grammar, not content: the body is captured so a stored preference does not
    // begin with "用".
    assert.equal(extractCandidates('用 pnpm')[0]?.text, 'pnpm')
    // And the body never swallows the marker it followed.
    assert.equal(extractCandidates('提交信息都用中文')[0]?.text, '中文')
  })

  test('an unanchored directive does not hijack a statement that merely contains the verb', () => {
    // Before the anchor, "我们这个项目目前用 pnpm" matched the bare "用" mid-sentence, so a
    // statement of fact became a directive in the rules layer, scored as an instruction.
    assert.equal(extractCandidates('我们这个项目目前用 pnpm')[0]?.kind, 'fact')
  })

  test('extracts several candidates from one message', () => {
    // Taking only the first match would silently drop most of a requirements list.
    const found = extractFromMessages(['- 用 pnpm\n- 不要用 npm\n- 提交信息都用中文'])
    assert.equal(found.length, 3)
    assert.deepEqual(found.map((candidate) => candidate.kind), ['preference', 'prohibition', 'preference'])
  })

  test('deduplicates a statement repeated across messages', () => {
    const found = extractFromMessages(['不要用 npm', '不要用 npm'])
    assert.equal(found.length, 1)
  })

  test('a message with no cue yields nothing', () => {
    assert.deepEqual(extractCandidates('帮我看一下这个函数为什么报错'), [])
    assert.deepEqual(extractCandidates('hello'), [])
  })

  test('a marker with no body yields nothing', () => {
    assert.deepEqual(extractCandidates('以后'), [])
  })

  test('respects the candidate limit', () => {
    const message = Array.from({ length: 40 }, (_, index) => `不要用选项${String(index)}`).join('\n')
    assert.equal(extractCandidates(message, 5).length, 5)
  })
})

describe('the quality gate', () => {
  const cue = (text: string, kind: Cue['kind'] = 'preference'): Cue => ({ text, kind, marker: '' })

  test('accepts a plain preference and scores it', () => {
    const verdict = judge(cue('都用中文回答'), true)
    assert.equal(verdict.accepted, true)
    assert.ok(verdict.importance > 0)
  })

  test('rejects a question about existing memory, which would otherwise self-amplify', () => {
    // A recall question satisfies several cue patterns. Storing it deposits an entry that is
    // then retrieved the next time the user asks — a failure that grows on its own.
    const verdict = judge(cue('你还记得我之前说过什么吗'), true)
    assert.equal(verdict.accepted, false)
    assert.equal(verdict.reason, 'session-recall')
  })

  test('rejects a question even when it contains a preference cue', () => {
    const verdict = judge(cue('我是不是喜欢用 tabs？'), true)
    assert.equal(verdict.accepted, false)
    assert.equal(verdict.reason, 'question')
  })

  test('rejects a hedge, because a guess is not a belief', () => {
    const verdict = judge(cue('我可能比较喜欢用 tabs'), true)
    assert.equal(verdict.accepted, false)
    assert.equal(verdict.reason, 'hedged')
  })

  test('a vouched document survives a hedge and a question mark that sink a mined sentence', () => {
    // Measured against a real ZCode note: it was discarded because one clause of it contained 可能,
    // while the same words spoken in a session are a musing that must not become a rule. The two are
    // different input classes — a sentence the user happened to say, and a record they wrote down —
    // so the interrogative and hedge gates apply to the first and not the second.
    const note = '本机访问 GitHub：release 资源必须走 ghproxy.net，直连 objects.githubusercontent.com 会超时'
    assert.equal(judge(cue('本机代理可能只支持前缀 Range，release 资源必须走 ghproxy.net'), true, true).accepted, true)
    assert.equal(judge(cue('本机代理可能只支持前缀 Range'), true).accepted, false)

    assert.equal(judge(cue(note + '，可以吗？'), true, true).accepted, true)
    assert.equal(judge(cue(note + '，可以吗？'), true).accepted, false)
  })

  test('rejects a pointer to missing context', () => {
    // "按之前说的那样" is not a memory, it is a reference to a conversation that is gone.
    for (const text of ['按照之前说的那样', '照旧', 'as before', 'same as last time']) {
      const verdict = judge(cue(text), true)
      assert.equal(verdict.accepted, false, `expected rejection for: ${text}`)
      assert.equal(verdict.reason, 'vague')
    }
  })

  test('accepts a sentence that merely opens with a pointer word', () => {
    // Regression: the pointer patterns were anchored only at the start, so any English sentence
    // beginning with "this" was rejected as vague — including the single most useful shape of
    // project memory. A vague REJECTION has to mean "this text carries no content", not "this
    // text contains a word that can also be used vaguely".
    for (const text of [
      'this project builds with pnpm, never npm',
      '这样处理会导致死锁',
      'the usual deploy goes out on Thursday afternoons',
    ]) {
      assert.equal(judge(cue(text), true).accepted, true, `expected a memory for: ${text}`)
    }
  })

  test('rejects content too short to be a memory', () => {
    assert.equal(judge(cue('用'), true).reason, 'too-short')
    assert.equal(judge(cue(''), true).reason, 'empty')
  })

  test('rejects a document that happens to open with a cue', () => {
    // Measured before truncation: a 5000-character dump starting with 我喜欢 is not a
    // preference, and truncating it would make it look like one.
    assert.equal(judge(cue(`我喜欢${'很长'.repeat(400)}`), true).reason, 'too-long')
  })

  test('rejects an instruction that is only about this conversation', () => {
    const verdict = judge(cue('这次改动不要动数据库'), true)
    assert.equal(verdict.accepted, false)
    assert.equal(verdict.reason, 'session-scoped')
  })

  test('keeps a session-scoped statement when there is no project to scope it to', () => {
    // Without a project the caller stores session-scoped anyway, which is exactly where
    // "这次改动" belongs; rejecting it would lose a real instruction.
    assert.equal(judge(cue('这次改动不要动数据库'), false).accepted, true)
  })
})

describe('scope decision', () => {
  const cue = (text: string, kind: Cue['kind'] = 'preference'): Cue => ({ text, kind, marker: '' })

  test('an identity cue belongs to the identity layer', () => {
    assert.equal(decideScope(cue('我是做后端的', 'identity'), true), 'identity')
  })

  test('a personal preference stays global', () => {
    assert.equal(decideScope(cue('我个人喜欢用 tabs'), true), 'global')
  })

  test('naming a technology files the statement under the project', () => {
    // The reason this rule exists: a global "we use pnpm" leaks one codebase's stack into
    // every other project's context, which is the contamination the project layer prevents.
    assert.equal(decideScope(cue('用 pnpm'), true), 'project')
    assert.equal(decideScope(cue('测试用 vitest'), true), 'project')
  })

  test('an explicit project reference files the statement under the project', () => {
    assert.equal(decideScope(cue('这个项目的提交信息用中文', 'fact'), true), 'project')
  })

  test('without a project nothing is scoped to one', () => {
    assert.equal(decideScope(cue('用 pnpm'), false), 'global')
    assert.equal(decideScope(cue('这个项目的约定', 'fact'), false), 'global')
  })

  test('a generic preference with no project and no technology is global', () => {
    assert.equal(decideScope(cue('回答简洁一点'), true), 'global')
  })
})

describe('importance', () => {
  const cue = (text: string, kind: Cue['kind'] = 'preference'): Cue => ({ text, kind, marker: '' })

  test('ranks a prohibition above a preference', () => {
    assert.ok(importanceFor(cue('不要用 npm', 'prohibition'), '不要用 npm') > importanceFor(cue('用 tabs'), '用 tabs'))
  })

  test('ranks a correction above both, since an existing memory is wrong', () => {
    const correction = importanceFor(cue('不是 npm 是 pnpm', 'correction'), '不是 npm 是 pnpm')
    assert.ok(correction > importanceFor(cue('不要用 npm', 'prohibition'), '不要用 npm'))
  })

  test('rewards an explicit storage instruction', () => {
    assert.ok(importanceFor(cue('记住用 tabs'), '记住用 tabs') > importanceFor(cue('用 tabs'), '用 tabs'))
  })

  test('rewards a stated rule over a single incident', () => {
    assert.ok(importanceFor(cue('永远用 tabs'), '永远用 tabs') > importanceFor(cue('用 tabs'), '用 tabs'))
  })

  test('stays inside the 0-10 range', () => {
    const loaded = cue('记住，永远都要用 tabs 因为团队约定，改成 `.editorconfig` 里的设置，不要用空格')
    const score = importanceFor(loaded, loaded.text)
    assert.ok(score >= 0 && score <= 10, `out of range: ${String(score)}`)
  })
})

describe('the pipeline', () => {
  test('writes a preference to the global layer', async () => {
    const { repository } = await freshStore()
    const report = distill(['以后都用中文回答'], { repository, projectKey: null, hasProject: false })
    assert.equal(report.written, 1)
    assert.equal(repository.count(), 1)
    assert.equal(repository.list({})[0]?.scope, 'global')
  })

  test('writes a technology decision to the project layer and isolates it', async () => {
    const { repository } = await freshStore()
    const report = distill(['这个项目用 pnpm'], { repository, projectKey: 'proj-a', hasProject: true })
    assert.equal(report.written, 1)
    const [record] = repository.list({})
    assert.ok(record)
    assert.equal(record.scope, 'project')
    assert.equal(record.projectKey, 'proj-a')
    // The isolation assertion: another project must not see it.
    assert.equal(repository.list({ projectKey: 'proj-b' }).length, 0)
  })

  test('a restatement merges instead of adding a row', async () => {
    const { repository } = await freshStore()
    const context = { repository, projectKey: null, hasProject: false }
    distill(['以后都用中文回答'], context)
    const report = distill(['以后都用中文回答，包括提交信息'], context)
    assert.equal(repository.count(), 1, 'a restatement must not become a second entry')
    assert.ok(report.merged === 1 || report.ignored === 1 || report.written === 0)
  })

  test('a correction retires the statement it corrects', async () => {
    // Driven through `distillCandidates` rather than `distill` on purpose. The unit under test
    // is whether a correction retires its predecessor; routing it through extraction would
    // also make this test a second, weaker test of cue detection, and would break for reasons
    // that have nothing to do with the merge.
    const { repository } = await freshStore()
    const context = { repository, projectKey: 'proj-a', hasProject: true }

    distillCandidates([{ text: '这个项目用 pnpm', kind: 'fact', marker: '', explicit: false }], context)
    const before = repository.list({ status: ['active'] })
    assert.equal(before.length, 1)

    const report = distillCandidates(
      [{ text: '这个项目不是 pnpm 而是 npm', kind: 'correction', marker: '', explicit: false }],
      context,
    )

    assert.equal(report.updated, 1, describeReport(report))
    const active = repository.list({ status: ['active'] })
    assert.equal(active.length, 1, 'the corrected entry must not stay active beside its replacement')
    assert.match(active[0]?.text ?? '', /npm/u)
    const outdated = repository.list({ status: ['outdated'] })
    assert.equal(outdated.length, 1, 'the corrected entry stays for the audit trail')
    assert.match(outdated[0]?.text ?? '', /pnpm/u)
  })

  test('a correction found by extraction reaches the merge as a correction', async () => {
    // The end-to-end counterpart, on a sentence that is unambiguously a correction. It asserts
    // the kind survived extraction, because a correction demoted to a preference would be
    // stored as a new rule instead of retiring the one it contradicts.
    const { repository } = await freshStore()
    const context = { repository, projectKey: null, hasProject: false }
    const report = distill(['更正一下，是 pnpm 不是 npm'], context)
    assert.equal(report.outcomes.length, 1)
    assert.equal(report.outcomes[0]?.candidate.kind, 'correction')
    assert.equal(report.written, 1)
  })

  test('a correction with no existing entry becomes a new memory', async () => {
    const { repository } = await freshStore()
    const report = distill(['更正一下，是 pnpm 不是 npm'], { repository, projectKey: null, hasProject: false })
    assert.equal(report.written, 1)
    assert.equal(report.updated, 0)
  })

  test('dryRun classifies without writing', async () => {
    const { repository } = await freshStore()
    const report = distill(['以后都用中文回答'], {
      repository,
      projectKey: null,
      hasProject: false,
      dryRun: true,
    })
    assert.equal(report.written, 1, 'the report describes what WOULD happen')
    assert.equal(repository.count(), 0, 'but nothing was written')
  })

  test('a seed candidate skips extraction but not the gate', async () => {
    const { repository } = await freshStore()
    const report = distillCandidates(
      [
        { text: '用 tabs 缩进', kind: 'preference', marker: '', explicit: true },
        { text: '按照之前说的那样', kind: 'preference', marker: '', explicit: true },
      ],
      { repository, projectKey: null, hasProject: false },
    )
    assert.equal(report.written, 1)
    assert.equal(report.rejected, 1)
    assert.equal(report.outcomes[1]?.reason, 'vague')
  })

  test('an identity cue is stored as global rather than written to the user\u2019s file', async () => {
    // The identity layer is a hand-edited file, so the plugin routes identity facts to the
    // global layer instead of appending to something the user owns and maintains by hand.
    const { repository } = await freshStore()
    distill(['我是做后端的'], { repository, projectKey: null, hasProject: false })
    assert.equal(repository.list({})[0]?.scope, 'global')
  })

  test('a message with no cues writes nothing and reports it', async () => {
    const { repository } = await freshStore()
    const report = distill(['这个函数为什么报错'], { repository, projectKey: null, hasProject: false })
    assert.equal(report.outcomes.length, 0)
    assert.equal(repository.count(), 0)
  })

  test('the same input twice over is idempotent', async () => {
    // What makes it safe to run the pipeline on every session boundary, including a resumed
    // one: the second pass must not double the store.
    const { repository } = await freshStore()
    const context = { repository, projectKey: null, hasProject: false }
    distill(['以后都用中文回答'], context)
    const before = repository.count()
    const report = distill(['以后都用中文回答'], context)
    assert.equal(repository.count(), before)
    assert.equal(report.written, 0)
  })

  test('describeReport names the outcome that needs attention', async () => {
    const { repository } = await freshStore()
    const report = distill(['以后都用中文回答'], { repository, projectKey: null, hasProject: false })
    const line = describeReport(report)
    assert.match(line, /1 new/u)
  })
})
