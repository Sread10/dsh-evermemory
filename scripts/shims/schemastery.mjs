/**
 * Runtime counterpart of `types/shims/schemastery.d.ts`.
 *
 * The test loader hook (`scripts/peer-hooks.mjs`) redirects `@deepseek-ai/schemastery` here
 * so `src/config.ts` can be imported — and the exported `Config` parsed — with no host and
 * no network.
 *
 * Its one behaviour beyond the fluent chain is that it **remembers default values**. That
 * matters because the shipped `cordis.patch.yml` deliberately carries no `config:` block,
 * so the defaults are what a default install actually runs with. Producing them lets the
 * tests assert the real default configuration instead of a hand-written copy of it.
 */

/** Marker placed on every schema and field so shapes are identifiable at runtime. */
export const kSchema = 'dsh-evermemory/schemastery-stub'

/**
 * Build one field.
 *
 * Every builder method returns a COPY, which is the real package's behaviour and the first
 * trap in `src/config.ts`: calling `.volatile()` for its side effect and discarding the
 * result leaves the field non-volatile.
 *
 * @param kind - the DSL type name.
 * @param inner - element field, for array and dict.
 * @param carried - state accumulated by earlier calls in the chain.
 * @returns a fluent field builder.
 */
function field(kind, inner, carried) {
  const state = { kind, inner, hasDefault: false, fallback: undefined, isVolatile: false, isRequired: false, ...carried }

  /**
   * Copy this field with one state change applied.
   *
   * @param change - the fields to overwrite.
   * @returns a fresh builder; the receiver is untouched.
   */
  const derive = (change) => field(kind, inner, { ...state, ...change })

  return {
    /**
     * Record a fallback.
     *
     * @param value - used when the parsed input omits this field.
     * @returns a copy carrying the marking.
     */
    default: (value) => derive({ fallback: value, hasDefault: true }),

    /** @returns a copy marked user-editable. */
    volatile: () => derive({ isVolatile: true }),

    /** @returns a copy marked mandatory. */
    required: () => derive({ isRequired: true }),

    /** Test-facing view of the recorded state. */
    state,
  }
}

/**
 * The schema factory, conventionally imported as `z`.
 *
 * Only the constructors this plugin's config uses are implemented.
 */
const z = {
  /**
   * Build an object schema.
   *
   * @param fields - the field map.
   * @returns a schema whose `parse()` applies the recorded defaults.
   */
  object(fields) {
    return {
      kind: kSchema,
      fields,

      /**
       * Fill every omitted field from its default.
       *
       * @param input - the raw config object, or nothing.
       * @returns the resolved config.
       */
      parse(input) {
        const source = input !== null && typeof input === 'object' ? input : {}
        const out = {}

        for (const [key, schemaField] of Object.entries(fields)) {
          const supplied = Object.hasOwn(source, key)
          if (supplied) {
            out[key] = source[key]
            continue
          }

          const recorded = schemaField?.state
          if (recorded !== undefined && recorded.hasDefault) {
            // A fresh copy per parse, so a caller mutating an array default cannot leak
            // that mutation into the next parse.
            out[key] = Array.isArray(recorded.fallback) ? [...recorded.fallback] : recorded.fallback
          } else if (recorded !== undefined && recorded.isRequired) {
            throw new Error(`dsh-evermemory(stub): required field "${key}" is missing`)
          }
        }

        return out
      },
    }
  },

  /** @returns a string field. */
  string() {
    return field('string')
  },

  /** @returns a number field. */
  number() {
    return field('number')
  },

  /** @returns a boolean field. */
  boolean() {
    return field('boolean')
  },

  /**
   * @param inner - the element field.
   * @returns an array field.
   */
  array(inner) {
    return field('array', inner)
  },

  /**
   * @param inner - the value field.
   * @returns a record field.
   */
  dict(inner) {
    return field('dict', inner)
  },
}

export default z
