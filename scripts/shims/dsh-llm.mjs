/**
 * Test shim for `@deepseek-ai/dsh-llm`.
 *
 * `createUserMessage` builds the user-role message the injection path splices into a
 * `PreStepDecision`. The real constructor freezes the result and assigns an id; the shim
 * reproduces the shape the plugin depends on, so a test can assert on the source kind and
 * the rendered text without the host.
 */

let sequence = 0

/**
 * Build a user-role message.
 *
 * @param input - the content blocks and the provenance source.
 * @returns a frozen message.
 */
export function createUserMessage(input) {
  const content = input?.content
  const source = input?.source

  if (!Array.isArray(content)) throw new TypeError('createUserMessage: content must be an array')
  if (source === null || typeof source !== 'object' || typeof source.kind !== 'string') {
    throw new TypeError('createUserMessage: source.kind must be a string')
  }

  sequence += 1

  return Object.freeze({
    id: `msg-${sequence}`,
    role: 'user',
    content: Object.freeze(content.map((block) => Object.freeze({ ...block }))),
    source: Object.freeze({ ...source }),
  })
}
