/**
 * Streaming reader for very large JSON exports.
 *
 * A ChatGPT export's `conversations.json` is routinely hundreds of megabytes, and `JSON.parse` on a
 * string that size sits close to V8's maximum string length. Reading it is not optional either: an
 * import that says "your export is too big" is not an importer.
 *
 * So this module never builds the whole document. It walks the file one character at a time through
 * a 64 KiB window, finds the array it was told to find, and hands back one *element* at a time —
 * each element parsed from its own source text, so peak memory is one conversation rather than one
 * export.
 *
 * The scanner is string-aware: `[`, `{` and `,` inside a quoted string are text, not structure, and
 * a backslash escapes the next character. That is the entire grammar it needs, because it does not
 * interpret the document — it only finds where values start and end and lets `JSON.parse` do the rest.
 */

import { closeSync, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

import { describe } from './fs.js'

/** Keys that hold the interesting array in a wrapped export, most specific first. */
export const WRAPPER_KEYS = ['conversations', 'memories', 'items', 'messages', 'data'] as const

/** One step of a streaming read: an element, or the reason the read stopped. */
export type JsonStep = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }

/** Tuning for a streaming read. */
export interface ReadJsonOptions {
  /** Maximum bytes to read from the file in total. */
  readonly maxBytes: number
  /** Maximum bytes for one array element. */
  readonly maxElementBytes: number
}

const CHUNK = 64 * 1024

/** A character window over a file, reading forward only. */
class CharStream {
  #handle: number
  readonly #decoder = new StringDecoder('utf8')
  #buffer = ''
  #position = 0
  #bytes = 0
  readonly #maxBytes: number
  #eof = false
  #truncated = false

  constructor(path: string, maxBytes: number) {
    this.#handle = openSync(path, 'r')
    this.#maxBytes = maxBytes
  }

  get truncated(): boolean {
    return this.#truncated
  }

  #fill(): void {
    if (this.#eof) return
    const room = this.#maxBytes - this.#bytes
    if (room <= 0) {
      this.#eof = true
      this.#truncated = true
      return
    }
    const raw = Buffer.allocUnsafe(Math.min(CHUNK, room))
    const read = readSync(this.#handle, raw, 0, raw.length, this.#bytes)
    if (read <= 0) {
      this.#eof = true
      this.#buffer += this.#decoder.end()
      return
    }
    this.#bytes += read
    this.#buffer += this.#decoder.write(raw.subarray(0, read))
  }

  /** Current character without consuming it, or null at end of input. */
  peek(): string | null {
    while (this.#position >= this.#buffer.length) {
      if (this.#eof) return null
      this.#buffer = ''
      this.#position = 0
      this.#fill()
    }
    return this.#buffer[this.#position] ?? null
  }

  /** Consume and return the current character. */
  next(): string | null {
    const char = this.peek()
    if (char !== null) this.#position += 1
    return char
  }

  /** Close the underlying file. */
  close(): void {
    closeSync(this.#handle)
  }
}

/** Skip whitespace, and optionally commas, at the current position. */
function skip(stream: CharStream, commas: boolean): void {
  for (;;) {
    const char = stream.peek()
    if (char === null) return
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      stream.next()
      continue
    }
    if (commas && char === ',') {
      stream.next()
      continue
    }
    return
  }
}

/** Read one complete JSON value and return its source text. */
function scanValue(stream: CharStream, maxElementBytes: number): { text: string } | { error: string } | null {
  skip(stream, false)
  const first = stream.peek()
  if (first === null) return null
  if (first === '{' || first === '[') return scanContainer(stream, maxElementBytes)
  if (first === '"') return scanString(stream, maxElementBytes)
  return scanLiteral(stream, maxElementBytes)
}

/** Read a brace- or bracket-delimited value, counting depth. */
function scanContainer(stream: CharStream, maxElementBytes: number): { text: string } | { error: string } | null {
  let depth = 0
  let text = ''
  for (;;) {
    const char = stream.next()
    if (char === null) return { error: 'the document ended in the middle of a value' }
    text += char
    if (text.length > maxElementBytes) return { error: `one entry is larger than ${maxElementBytes} bytes` }
    if (char === '"') {
      const inner = scanStringTail(stream, maxElementBytes - text.length)
      if ('error' in inner) return inner
      text += inner.text
      continue
    }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return { text }
    }
  }
}

/** Read a whole string value, including both quotes. */
function scanString(stream: CharStream, maxElementBytes: number): { text: string } | { error: string } | null {
  const quote = stream.next()
  if (quote !== '"') return null
  const tail = scanStringTail(stream, maxElementBytes)
  if ('error' in tail) return tail
  return { text: `"${tail.text}` }
}

/** Read the inside of a string, stopping after the closing quote. */
function scanStringTail(stream: CharStream, budget: number): { text: string } | { error: string } {
  let text = ''
  for (;;) {
    const char = stream.next()
    if (char === null) return { error: 'the document ended inside a string' }
    if (text.length > budget) return { error: `one entry is larger than the element limit` }
    if (char === '\\') {
      const escaped = stream.next()
      if (escaped === null) return { error: 'the document ended inside a string' }
      text += char + escaped
      continue
    }
    text += char
    if (char === '"') return { text }
  }
}

/** Read a number, `true`, `false` or `null`. */
function scanLiteral(stream: CharStream, maxElementBytes: number): { text: string } | { error: string } {
  let text = ''
  for (;;) {
    const char = stream.peek()
    if (char === null || char === ',' || char === ']' || char === '}' || /\s/u.test(char)) break
    stream.next()
    text += char
    if (text.length > maxElementBytes) return { error: 'one entry is larger than the element limit' }
  }
  return text === '' ? { error: 'expected a value' } : { text }
}

/**
 * Stream the elements of a JSON array out of a file.
 *
 * Accepts both shapes the sources actually ship: a bare array, and an object wrapping the array
 * under one of {@link WRAPPER_KEYS}. Anything else is reported rather than guessed at.
 *
 * @param path - file to read.
 * @param options - byte caps.
 * @yields one `JsonStep` per element, then at most one error step.
 */
export function* readJsonArray(path: string, options: ReadJsonOptions): Generator<JsonStep> {
  let stream: CharStream
  try {
    stream = new CharStream(path, options.maxBytes)
  } catch (error) {
    yield { ok: false, error: `cannot read ${path}: ${describe(error)}` }
    return
  }
  try {
    skip(stream, false)
    const first = stream.peek()
    if (first === '[') {
      stream.next()
      yield* readElements(stream, options)
      return
    }
    if (first !== '{') {
      yield { ok: false, error: `${path} is neither a JSON array nor a JSON object` }
      return
    }
    stream.next()
    for (;;) {
      skip(stream, true)
      const char = stream.peek()
      if (char === null) {
        yield { ok: false, error: 'the document ended before the array was found' }
        return
      }
      if (char === '}') {
        yield { ok: false, error: `${path} has no ${WRAPPER_KEYS.join(' / ')} array` }
        return
      }
      const key = scanString(stream, 4096)
      if (key === null || 'error' in key) {
        yield { ok: false, error: 'expected a property name' }
        return
      }
      skip(stream, false)
      if (stream.next() !== ':') {
        yield { ok: false, error: 'expected a colon after a property name' }
        return
      }
      skip(stream, false)
      if (stream.peek() === '[' && WRAPPER_KEYS.includes(JSON.parse(key.text) as (typeof WRAPPER_KEYS)[number])) {
        stream.next()
        yield* readElements(stream, options)
        return
      }
      const skipped = scanValue(stream, options.maxElementBytes)
      if (skipped === null) {
        yield { ok: false, error: 'the document ended in the middle of a property' }
        return
      }
      if ('error' in skipped) {
        yield { ok: false, error: skipped.error }
        return
      }
    }
  } finally {
    stream.close()
  }
}

/** Yield each element of an array whose opening bracket has just been consumed. */
function* readElements(stream: CharStream, options: ReadJsonOptions): Generator<JsonStep> {
  for (;;) {
    skip(stream, true)
    const char = stream.peek()
    if (char === null) {
      yield { ok: false, error: 'the document ended in the middle of the array' }
      return
    }
    if (char === ']') {
      stream.next()
      return
    }
    const value = scanValue(stream, options.maxElementBytes)
    if (value === null) {
      yield { ok: false, error: 'the document ended in the middle of the array' }
      return
    }
    if ('error' in value) {
      yield { ok: false, error: value.error }
      return
    }
    try {
      yield { ok: true, value: JSON.parse(value.text) as unknown }
    } catch (error) {
      yield { ok: false, error: `one entry is not valid JSON: ${describe(error)}` }
      return
    }
  }
}
