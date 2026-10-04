import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'

import { readJsonArray } from '../src/importers/json.ts'
import { cleanZip, extractZip, isZip, listZip } from '../src/importers/zip.ts'

/**
 * The two readers that stand between a user's export and everything else.
 *
 * Both exist for the same reason — a real export does not fit the easy path — and both are the kind
 * of code that fails quietly: an archive offset that is four bytes off extracts a plausible-looking
 * file, and a JSON scanner that does not understand strings splits a conversation in the middle.
 * So these tests are built on hand-made bytes rather than on a library's archive, and they assert on
 * the CONTENT that comes out the far end.
 */

const dirs: string[] = []

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A temporary file with the given bytes. */
function temp(name: string, data: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'evm-reader-'))
  dirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, data)
  return path
}

/**
 * Build a ZIP archive by hand.
 *
 * Deliberately not a library: the point is to feed `zip.ts` bytes whose layout this test controls,
 * including the shapes a real archiver will not produce on demand — an uncompressed entry, an empty
 * entry, an unsupported method.
 */
function archive(entries: readonly { name: string; data: string; method?: 0 | 8 | 12 }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const raw = Buffer.from(entry.data, 'utf8')
    const method = entry.method ?? 8
    const payload = method === 8 ? deflateRawSync(raw) : raw
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + payload.length
  }

  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, central, eocd])
}

/** Everything except the entries a filter declines. */
const keepConversations = (name: string): boolean => name.startsWith('conversations')

describe('zip reader', () => {
  test('extracts a deflated entry and gives back its bytes', async () => {
    const body = JSON.stringify([{ title: 'a conversation', mapping: {} }])
    const path = temp('export.zip', archive([{ name: 'conversations.json', data: body }]))

    const result = await extractZip(path, { filter: keepConversations, maxBytes: 1_000_000, maxEntries: 5 })
    try {
      assert.deepEqual(result.errors, [])
      assert.equal(result.files.length, 1)
      assert.equal(readFileSync(result.files[0] ?? '', 'utf8'), body)
    } finally {
      cleanZip(result.dir)
    }
  })

  test('extracts a stored entry, and reports both shapes in the listing', () => {
    const path = temp('mixed.zip', archive([
      { name: 'conversations.json', data: '[]', method: 0 },
      { name: 'user.json', data: '{"id":1}', method: 8 },
    ]))

    const listed = listZip(path)
    assert.ok(!('error' in listed))
    if ('error' in listed) return
    assert.deepEqual(listed.entries.map((entry) => [entry.name, entry.method]), [
      ['conversations.json', 0],
      ['user.json', 8],
    ])
  })

  test('the filter decides what is written, and the rest is counted as skipped', async () => {
    const path = temp('export.zip', archive([
      { name: 'conversations.json', data: '[{"mapping":{}}]' },
      { name: 'user.json', data: '{"email":"someone"}' },
      { name: 'message_feedback.json', data: '[]' },
    ]))

    const result = await extractZip(path, { filter: keepConversations, maxBytes: 1_000_000, maxEntries: 5 })
    try {
      assert.equal(result.files.length, 1)
      assert.equal(result.entries, 3)
      assert.equal(result.skipped, 2)
      assert.deepEqual(result.errors, [])
    } finally {
      cleanZip(result.dir)
    }
  })

  test('an over-large entry is refused by name rather than by failing the import', async () => {
    const path = temp('export.zip', archive([{ name: 'conversations.json', data: 'x'.repeat(5000) }]))

    const result = await extractZip(path, { filter: keepConversations, maxBytes: 1000, maxEntries: 5 })
    try {
      assert.equal(result.files.length, 0)
      assert.equal(result.skipped, 1)
      assert.match(result.errors[0] ?? '', /over the per-file limit/u)
    } finally {
      cleanZip(result.dir)
    }
  })

  test('an unsupported compression method is named, not guessed at', async () => {
    const path = temp('export.zip', archive([{ name: 'conversations.json', data: '[]', method: 12 }]))

    const result = await extractZip(path, { filter: keepConversations, maxBytes: 1_000_000, maxEntries: 5 })
    try {
      assert.equal(result.files.length, 0)
      assert.match(result.errors[0] ?? '', /compression method 12/u)
    } finally {
      cleanZip(result.dir)
    }
  })

  test('an empty entry extracts as an empty file instead of an illegal byte range', async () => {
    // Stored, not deflated: a deflated empty entry still has a few bytes of stream, so only the
    // stored form actually produces the zero-length data range that used to make Node throw.
    const path = temp('export.zip', archive([{ name: 'conversations.json', data: '', method: 0 }]))

    const result = await extractZip(path, { filter: keepConversations, maxBytes: 1_000_000, maxEntries: 5 })
    try {
      assert.deepEqual(result.errors, [])
      assert.equal(result.files.length, 1)
      assert.equal(readFileSync(result.files[0] ?? '', 'utf8'), '')
    } finally {
      cleanZip(result.dir)
    }
  })

  test('a ZIP64 archive is refused with a sentence a user can act on', async () => {
    const path = temp('big.zip', archive([{ name: 'conversations.json', data: '[]' }]))
    const bytes = readFileSync(path)
    // Claim 65535 entries in the end-of-directory record: the ZIP64 escape value.
    bytes.writeUInt16LE(0xffff, bytes.length - 22 + 10)
    const zip64 = temp('big64.zip', bytes)

    const listed = listZip(zip64)
    assert.ok('error' in listed)
    if (!('error' in listed)) return
    assert.match(listed.error, /ZIP64/u)
    assert.match(listed.error, /unzip it and import the files directly/u)

    const result = await extractZip(zip64, { filter: keepConversations, maxBytes: 1_000_000, maxEntries: 5 })
    try {
      assert.equal(result.files.length, 0)
      assert.equal(result.errors.length, 1)
    } finally {
      cleanZip(result.dir)
    }
  })

  test('a file that is not an archive is reported, and isZip agrees', () => {
    const path = temp('notes.zip', 'this is not a zip, whatever the name says')
    const plain = temp('notes.json', '{"a":1}')

    const listed = listZip(path)
    assert.ok('error' in listed)
    if ('error' in listed) assert.match(listed.error, /not a ZIP archive/u)

    assert.equal(isZip(plain), false)
    assert.equal(isZip(temp('renamed.zip', 'text')), true, 'the extension is honoured for renamed exports')
    assert.equal(isZip(temp('real.zip', archive([{ name: 'a.json', data: '[]' }]))), true)
  })
})

describe('streaming JSON reader', () => {
  /** Collect the values a read produced, asserting there was no error step. */
  function values(path: string): unknown[] {
    const out: unknown[] = []
    for (const step of readJsonArray(path, { maxBytes: 8 * 1024 * 1024, maxElementBytes: 1024 * 1024 })) {
      if (!step.ok) assert.fail(`unexpected error step: ${step.error}`)
      out.push(step.value)
    }
    return out
  }

  test('reads a bare array in order', () => {
    const path = temp('a.json', JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]))
    assert.deepEqual(values(path), [{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  test('reads the array out of a wrapper object, skipping what comes before it', () => {
    const path = temp('b.json', JSON.stringify({ exported_at: '2026-03-04', conversations: [{ id: 'x' }], other: [1, 2] }))
    assert.deepEqual(values(path), [{ id: 'x' }])
  })

  test('is string-aware: brackets, braces and commas inside text are not structure', () => {
    const text = 'use [pnpm], {never npm}, "quoted" and a trailing backslash \\'
    const path = temp('c.json', JSON.stringify([{ id: 1, text }, { id: 2, text: 'second' }]))
    assert.deepEqual(values(path), [{ id: 1, text }, { id: 2, text: 'second' }])
  })

  test('walks a file larger than one read window', () => {
    const big = Array.from({ length: 400 }, (_, index) => ({ id: index, text: 'x'.repeat(400) }))
    const path = temp('d.json', JSON.stringify(big))
    assert.equal(values(path).length, 400)
  })

  test('an element over the element limit stops the read with a reason', () => {
    const path = temp('e.json', JSON.stringify([{ text: 'y'.repeat(5000) }]))
    const steps = [...readJsonArray(path, { maxBytes: 1024 * 1024, maxElementBytes: 100 })]
    assert.equal(steps.length, 1)
    assert.equal(steps[0]?.ok, false)
    if (steps[0] !== undefined && !steps[0].ok) assert.match(steps[0].error, /larger than/u)
  })

  test('a document that is neither array nor object says so', () => {
    const path = temp('f.json', '"just a string"')
    const steps = [...readJsonArray(path, { maxBytes: 1024, maxElementBytes: 1024 })]
    assert.equal(steps[0]?.ok, false)
    if (steps[0] !== undefined && !steps[0].ok) assert.match(steps[0].error, /neither a JSON array nor a JSON object/u)
  })

  test('an object with none of the known keys is reported by the keys it looked for', () => {
    const path = temp('g.json', JSON.stringify({ unrelated: 1 }))
    const steps = [...readJsonArray(path, { maxBytes: 1024, maxElementBytes: 1024 })]
    assert.equal(steps[0]?.ok, false)
    if (steps[0] !== undefined && !steps[0].ok) assert.match(steps[0].error, /no conversations \/ memories/u)
  })

  test('a missing file is an error step, not a throw', () => {
    const steps = [...readJsonArray(join(tmpdir(), 'evm-does-not-exist', 'a.json'), { maxBytes: 1024, maxElementBytes: 1024 })]
    assert.equal(steps.length, 1)
    assert.equal(steps[0]?.ok, false)
  })

  /**
   * The read window is 64 KiB, and everything above walks a file in windows whose edges no element
   * happens to touch. These four put the edge exactly where it hurts: inside a three-byte Chinese
   * character, inside a two-character escape, through an element's own body, and through the array
   * itself. The first is the one a decoder gets wrong — a byte-wise read that ignores the partial
   * character turns 记忆 into replacement characters, and the plugin would then store a memory that
   * says something the user never wrote.
   */
  describe('window boundaries', () => {
    const CHUNK = 64 * 1024
    const OPEN = '[{"text":"'

    /** JSON source for a one-element array whose string body starts at byte `offset`. */
    function padded(body: string, offset: number): string {
      const pad = offset - Buffer.byteLength(OPEN)
      assert.ok(pad > 0, 'the offset must be past the opening bracket')
      return `${OPEN}${'a'.repeat(pad)}${body}"}]`
    }

    test('a Chinese character split across the window is decoded, not replaced', () => {
      const pad = CHUNK - 1 - Buffer.byteLength(OPEN)
      const body = `记${'忆'.repeat(40)}结尾`
      const bytes = Buffer.from(padded(body, CHUNK - 1), 'utf8')
      // The assertion is on WHERE the character sits, not on the scan: without it the test would
      // pass on a machine where the pad happened to land somewhere harmless. 记 is the body's first
      // character, so its three bytes sit at CHUNK-1, CHUNK and CHUNK+1 — one window each side.
      const split = Buffer.from('记', 'utf8')
      assert.equal(split.length, 3)
      for (let i = 0; i < split.length; i += 1) {
        assert.equal(bytes[CHUNK - 1 + i], split[i], 'the character must straddle the window edge')
      }
      assert.deepEqual(values(temp('h.json', bytes)), [{ text: `${'a'.repeat(pad)}${body}` }])
    })

    test('an escape pair split across the window is still one escape', () => {
      const pad = CHUNK - 1 - Buffer.byteLength(OPEN)
      // `\"` with the backslash last in window one: a scanner that forgot the escape state between
      // windows would read that quote as the end of the string and split the element in two.
      const source = `${OPEN}${'a'.repeat(pad)}\\"${'b'.repeat(10)}"}]`
      const read = values(temp('i.json', source))
      assert.deepEqual(read, JSON.parse(source))
      assert.equal((read[0] as { text: string }).text.length, pad + 1 + 10)
    })

    test('an element that spans three windows is one value', () => {
      const body = 'x'.repeat(CHUNK * 2 + 1000)
      const read = values(temp('j.json', JSON.stringify([{ text: body }, { text: 'tail' }])))
      assert.equal(read.length, 2)
      assert.equal((read[0] as { text: string }).text.length, body.length)
      assert.deepEqual(read[1], { text: 'tail' })
    })

    test('a byte cap that cuts the array says so instead of returning what it got', () => {
      const path = temp('k.json', JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]))
      const steps = [...readJsonArray(path, { maxBytes: 12, maxElementBytes: 1024 })]
      assert.equal(steps.length, 2, 'one element, then the reason')
      assert.equal(steps[0]?.ok, true)
      const last = steps[1]
      assert.equal(last?.ok, false)
      // Which of the two end-of-document messages surfaces depends on where the cap falls; both say
      // the file stopped early, and neither pretends the array was complete.
      if (last !== undefined && !last.ok) assert.match(last.error, /ended/u)
    })
  })
})
