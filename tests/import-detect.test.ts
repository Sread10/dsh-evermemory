import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { detect, supportedSources } from '../src/importers/detect.ts'
import type { DetectedId } from '../src/importers/detect.ts'

/**
 * Routing: which reader gets which path.
 *
 * The single most important claim here is that detection reads CONTENT, not filenames. Claude and
 * ChatGPT both export a file called `conversations.json`, and the two have opposite shapes — one a
 * flat `chat_messages` array, the other a `mapping` tree. A reader that trusted the name would
 * parse a ChatGPT export as an empty Claude one, report "0 memories imported", and look like it had
 * succeeded. So the first test below hands both vendors the same filename.
 */

const dirs: string[] = []

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A fresh directory to build a fixture in. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evm-detect-'))
  dirs.push(dir)
  return dir
}

/** Write a file (and its parent directories) under a fresh root. */
function fixture(relative: string, content: string): string {
  const root = scratch()
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** What a path was routed to, or `undefined`. */
function routed(path: string): DetectedId | undefined {
  const detected = detect({ path, directory: false })
  return detected?.id
}

/** Route a directory rather than a file. */
function routedDirectory(path: string): DetectedId | undefined {
  return detect({ path, directory: true })?.id
}

describe('detection by content shape', () => {
  test('the same filename routes to two different readers', () => {
    const gpt = fixture('conversations.json', JSON.stringify([{ id: 'c1', mapping: { n1: { message: { author: { role: 'user' } } } } }]))
    const claude = fixture('conversations.json', JSON.stringify([{ uuid: 'u1', chat_messages: [{ sender: 'human', text: 'hi' }] }]))

    assert.equal(routed(gpt), 'chatgpt')
    assert.equal(routed(claude), 'claude-web')
  })

  test('a claude.ai export is recognised by either message key', () => {
    assert.equal(routed(fixture('a.json', '[{"messages":[{"text":"hi"}]}]')), 'claude-web')
    assert.equal(routed(fixture('b.json', '[{"chat_messages":[{"text":"hi"}]}]')), 'claude-web')
  })

  test('a Claude memories file is recognised by its three fields', () => {
    assert.equal(routed(fixture('memories.json', '{"conversations_memory":"**Work**\\nstuff"}')), 'claude-memories')
    assert.equal(routed(fixture('memories.json', '{"project_memories":{"a":"x"}}')), 'claude-memories')
    assert.equal(routed(fixture('memories.json', '{"memory_files":[{"path":"/areas/a.md","content":"x"}]}')), 'claude-memories')
  })

  test('a sharded ChatGPT export is recognised just the same', () => {
    assert.equal(routed(fixture('conversations-1.json', '[{"id":"c","mapping":{}}]')), 'chatgpt')
  })
})

describe('detection of directories and plain files', () => {
  test('a ZCode store is recognised by its projects/<p>/memory layout', () => {
    const path = fixture('projects/alpha-e3b0c44298fc1c14/memory/notes.md', '---\nname: notes\n---\nbody\n')
    const store = join(path, '..', '..', '..', '..') // …/memory/notes.md -> ~/.zcode/cli/memories
    const project = join(path, '..', '..') // …/memory/notes.md -> one project

    // Both roots are real entry points: the store, and a single project inside it.
    assert.equal(routedDirectory(store), 'zcode')
    assert.equal(routedDirectory(project), 'zcode')
  })

  test('a directory of transcripts is Claude Code, and a directory of Markdown is not', () => {
    const transcripts = fixture('sessions/one.jsonl', '{"type":"user","message":{"content":"hi"}}\n')
    assert.equal(routedDirectory(join(transcripts, '..', '..')), 'claude-code')

    const notes = fixture('notes.md', '# Heading\n\nbody\n')
    assert.equal(routedDirectory(join(notes, '..')), 'generic')
  })

  test('a WorkBuddy memory directory is recognised by its marker directory', () => {
    const path = fixture('.workbuddy/memory/MEMORY.md', '- a memory\n')
    return assert.equal(routedDirectory(join(path, '..', '..', '..')), 'workbuddy')
  })

  test('the real WorkBuddy store is not mistaken for a ZCode one', () => {
    // The live shape, verified on disk: ~/.workbuddy/memory/<workspace-id>_memory.md. A ZCode store
    // also has a `memory` directory, so the ZCode rule must not be consulted first — it would hand
    // this store to a reader that expects YAML frontmatter and find nothing.
    const file = fixture('.workbuddy/memory/2fe0877c-0888-4701-b8ab-024c01741d89_memory.md', '# User Memory Profile\n')
    const memoryDir = join(file, '..') // ~/.workbuddy/memory
    const store = join(file, '..', '..') // ~/.workbuddy

    assert.equal(routedDirectory(store), 'workbuddy')
    assert.equal(routedDirectory(memoryDir), 'workbuddy')
    assert.equal(routed(file), 'workbuddy')
    assert.equal(routed(fixture('proj/MEMORY.md', '# Index\n')), 'workbuddy')
    assert.equal(routed(fixture('proj/memory_summary.md', '# Summary\n')), 'generic')
  })

  test('a single JSON Lines file is Claude Code only when it looks like a transcript', () => {
    assert.equal(routed(fixture('session.jsonl', '{"type":"user","sessionId":"s1","isMeta":false}\n')), 'claude-code')
    assert.equal(routed(fixture('export.jsonl', '{"evermemory":1}\n{"text":"a memory"}\n')), 'generic')
  })

  test('Markdown, text and small JSON files fall through to the generic reader', () => {
    assert.equal(routed(fixture('notes.md', '# a\n\nb\n')), 'generic')
    assert.equal(routed(fixture('notes.txt', 'plain\n')), 'generic')
    assert.equal(routed(fixture('memories-ish.json', '[{"text":"a memory"}]')), 'generic')
  })

  test('something unrecognisable is refused rather than guessed at', () => {
    assert.equal(routed(fixture('data.bin', 'not a format')), undefined)
    assert.equal(routedDirectory(scratch()), undefined)
    assert.equal(detect({ path: join(tmpdir(), 'evm-nothing-here', 'x.json'), directory: false }), undefined)
  })
})

describe('the refusal message', () => {
  test('names every shape the importer reads, so the user can pick one', () => {
    const sentence = supportedSources()
    for (const phrase of ['ChatGPT', 'claude.ai', 'memories.json', 'Claude Code', 'ZCode', 'WorkBuddy', 'Markdown']) {
      assert.match(sentence, new RegExp(phrase.replace('.', '\\.'), 'u'), `the message must mention ${phrase}`)
    }
  })
})
