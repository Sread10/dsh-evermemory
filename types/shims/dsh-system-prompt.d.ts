/**
 * Minimal stand-in for `@deepseek-ai/dsh-system-prompt`.
 *
 * The two injection channels behave in opposite ways and the distinction is the core of
 * this plugin's token strategy, so it is worth restating here:
 *
 *   - `section(...)` contributes **system-role prompt text** at the head of the prompt.
 *     Stable per session, paid for once by the prefix cache, but any change rewrites the
 *     head and forfeits reuse from the first changed token. Use for rules and identity.
 *
 *   - `context(...)` contributes a **sourced user-role history snapshot**, appended after
 *     the cached prefix and only when the rendered text actually changed. Use for anything
 *     that varies per turn.
 */

/** A contribution to the system prompt's head. */
export interface PromptSection {
  /** Unique within its layer; a duplicate name throws. */
  readonly name: string
  /** Finite. Sections concatenate ascending; ties break by code-unit name order. */
  readonly order: number
  /** Re-evaluated on every assembly when given as a function. */
  readonly text: string | ((context: unknown) => string)
  /** `false` preserves literal `{{...}}` instead of interpolating it. */
  readonly interpolate?: boolean
  /** `true` makes this section the ENTIRE prompt; two active ones throw. */
  readonly complete?: true
}

/** A contribution to the runtime-context snapshot. */
export interface PromptContext {
  /** Unique within its layer. */
  readonly name: string
  /** Finite. Ordered separately from section orders. */
  readonly order: number
  readonly text: string | ((context: unknown) => string)
}

/** The registry behind `ctx.systemPrompt`. */
export interface SystemPromptService {
  /**
   * Register a prompt-head section.
   *
   * Scope is implicit in the registering context: calling this on an agent-scoped context
   * shadows a same-named global for that one agent.
   */
  section(section: PromptSection): () => void

  /** Register a runtime-context contribution. */
  context(context: PromptContext): () => void

  /**
   * Bind a `{{name}}` variable.
   *
   * @param name - must match `/^[a-z][a-z0-9_]*$/`.
   * @param provider - resolved at render time; an unknown or valueless reference throws.
   */
  variable(name: string, provider: (context: unknown) => string | undefined): () => void
}
