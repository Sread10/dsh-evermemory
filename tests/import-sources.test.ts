/**
 * Tests for the four file-import sources (`src/importers/sources/*.ts`).
 *
 * Every fixture is written at run time into a fresh temporary directory. These are other people's
 * file layouts, and a checked-in copy of one would rot quietly while the parser kept passing; a
 * fixture built in the test says what the parser is expected to understand, in the same place as the
 * expectation.
 *
 * The assertions worth reading are the ones about what a source REFUSES: assistant turns, `isMeta`
 * bookkeeping, `subagents/` sidechains, ZCode's regenerated index, and the second copy of a memory
 * that three generations of the WorkBuddy store each hold. Those refusals are the entire value of the
 * source — a parser that imports everything is indistinguishable from no parser at all.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'

import { scanChatGpt } from '../src/importers/sources/chatgpt.ts'
import {
  scanClaudeCode,
  scanClaudeMemories,
  scanClaudeWeb,
} from '../src/importers/sources/claude.ts'
import { scanWorkBuddy } from '../src/importers/sources/workbuddy.ts'
import { scanZCode } from '../src/importers/sources/zcode.ts'
import type { ImportItem, ScanOptions, ScanResult, SourceInput } from '../src/importers/types.ts'

/** Caps generous enough that only the tests about caps reach them. */
const OPTIONS: ScanOptions = { maxItems: 500, maxFiles: 50, maxBytes: 8 * 1024 * 1024 }

/** Temporary directories to remove when the suite finishes. */
const roots: string[] = []

/**
 * A fresh temporary directory.
 *
 * @param name - short label, so a leaked directory says which test made it.
 * @returns the directory's absolute path.
 */
function workspace(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `evm-import-${name}-`))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/**
 * Write a fixture file, creating its directory.
 *
 * @param path - absolute path.
 * @param body - file contents.
 * @returns the path, so a fixture can be declared inline.
 */
function write(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, 'utf8')
  return path
}

/** A JSON fixture file. */
function writeJson(path: string, value: unknown): string {
  return write(path, JSON.stringify(value, null, 2))
}

const asDir = (path: string): SourceInput => ({ path, directory: true })
const asFile = (path: string): SourceInput => ({ path, directory: false })

const texts = (result: ScanResult): readonly string[] => result.items.map((item) => item.text)

/**
 * How many items carry exactly this text.
 *
 * @param result - a scan.
 * @param text - the body to count.
 * @returns the count.
 */
function countOf(result: ScanResult, text: string): number {
  return texts(result).filter((entry) => entry === text).length
}

/**
 * Does any item's text contain this fragment?
 *
 * @param result - a scan.
 * @param fragment - substring to look for.
 * @returns true when at least one item contains it.
 */
function anyIncludes(result: ScanResult, fragment: string): boolean {
  return texts(result).some((entry) => entry.includes(fragment))
}

const titles = (result: ScanResult): readonly string[] =>
  result.items.map((item) => item.title ?? '')

const tags = (item: ImportItem): readonly string[] => item.tags ?? []

const STABLE_ID = /^[0-9a-f]{24}$/u

describe('scanChatGpt', () => {
  const conversation = {
    conversation_id: 'conv-trip',
    title: 'Trip planning',
    create_time: 1_700_000_000,
    mapping: {
      root: { id: 'root', parent: null, children: ['n1'], message: null },
      n1: {
        id: 'n1',
        parent: 'root',
        children: ['n2', 'n3'],
        message: {
          id: 'm1',
          author: { role: 'user' },
          create_time: 1_700_000_001,
          content: { content_type: 'text', parts: ['Plan my trip to Kyoto'] },
        },
      },
      n2: {
        id: 'n2',
        parent: 'n1',
        children: [],
        message: {
          id: 'm2',
          author: { role: 'assistant' },
          create_time: 1_700_000_002,
          content: { content_type: 'text', parts: ['Kyoto is lovely in April.'] },
        },
      },
      n3: {
        id: 'n3',
        parent: 'n1',
        children: ['n4'],
        message: {
          id: 'm3',
          author: { role: 'user' },
          create_time: 1_700_000_003,
          content: { content_type: 'text', parts: ['Actually make it Osaka'] },
        },
      },
      n4: {
        id: 'n4',
        parent: 'n3',
        children: [],
        message: {
          id: 'm4',
          author: { role: 'user' },
          create_time: 1_700_000_004,
          content: { content_type: 'text', parts: ['Book it for', '', 'two weeks'] },
        },
      },
    },
  }

  test('emits both children of a regenerated branch exactly once each', () => {
    const file = writeJson(join(workspace('chatgpt'), 'conversations.json'), [conversation])
    const result = scanChatGpt(asFile(file), OPTIONS)

    assert.equal(result.source, 'chatgpt')
    assert.equal(result.label, 'ChatGPT export')
    assert.deepEqual(result.errors, [])
    // n3 is the regenerated branch of n1: the DAG is not walked for a trunk, so both survive — twice
    // would be a bug, zero times would lose what the user actually decided.
    assert.equal(countOf(result, 'Plan my trip to Kyoto'), 1)
    assert.equal(countOf(result, 'Actually make it Osaka'), 1)
    // An empty `parts` entry is not text the user typed.
    assert.equal(countOf(result, 'Book it for\ntwo weeks'), 1)
    assert.equal(result.items.length, 3)
    assert.equal(countOf(result, 'Kyoto is lovely in April.'), 0)
    assert.ok(!anyIncludes(result, 'Kyoto is lovely'))
    // The assistant turn is recognised and deliberately dropped, so it must be countable.
    assert.equal(result.skipped, 1)
    assert.equal(result.truncated, false)
    assert.equal(result.files, 1)
  })

  test('carries a stable id, provenance and the export timestamp', () => {
    const file = writeJson(join(workspace('chatgpt'), 'conversations.json'), [conversation])
    const result = scanChatGpt(asFile(file), OPTIONS)
    const first = result.items[0]
    assert.ok(first !== undefined)
    assert.equal(first.kind, 'utterance')
    assert.deepEqual(tags(first), ['chatgpt'])
    assert.equal(first.uri, `${file}#Trip planning`)
    assert.equal(first.at, new Date(1_700_000_001_000).toISOString())
    const ids = new Set(result.items.map((item) => item.itemId ?? ''))
    assert.equal(ids.size, result.items.length)
    for (const id of ids) assert.match(id, STABLE_ID)
  })

  test('reads every conversations*.json shard and ignores the other files in the export', () => {
    const dir = workspace('chatgpt-shards')
    writeJson(join(dir, 'conversations.json'), [conversation])
    writeJson(join(dir, 'conversations-1.json'), {
      conversations: [
        {
          id: 'conv-shard',
          title: 'Second shard',
          mapping: {
            a: {
              id: 'a',
              message: {
                id: 's1',
                author: { role: 'user' },
                create_time: 1_700_000_100,
                content: { parts: ['From the second shard'] },
              },
            },
          },
        },
      ],
    })
    // A real export ships `message_feedback.json` beside the conversations; reading it as one would
    // invent memories out of thumbs-up records.
    writeJson(join(dir, 'message_feedback.json'), [{ message_id: 'm1', rating: 'thumbs_up' }])

    const result = scanChatGpt(asDir(dir), OPTIONS)
    assert.equal(result.files, 2)
    assert.equal(result.items.length, 4)
    assert.equal(countOf(result, 'From the second shard'), 1)
    assert.ok(!anyIncludes(result, 'thumbs_up'))
  })

  test('honours maxItems and says the scan was cut short', () => {
    const file = writeJson(join(workspace('chatgpt-cap'), 'conversations.json'), [conversation])
    const result = scanChatGpt(asFile(file), { ...OPTIONS, maxItems: 1 })
    assert.equal(result.items.length, 1)
    assert.equal(result.truncated, true)
  })
})

describe('scanClaudeWeb', () => {
  const exportJson = {
    conversations: [
      {
        uuid: 'conv-deploy',
        name: 'Deploy notes',
        created_at: '2024-05-01T10:00:00.000Z',
        chat_messages: [
          {
            uuid: 'c1',
            sender: 'human',
            created_at: '2024-05-01T10:00:01.000Z',
            text: 'How do I deploy the plugin?',
          },
          {
            uuid: 'c2',
            sender: 'assistant',
            created_at: '2024-05-01T10:00:02.000Z',
            content: [{ type: 'text', text: 'Run pnpm build and restart.' }],
          },
          {
            uuid: 'c3',
            sender: 'human',
            created_at: '2024-05-01T10:00:03.000Z',
            content: [{ type: 'text', text: 'Here is the config I use.' }],
            attachments: [{ extracted_content: 'server: prod\nport: 8080' }],
          },
        ],
      },
    ],
  }

  test('keeps the attachment marker so the runner can cut at it', () => {
    const file = writeJson(join(workspace('claude-web'), 'conversations.json'), exportJson)
    const result = scanClaudeWeb(asFile(file), OPTIONS)

    assert.equal(result.source, 'claude')
    assert.equal(result.items.length, 2)
    assert.equal(result.skipped, 1)
    const config = result.items[1]
    assert.ok(config !== undefined)
    // The marker is kept, not cut: the runner decides where a memory ends, and the attachment body
    // is often the densest material in the conversation — dropping it here would lose it for good.
    assert.ok(config.text.includes('[上传附件正文]'))
    assert.ok(config.text.indexOf('[上传附件正文]') < config.text.indexOf('server: prod'))
    assert.equal(countOf(result, 'Run pnpm build and restart.'), 0)
    assert.equal(result.items[0]?.uri, `${file}#Deploy notes`)
    assert.equal(result.items[0]?.kind, 'utterance')
    assert.deepEqual(tags(result.items[0]), ['claude'])
  })

  test('finds conversations.json inside the directory it was pointed at', () => {
    const dir = workspace('claude-web-dir')
    writeJson(join(dir, 'conversations.json'), exportJson)
    const result = scanClaudeWeb(asDir(dir), OPTIONS)
    assert.equal(result.items.length, 2)
    assert.equal(result.errors.length, 0)
  })
})

describe('scanClaudeMemories', () => {
  const memories = {
    conversations_memory:
      '**Work context**\nI work on the DSH plugin.\n\n**Preferences**\nAlways answer in Chinese.',
    project_memories: { 'abcdef1234567890': 'The repo uses pnpm workspaces.' },
    memory_files: [{ path: '/areas/architecture.md', content: 'Layers: scan, distill, merge.' }],
  }

  test('imports all three fields with informative, distinct titles', () => {
    const file = writeJson(join(workspace('claude-memories'), 'memories.json'), memories)
    const result = scanClaudeMemories(asFile(file), OPTIONS)

    assert.equal(result.items.length, 4)
    assert.equal(result.skipped, 0)
    const found = titles(result)
    // A shared template label makes the merge gate see every entry as the same topic: on a real
    // export, 20 entries labelled "Claude memory · <section>" produced 169 mutual conflicts. Distinct
    // titles are the fix, so distinctness is asserted rather than assumed.
    assert.equal(new Set(found).size, found.length)
    for (const title of found) {
      assert.ok(title.includes(' · '), `title should carry a summary: ${title}`)
      assert.ok(title.length <= 61, `title should be cut to 60 characters: ${title}`)
    }
    assert.ok(found.includes('Work context · I work on the DSH plugin'))
    assert.ok(found.includes('Preferences · Always answer in Chinese'))
    assert.ok(found.some((title) => title.includes('Claude project memory · abcdef12')))
    assert.ok(found.some((title) => title.includes('architecture.md')))
    for (const item of result.items) {
      assert.equal(item.kind, 'entry')
      const itemTags = tags(item)
      assert.ok(itemTags.includes('claude'))
    }
  })

  test('keeps the two sections of conversations_memory apart', () => {
    const file = writeJson(join(workspace('claude-memories-split'), 'memories.json'), memories)
    const result = scanClaudeMemories(asFile(file), OPTIONS)
    assert.equal(countOf(result, 'I work on the DSH plugin.'), 1)
    assert.equal(countOf(result, 'Always answer in Chinese.'), 1)
    const ids = new Set(result.items.map((item) => item.itemId ?? ''))
    assert.equal(ids.size, result.items.length)
  })
})

describe('scanClaudeCode', () => {
  test('excludes meta lines, thinking blocks, tool results and subagent sidechains', () => {
    const root = workspace('claude-code')
    const session = write(
      join(root, 'my-project', 'sess-1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'sess-1',
          cwd: '/work/app',
          timestamp: '2024-06-01T09:00:00.000Z',
          message: { role: 'user', content: 'Please use pnpm, not npm.' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sess-1',
          timestamp: '2024-06-01T09:00:05.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Understood.' },
              { type: 'thinking', thinking: 'SECRET REASONING' },
              { type: 'tool_use', name: 'Bash', input: { command: 'npm install' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          isMeta: true,
          sessionId: 'sess-1',
          timestamp: '2024-06-01T09:00:07.000Z',
          message: { role: 'user', content: 'META BOOKKEEPING' },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'sess-1',
          timestamp: '2024-06-01T09:00:09.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOL OUTPUT' }] },
        }),
        'this line is not JSON at all',
      ].join('\n'),
    )
    write(
      join(root, 'my-project', 'subagents', 'agent-x.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 'agent-x',
        timestamp: '2024-06-01T09:01:00.000Z',
        message: { role: 'user', content: 'SIDECHAIN PROMPT' },
      }),
    )

    const result = scanClaudeCode(asDir(root), OPTIONS)
    assert.equal(result.source, 'claude')
    assert.equal(result.label, 'Claude Code transcripts')
    // Only the session transcript is opened: the sidechain under `subagents/` is a delegated agent's
    // tool loop, and its prompts are not the user's own words.
    assert.equal(result.files, 1)
    assert.equal(result.items.length, 1)
    assert.equal(countOf(result, 'Please use pnpm, not npm.'), 1)
    for (const fragment of ['SECRET REASONING', 'META BOOKKEEPING', 'TOOL OUTPUT', 'SIDECHAIN PROMPT']) {
      assert.ok(!anyIncludes(result, fragment), `${fragment} should not be imported`)
    }
    const item = result.items[0]
    assert.ok(item !== undefined)
    assert.equal(item.kind, 'utterance')
    assert.equal(item.uri, `${session}#sess-1`)
    assert.equal(item.at, '2024-06-01T09:00:00.000Z')
    assert.deepEqual(tags(item), ['claude', 'claude-code', '/work/app'])
    assert.match(item.itemId ?? '', STABLE_ID)
    // The assistant turn and the unusable line are recognised, not silently lost.
    assert.ok(result.skipped >= 1)
  })

  test('accepts a single transcript file', () => {
    const root = workspace('claude-code-file')
    const file = write(
      join(root, 'sess-9.jsonl'),
      JSON.stringify({
        type: 'user',
        timestamp: '2024-06-02T09:00:00.000Z',
        message: { role: 'user', content: 'A lone session.' },
      }),
    )
    const result = scanClaudeCode(asFile(file), OPTIONS)
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0]?.uri, `${file}#sess-9`)
  })
})

describe('scanZCode', () => {
  test('imports memory and topics files, strips the project hash, and skips the generated index', () => {
    const root = workspace('zcode')
    const project = join(root, 'projects', 'hrouter-beb03a33e80b027c')
    write(
      join(project, 'memory', 'use-pnpm.md'),
      [
        '---',
        'name: Use pnpm',
        'description: The repo uses pnpm workspaces',
        'type: feedback',
        '---',
        '',
        'Always run `pnpm install`, never `npm install`.',
      ].join('\n'),
    )
    write(
      join(project, 'topics', 'architecture.md'),
      'The importer has four sources and one runner.\n',
    )
    // Regenerated by ZCode on every write: importing it would file the whole store a second time.
    write(join(project, 'memory', 'MEMORY.md'), '# Index\n\n- use-pnpm.md\n')
    write(join(project, 'memory', 'memory_summary.md'), 'INDEX SUMMARY\n')

    const result = scanZCode(asDir(root), OPTIONS)
    assert.equal(result.source, 'zcode')
    assert.equal(result.label, 'ZCode memories')
    assert.deepEqual(result.errors, [])
    assert.equal(result.items.length, 2)
    assert.equal(countOf(result, '- use-pnpm.md'), 0)
    assert.ok(!anyIncludes(result, 'INDEX SUMMARY'))

    const named = result.items.find((item) => item.itemId === 'zcode|hrouter|Use pnpm')
    assert.ok(named !== undefined)
    // The body is kept verbatim: the frontmatter is gone, the code span is not. Stripping fences here
    // would silently rewrite a memory the user wrote.
    assert.equal(named.text, 'Always run `pnpm install`, never `npm install`.')
    assert.equal(named.title, 'Use pnpm')
    assert.deepEqual(tags(named), ['zcode', 'hrouter', 'feedback'])
    assert.equal(named.kind, 'entry')
    // No scope: a ZCode project directory cannot be defended as one of this plugin's project keys, so
    // the project name goes in the tags and the run decides the layer.
    assert.equal('scope' in named, false)
    assert.ok(named.uri.endsWith('#memory'))

    const topic = result.items.find((item) => item.uri.endsWith('#topics'))
    assert.ok(topic !== undefined)
    // No frontmatter at all: the whole file is the body and the name comes from the file name.
    assert.equal(topic.title, 'architecture')
    assert.deepEqual(tags(topic), ['zcode', 'hrouter', 'other'])
    assert.equal(result.skipped, 2)
  })

  test('accepts one project directory or one memory file', () => {
    const root = workspace('zcode-project')
    const project = join(root, 'projects', 'alpha')
    const memoryFile = write(join(project, 'memory', 'note.md'), 'Just a note.\n')

    const byProject = scanZCode(asDir(project), OPTIONS)
    assert.equal(byProject.items.length, 1)
    assert.equal(byProject.items[0]?.title, 'note')

    const byFile = scanZCode(asFile(memoryFile), OPTIONS)
    assert.equal(byFile.items.length, 1)
    assert.equal(byFile.items[0]?.text, 'Just a note.')
  })
})

describe('scanWorkBuddy', () => {
  const MEMORY = [
    '# Build commands',
    '',
    'Always run pnpm install.',
    '',
    '# Review rules',
    '',
    'Read the diff before approving.',
  ].join('\n')

  const TEAM = [
    '# Team conventions',
    '',
    'Always run pnpm install.',
    '',
    '## Testing',
    '',
    'Run node --test.',
  ].join('\n')

  test('reads the harness store and both buddy generations, keeping one copy of each memory', () => {
    const root = workspace('workbuddy')
    const workbuddyFile = write(join(root, '.workbuddy', 'memory', 'team.md'), TEAM)
    // The same memory, written by the next generation of the same tool. The three directories are
    // three generations of ONE store, so this copy must be counted as skipped, not imported twice.
    write(join(root, '.codebuddy', 'memory', 'team.md'), TEAM)
    write(join(root, '.deepseek-harness', 'MEMORY.md'), MEMORY)
    write(join(root, '.deepseek-harness', 'memory', '2026-08-16.md'), 'Shipped the importer.\n')

    const result = scanWorkBuddy(asDir(root), OPTIONS)
    assert.equal(result.source, 'workbuddy')
    assert.equal(result.label, 'WorkBuddy memories')
    assert.deepEqual(result.errors, [])
    assert.equal(result.files, 4)
    // Two sections of MEMORY.md, one whole buddy file, one daily log.
    assert.equal(result.items.length, 4)
    assert.equal(countOf(result, TEAM), 1)
    assert.equal(result.skipped, 1)

    const team = result.items.find((item) => item.text === TEAM)
    assert.ok(team !== undefined)
    // A `.workbuddy/memory` file is ONE memory even when it has headings: splitting it would shatter a
    // document the user wrote as a whole. The first heading still names the entry.
    assert.equal(team.title, 'Team conventions')
    assert.equal(team.uri, `${workbuddyFile}#0`)
    assert.equal(team.itemId, `workbuddy|${workbuddyFile}|0`)
    assert.deepEqual(tags(team), ['workbuddy'])
    assert.equal(team.kind, 'entry')

    const sections = result.items.filter((item) => item.uri.includes('MEMORY.md'))
    assert.equal(sections.length, 2)
    assert.deepEqual(
      sections.map((item) => item.title),
      ['Build commands', 'Review rules'],
    )
    assert.ok(sections.every((item) => tags(item).includes('dsh')))
    assert.equal(sections[0]?.uri, join(root, '.deepseek-harness', 'MEMORY.md') + '#0')

    const daily = result.items.find((item) => tags(item).includes('daily-log'))
    assert.ok(daily !== undefined)
    assert.equal(daily.title, '2026-08-16')
    assert.equal(daily.text, 'Shipped the importer.')
  })

  test('reads a single file it was pointed at', () => {
    const root = workspace('workbuddy-file')
    const file = write(join(root, '.codebuddy', 'memory', 'MEMORY.md'), MEMORY)
    const result = scanWorkBuddy(asFile(file), OPTIONS)
    // Named MEMORY.md, so it is a sections document even when reached through one file path.
    assert.equal(result.items.length, 2)
    assert.deepEqual(tags(result.items[0] ?? { text: '', uri: '' }), ['codebuddy'])
    assert.equal(result.items[0]?.title, 'Build commands')
  })

  test('reports a directory with no store instead of returning an empty success', () => {
    const root = workspace('workbuddy-empty')
    const result = scanWorkBuddy(asDir(root), OPTIONS)
    assert.equal(result.items.length, 0)
    assert.equal(result.errors.length, 1)
  })

  /**
   * One prose block of the real store, padded to the length the live file carries.
   *
   * The real `~/.workbuddy/memory/<workspace-id>_memory.md` is 19,106 bytes, and most of that is the
   * machine trailer repeating the block. The size is the point of the test below, so the paragraph is
   * built rather than typed out.
   */
  const PROSE = '负责把批处理作业迁到统一调度上，同时维护平台组的发布流程和容量规划。'.repeat(32)

  /** The workspace id the real store names its file after. */
  const PROFILE_UID = '2fe0877c-0888-4701-b8ab-024c01741d89'

  /** The bullets of the list section: each one is a separate standing request. */
  const PROFILE_BULLETS = [
    '给导入器补上 WorkBuddy 的真实文件解析',
    '把 RAW_JSON 尾巴从记忆块里去掉',
    '为四个来源各写一个测试',
    '再跑一遍全量类型检查',
  ]

  const PROFILE_BLOCK = [
    '# User Memory Profile',
    '> Last updated: 2026-10-03T05:24:42+08:00',
    '> Version: 57',
    '',
    '## Memory Block',
    '',
    '**工作背景**',
    PROSE,
    '',
    '**个人背景**',
    // Each block opens differently on purpose: a store whose sections were byte-identical would be
    // deduplicated, which is a rule this suite tests elsewhere and does not want to trip over here.
    `长期在上海，习惯用中文写文档。${PROSE}`,
    '',
    '**当前关注**',
    `正在把导入器补齐。${PROSE}`,
    '',
    '**近期动态**',
    ...PROFILE_BULLETS.map((bullet) => `- ${bullet}`),
  ].join('\n')

  /**
   * The live file, trailer included.
   *
   * The trailer repeats the block JSON-escaped, which is what pushes the file past the runner's
   * per-file character budget when a parser keeps it — and the run then drops the whole file as
   * oversized instead of filing the memories.
   */
  const PROFILE = [
    PROFILE_BLOCK,
    '',
    '---',
    '',
    '<!-- RAW_JSON_START',
    JSON.stringify(
      {
        uid: PROFILE_UID,
        memoryBlock: PROFILE_BLOCK,
        version: 57,
        updatedAt: '2026-10-03T05:24:42+08:00',
      },
      null,
      2,
    ),
    'RAW_JSON_END -->',
    '',
  ].join('\n')

  test('reads the real store shape: bold labels, one item per bullet, no machine trailer', () => {
    const root = workspace('workbuddy-real')
    const file = write(join(root, '.workbuddy', 'memory', `${PROFILE_UID}_memory.md`), PROFILE)
    // The store keeps the previous revision beside the live file. A `.md.bak` is not a memory file and
    // must not be read: it holds every byte of the store a second time.
    write(join(root, '.workbuddy', 'memory', `${PROFILE_UID}_memory.md.bak`), PROFILE)
    const size = statSync(file).size
    assert.ok(size >= 19_000, `fixture is only ${size} bytes, so it does not test the real size`)

    const result = scanWorkBuddy(asDir(root), OPTIONS)
    assert.deepEqual(result.errors, [])
    assert.equal(result.files, 1)
    // Three prose sections plus the four bullets of the list section.
    assert.equal(result.items.length, 7)

    for (const fragment of [
      'RAW_JSON_START',
      'RAW_JSON_END',
      'memoryBlock',
      'updatedAt',
      'Last updated',
      'Version:',
    ]) {
      assert.ok(!anyIncludes(result, fragment), `${fragment} reached the distiller`)
    }
    // The scaffolding describes the file rather than recording a memory, so it is neither an entry nor
    // a title, and the `---` that separates the block from the trailer is not part of the last bullet.
    assert.ok(!titles(result).includes('User Memory Profile'))
    assert.ok(!titles(result).includes('Memory Block'))
    assert.ok(!result.items.some((item) => item.text.endsWith('---')))

    // A bold label with prose under it is one entry, titled by the label.
    assert.deepEqual(titles(result).slice(0, 3), ['工作背景', '个人背景', '当前关注'])
    const background = result.items[0]
    assert.ok(background !== undefined)
    assert.ok(background.text.startsWith('负责把批处理作业迁到统一调度上'))
    assert.ok(!anyIncludes(result, '**工作背景**'), 'the label line should not be repeated in the body')
    assert.equal(background.itemId, `workbuddy|${file}|0`)
    assert.equal(background.uri, `${file}#0`)
    assert.deepEqual(tags(background), ['workbuddy'])
    assert.equal(background.kind, 'entry')

    // Each bullet is its own request, and each gets its own title: four entries sharing one label are
    // four entries the merge gate reads as one topic.
    assert.deepEqual(texts(result).slice(3), PROFILE_BULLETS)
    assert.equal(new Set(titles(result)).size, 7)
    for (const item of result.items.slice(3)) {
      assert.ok(item.title?.startsWith('近期动态 · ') === true, `bullet title: ${String(item.title)}`)
    }
  })

  test('accepts a bare *_memory.md file and the user-level memory directory', () => {
    const root = workspace('workbuddy-direct')
    const dir = join(root, '.workbuddy', 'memory')
    const file = write(join(dir, `${PROFILE_UID}_memory.md`), PROFILE)

    // The caller may point straight at `~/.workbuddy/memory`; the directory is named `memory`, so it is
    // read as a memory directory even if no marker store is reachable above it.
    const byDir = scanWorkBuddy(asDir(dir), OPTIONS)
    assert.equal(byDir.files, 1)
    assert.equal(byDir.items.length, 7)

    const byFile = scanWorkBuddy(asFile(file), OPTIONS)
    assert.equal(byFile.items.length, 7)
    assert.deepEqual(tags(byFile.items[0] ?? { text: '', uri: '' }), ['workbuddy'])
  })

  test('drops a trailer whose closing tag never reached the disk', () => {
    const root = workspace('workbuddy-broken')
    write(
      join(root, '.workbuddy', 'memory', `${PROFILE_UID}_memory.md`),
      // An interrupted write: the escaped copy is on disk, the `-->` is not. Everything from the marker
      // down is machine-written, so none of it may be imported.
      `${MEMORY}\n\n<!-- RAW_JSON_START\n{ "memoryBlock": "LEAKED COPY" }\n`,
    )
    const result = scanWorkBuddy(asDir(root), OPTIONS)
    assert.equal(result.items.length, 2)
    assert.ok(!anyIncludes(result, 'LEAKED COPY'))
    assert.ok(!anyIncludes(result, 'RAW_JSON_START'))
  })

  test('leaves the workspace persona files alone and takes only the memory documents', () => {
    const root = workspace('workbuddy-persona')
    const store = join(root, '.workbuddy')
    // The real store root: `MEMORY.md` holds the user's long-term preferences, and the files beside it
    // are the workspace's persona templates. BOOTSTRAP.md's own text calls SOUL.md / IDENTITY.md /
    // USER.md "the source of truth for future runs" and tells the agent to fill them in, so they answer
    // their own bullets with placeholders instead of facts.
    const memory = write(
      join(store, 'MEMORY.md'),
      '# User long-term preferences\n\n- Prefers options before decisions\n',
    )
    write(join(store, 'BOOTSTRAP.md'), '# BOOTSTRAP.md\n\n_Time to pin down who you are._\n')
    write(join(store, 'SOUL.md'), '# SOUL.md - Who You Are\n\n- **Vibe:**\n  _(how do you come across?)_\n')
    write(join(store, 'IDENTITY.md'), '# IDENTITY.md - Who Am I?\n\n- **Name:**\n  _(pick something you like)_\n')
    write(join(store, 'USER.md'), '# USER.md - About Your Human\n\n- **Pronouns:** _(optional)_\n- **City:**\n')
    write(join(store, 'memory', `${PROFILE_UID}_memory.md`), PROFILE)

    const result = scanWorkBuddy(asDir(store), OPTIONS)
    assert.deepEqual(result.errors, [])
    // Two memory documents — MEMORY.md and the profile under memory/ — and none of the four templates.
    // Measured on the real store, taking every Markdown file in that directory produced 50 items out of
    // one empty template, with `Emoji:**` and `Pronouns:** _(optional)_` among the stored titles.
    assert.equal(result.files, 2)
    assert.equal(result.items.length, 8)
    assert.ok(result.items.some((item) => item.uri.startsWith(memory)))
    for (const item of result.items) {
      assert.ok(
        !/pick something you like|how do you come across|pin down who you are|optional/u.test(item.text),
        `persona text imported: ${item.text}`,
      )
    }
  })

  test('an item that is only a label with a placeholder is not a memory', () => {
    const root = workspace('workbuddy-placeholder')
    write(
      join(root, '.workbuddy', 'MEMORY.md'),
      ['# Profile', '', '- **Name:**', '- **Pronouns:** _(optional)_', '- 目标城市：广州', '- 记住：'].join('\n'),
    )
    const result = scanWorkBuddy(asDir(root), OPTIONS)
    assert.deepEqual(result.errors, [])
    // Only the bullet that says something survives; a label whose value is missing or is the instruction
    // to fill it in is scaffolding, and storing it would put a line in the index that carries nothing.
    assert.equal(result.items.length, 1)
    assert.match(result.items[0]?.text ?? '', /广州/u)
  })
})

describe('missing paths', () => {
  const missing = (): string => join(workspace('missing'), 'nowhere', 'not-here')

  test('every source reports the path instead of throwing', () => {
    const scans = [
      { name: 'chatgpt', run: (path: string) => scanChatGpt(asFile(path), OPTIONS) },
      { name: 'claude web', run: (path: string) => scanClaudeWeb(asFile(path), OPTIONS) },
      { name: 'claude memories', run: (path: string) => scanClaudeMemories(asFile(path), OPTIONS) },
      { name: 'claude code', run: (path: string) => scanClaudeCode(asDir(path), OPTIONS) },
      { name: 'zcode', run: (path: string) => scanZCode(asDir(path), OPTIONS) },
      { name: 'workbuddy', run: (path: string) => scanWorkBuddy(asDir(path), OPTIONS) },
    ]
    for (const scan of scans) {
      const path = missing()
      const result = scan.run(path)
      assert.equal(result.items.length, 0, `${scan.name} imported something from a missing path`)
      assert.ok(result.errors.length > 0, `${scan.name} should explain the missing path`)
      assert.ok(
        result.errors[0]?.includes(path) === true,
        `${scan.name} should name the path it could not read: ${String(result.errors[0])}`,
      )
      assert.equal(result.truncated, false)
    }
  })
})
