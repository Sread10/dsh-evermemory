/**
 * Minimal stand-in for `@deepseek-ai/schemastery`.
 *
 * This package is special among the peers: it is imported for **runtime** value, not just
 * types, because `Config` is a schema object. It also has to be the DSH build rather than
 * the public `schemastery` — only the DSH build wraps a `.volatile()` field in a cosmokit
 * `Volatile` reference, and the Loader's commit path walks those references. With the
 * public package a preference write reports success while the effective value never
 * changes.
 *
 * The declaration below describes the fluent shape the plugin uses. The runtime
 * counterpart in `scripts/shims/schemastery.mjs` additionally remembers default values so
 * the tests can parse a config with nothing supplied, which is the case the shipped
 * `cordis.patch.yml` relies on (it ships no `config:` block at all).
 */

/** Marker `kind` on every schema and field this stub produces. */
export const kSchema = 'dsh-evermemory/schemastery-stub'

/** State a field builder records, exposed for tests that assert on volatility. */
export interface SchemaFieldState {
  readonly kind: string
  readonly hasDefault: boolean
  readonly fallback: unknown
  readonly isVolatile: boolean
  readonly isRequired: boolean
}

/** A single field's fluent builder. */
export interface SchemaField<T = unknown> {
  /** Supply a fallback used when the input omits this field. */
  default(value: T): SchemaField<T>
  /**
   * Mark the field user-editable.
   *
   * Returns a COPY — the marking is only recorded if the return value is used. Calling it
   * for its side effect leaves the field non-volatile, which makes the whole settings row
   * vanish from `describe()` rather than failing loudly.
   */
  volatile(): SchemaField<T>
  /** Mark the field mandatory. */
  required(): SchemaField<T>
  /**
   * What this builder recorded.
   *
   * The real package does not expose this; the type-checked test shim does, and it is
   * declared here so the volatility assertions in `tests/budget.test.ts` type-check against
   * the same surface the runtime shim provides.
   */
  readonly state?: SchemaFieldState
}

/** An object schema. */
export interface Schema<T = Record<string, unknown>> {
  readonly kind: typeof kSchema
  readonly fields: Record<string, SchemaField>
  /**
   * Apply defaults and return the resolved object.
   *
   * @param input - the raw config, or nothing.
   * @returns the config with every omitted field filled from its default.
   */
  parse(input?: unknown): T
}

/**
 * The schema factory, conventionally imported as `z`.
 *
 * Only the constructors this plugin's config uses are declared; a missing one is a
 * compile error rather than a runtime surprise.
 */
export interface Schemastery {
  object(fields: Record<string, SchemaField>): Schema
  string(): SchemaField<string>
  number(): SchemaField<number>
  boolean(): SchemaField<boolean>
  array(inner: SchemaField): SchemaField<unknown[]>
  dict(inner: SchemaField): SchemaField<Record<string, unknown>>
}

declare const z: Schemastery
export default z
