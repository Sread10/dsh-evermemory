/**
 * Minimal stand-in for `@deepseek-ai/dsh-tools`.
 *
 * Only two things are needed to describe a tool: the `defineTool` wrapper and the shape of
 * what it accepts. The real `parameters` field is DSH's own property-map DSL — not zod,
 * not schemastery, not raw JSON Schema — compiled internally by
 * `parameterSchemaSpecToJsonSchema`, which rejects any key the DSL does not know.
 *
 * Verified against `dsh-tools/lib/index.js` (0.1.7-rc.2): `defineTool` compiles the parameter
 * map and the output schema EAGERLY, at declaration time, so a malformed schema throws where
 * the tool is defined rather than where it is called.
 */

/** A scalar DSL type name. `json` is author-only and accepts any lossless JSON value. */
export type ScalarType = 'string' | 'number' | 'integer' | 'boolean' | 'null'

/** One property in the `parameters` property map, or one node of an output value schema. */
export interface ParameterSpec {
  /**
   * A DSL type name.
   *
   * `enum`/`const` are supported on scalar specs only, and neither may appear beside `oneOf` —
   * the compiler rejects both combinations loudly, which is why the tool schemas below pin
   * their closed value sets with `enum` instead of a hand-written description.
   */
  readonly type?: ScalarType | 'array' | 'object' | 'json'
  readonly required?: boolean
  readonly description?: string
  readonly items?: ParameterSpec
  readonly properties?: Record<string, ParameterSpec>
  readonly enum?: readonly (string | number | boolean | null)[]
  readonly const?: string | number | boolean | null
  readonly oneOf?: readonly ParameterSpec[]
  /**
   * MANDATORY on every `object` node, and it must be an explicit boolean.
   *
   * Verified in `dsh-tools/lib/index.js:700` — `authorError` fires with
   * "`<path>.additionalProperties must be explicitly true or false`" when the key is absent, so an
   * object schema written without it does not compile at all. Output schemas set it to `false`:
   * the return value is validated with `additionalProperties === false` rejecting undeclared keys,
   * which is what keeps a tool's JSON shape and its schema from drifting apart silently.
   */
  readonly additionalProperties?: boolean
}

/**
 * What `execute` receives besides its arguments.
 *
 * The real object also carries `token`/`callId`/`rootCallId`, which this plugin has no use for.
 */
export interface ToolExecution {
  /** Cancelled when the turn is cancelled. A tool body must observe it. */
  readonly signal: AbortSignal
  /** The tool's own model-facing name. */
  readonly name: string
  /**
   * The agent that issued the call, when the caller is agent-scoped.
   *
   * Typed `unknown` on purpose: this plugin reads `session.header.cwd` off it through its own
   * structural guard rather than trusting a host type it cannot see.
   */
  readonly agent?: unknown
  /** The parent call, for a `run_code` sub-call. Present means this is a nested dispatch. */
  readonly parent?: unknown
}

/**
 * A complete tool definition.
 *
 * Note the two independent shapes: `execute` returns the canonical JSON value matching
 * `output.schema`, and `render` is a separate pure projection of that value into content
 * blocks. Errors are thrown — the registry converts them into model-facing text.
 */
export interface ToolDefinition<Args = unknown, Value = unknown> {
  readonly name: string
  readonly description: string
  /** Required in practice: `defineTool` compiles this immediately and throws when it is absent. */
  readonly parameters: Record<string, ParameterSpec>
  readonly output: {
    readonly schema: ParameterSpec
    readonly render: (args: Args, value: Value) => readonly { readonly type: 'text', readonly text: string }[]
  }
  /** Declarative only: the registry never enforces a deadline from this value. */
  readonly timeoutMs?: number
  readonly deferLoading?: boolean
  /** Answers whether this call may overlap other calls. A function, not a flag. */
  readonly isConcurrencySafe?: (args: Args) => boolean
  execute(args: Args, exec: ToolExecution): Value | Promise<Value>
}

/**
 * The `ctx.tools` service.
 *
 * `register` is called on the plugin context for a global tool and on `agent.ctx` for one that
 * only that agent sees; this plugin does the former. Duplicate names within one layer throw.
 */
export interface ToolsService {
  register<Args, Value>(definition: ToolDefinition<Args, Value>): () => void
  /** Resolves a tool as one scope sees it. Unused here; declared because the host has it. */
  get(name: string, scope?: unknown): ToolDefinition | undefined
}

/**
 * Wrap a tool definition.
 *
 * @param definition - the definition to register with `ctx.tools.register`.
 * @returns the same definition, typed.
 */
export declare function defineTool<Args = unknown, Value = unknown>(
  definition: ToolDefinition<Args, Value>,
): ToolDefinition<Args, Value>
