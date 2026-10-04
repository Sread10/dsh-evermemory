/**
 * Minimal stand-in for `@deepseek-ai/dsh-llm`.
 *
 * Only the message constructor is declared, because that is the one value the injection
 * path needs: an injected contribution is a full identified, frozen user-role message
 * object, never a string. Borrowing the host's own constructor is what keeps those
 * messages replayable, compactable and resumable like any other history entry.
 */

/** One block of message content. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Provenance recorded on every message, which is how a snapshot is recognised later. */
export interface MessageSource {
  /** e.g. `'runtime-context'`, `'agent-instructions'`. */
  readonly kind: string
  /** e.g. `'snapshot'`. */
  readonly form?: string
  readonly sections?: readonly { readonly name: string; readonly text: string }[]
}

/** A user-role message. */
export interface UserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly TextBlock[]
  readonly source: MessageSource
}

/**
 * Build a user-role message.
 *
 * @param input - the content blocks and the source to record.
 * @returns a frozen message ready to splice into a `PreStepDecision`.
 */
export declare function createUserMessage(input: {
  content: readonly TextBlock[]
  source: MessageSource
}): UserMessage
