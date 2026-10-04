/**
 * Zero-LLM distillation: cue extraction.
 *
 * What this stage does NOT do is decide whether a candidate is true. The rules only see the
 * user's own message, and the whole design leans on that: a memory distilled from what the
 * user asserted is a record of their instruction, which is checkable. A memory distilled from
 * what the assistant inferred is a guess wearing the same clothes, and
 * `dsh-memory-porter`'s intake rule — "AI 推断的绝不自动入库" — is the reason this module reads
 * user messages and nothing else.
 */

import { looksLikePaste, stripAttachment, stripFenced } from './hygiene.js'
import { CORRECTION_LEAD_IN, CUE_PATTERNS, splitSentences, type Cue, type CueKind } from './patterns.js'

/** A cue plus the provenance needed to deduplicate and to explain where it came from. */
export interface Candidate {
  readonly text: string
  readonly kind: CueKind
  readonly marker: string
  /** True when the cue arrived through an explicit "记住"/"remember" instruction. */
  readonly explicit: boolean
  /**
   * True when the caller handed this text over whole rather than a pattern finding it inside a
   * message.
   *
   * It relaxes the judge's length window and nothing else — see {@link judge} for why a vouched
   * paragraph is a different input class from a mined fragment.
   */
  readonly vouched?: boolean
}

/** Markers that make a candidate explicit rather than incidental. */
const EXPLICIT_MARKERS: readonly RegExp[] = [
  /(?:记住|记一下|记下来|帮我记|收录|备查)/u,
  /\b(?:remember (?:that|this)|make a note|note that|keep in mind|for the record)\b/iu,
]

/**
 * Extracts every distinct candidate from one message.
 *
 * One message can hold several: a user listing four requirements in four sentences has stated
 * four things, and taking only the first match would silently drop three of them.
 *
 * Three things are removed before any pattern runs — an attached document's text, fenced code
 * blocks, and a message that is a pasted document end to end. Each one is a machine for producing
 * false memories, because a pasted linter config is full of `must` and `never` and a pasted Chinese
 * document is full of 一律 and 必须, and none of those are judgements this user made.
 */
export function extractCandidates(message: string, limit = 16): Candidate[] {
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  const body = stripFenced(stripAttachment(message))
  if (looksLikePaste(body)) return candidates
  const clauses = splitSentences(body)

  for (const [index, sentence] of clauses.entries()) {
    for (const pattern of CUE_PATTERNS) {
      const match = pattern.re.exec(sentence)
      if (match === null) continue

      let cue = capture(pattern.kind, pattern.capture, pattern.whole, match)
      if (cue === undefined) continue

      // "更正一下" on its own is a memory that corrects nothing. Chinese users introduce a
      // correction in one clause and state it in the next, so the substance is one clause over.
      if (cue.kind === 'correction' && CORRECTION_LEAD_IN.test(cue.text)) {
        const following = clauses[index + 1]
        if (following !== undefined) cue = { ...cue, text: `${cue.text}：${following}` }
      }

      const text = cue.text.trim()
      // A pattern can match several sentences while contributing one cue; the first match per
      // sentence is kept so a single sentence cannot produce a near-duplicate pair.
      const key = text.toLowerCase()
      if (text === '' || seen.has(key)) break
      seen.add(key)

      candidates.push({
        text,
        kind: cue.kind,
        marker: cue.marker,
        explicit: EXPLICIT_MARKERS.some((marker) => marker.test(text) || marker.test(sentence)),
      })
      break
    }
    if (candidates.length >= limit) break
  }

  return candidates
}

/**
 * Classifies one piece of text the caller has already vouched for.
 *
 * The difference from {@link extractCandidates} is that this never rewrites the text. A
 * conversational tool call means "store exactly this", and an extractor that split the input on
 * punctuation would silently drop every clause that matched no cue — the user's sentence would be
 * stored as the fragment of it the patterns happened to recognise. Only the KIND is read from the
 * patterns, because the kind is what decides the layer and the importance.
 *
 * @param text - the text to store, verbatim.
 * @returns a candidate with `explicit: true` and `vouched: true`, since the caller asked for it by
 *   name and handed over the whole text rather than a fragment a pattern matched.
 */
export function classifyCandidate(text: string): Candidate {
  const trimmed = text.trim()
  for (const pattern of CUE_PATTERNS) {
    if (!pattern.re.test(trimmed)) continue
    return { text: trimmed, kind: pattern.kind, marker: '', explicit: true, vouched: true }
  }
  return { text: trimmed, kind: 'fact', marker: '', explicit: true, vouched: true }
}

/**
 * Turns a match into a cue.
 *
 * `whole` keeps the matched text including the marker, which matters whenever the marker is
 * part of the meaning. "不要用 npm" stored as "npm" is not a weaker memory, it is the opposite
 * memory, and a store that occasionally records the inverse of what the user said is worse
 * than one that stores nothing.
 */
function capture(kind: CueKind, group: number | undefined, whole: true | undefined, match: RegExpExecArray): Cue | undefined {
  if (whole === true) {
    const text = clean(match[0])
    return text === '' ? undefined : { kind, text, marker: match[0].trim() }
  }

  if (group === undefined) return undefined
  const body = clean(match[group] ?? '')
  const marker = clean(match[0].slice(0, match[0].length - (match[group]?.length ?? 0)))
  // A remembered marker with no body ("记住。" or "please always.") is intent without content.
  return body === '' ? undefined : { kind, text: body, marker }
}

/** Strips the punctuation that a sentence split leaves attached to a captured body. */
function clean(text: string): string {
  return text
    .replace(/^[\s:：,，、.。;；!！?？\-–—*·]+/u, '')
    .replace(/[\s:：,，、.。;；]+$/u, '')
    .trim()
}

/**
 * Extracts candidates from a batch of user messages, newest last.
 *
 * Used at session end rather than per turn, so the cost is paid once: the extraction is pure
 * string work, but running it on every step would spend it on every step for an answer that is
 * only consumed when the session ends.
 */
export function extractFromMessages(messages: readonly string[], limit = 64): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    for (const candidate of extractCandidates(message, limit)) {
      const key = candidate.text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(candidate)
      if (out.length >= limit) return out
    }
  }
  return out
}
