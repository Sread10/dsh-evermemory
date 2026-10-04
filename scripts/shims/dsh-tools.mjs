/**
 * Test shim for `@deepseek-ai/dsh-tools`.
 *
 * `defineTool` is nearly an identity wrapper in the real package too, but not quite: the real one
 * calls `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema` EAGERLY, so a schema the
 * DSL does not accept throws where the tool is defined. This shim re-implements the subset of that
 * compiler this plugin relies on, for one reason: without it, the tool schemas could only be
 * checked by loading the plugin into a real host, and a mistake would surface as a plugin that
 * fails to mount. Here it surfaces as a failing test.
 *
 * Every rule below was read out of `dsh-tools/lib/index.js` (0.1.7-rc.2), not invented:
 *
 *  - `:700` an `object` node MUST carry an explicit boolean `additionalProperties`;
 *  - `:669` `oneOf` needs at least two branches and cannot sit beside `type`;
 *  - `:738-743` scalars accept `enum`/`const`; `:746` `enum` must be a non-empty scalar array;
 *  - `:694-698` objects accept only type/properties/additionalProperties (+ annotations);
 *  - `:715-719` arrays accept only type/items (+ annotations);
 *  - `:538` annotations are description/title/default/examples; `required` is a property-map key
 *    only, which is why an output schema cannot mark a field required.
 */

/** Node keys that may appear anywhere. `required` is legal only inside a `parameters` map. */
const ANNOTATIONS = ['description', 'title', 'default', 'examples']

const SCALARS = ['string', 'number', 'integer', 'boolean', 'null']

/**
 * Check one author node against the DSL's vocabulary.
 *
 * @param spec - the node to check.
 * @param path - dotted path used in the error, so a failure names the field and not just the tool.
 * @param allowRequired - true only for entries of a `parameters` property map.
 */
function checkSpec(spec, path, allowRequired) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError(`defineTool: ${path} must be a value schema object`)
  }

  const allowed = [...ANNOTATIONS, ...(allowRequired ? ['required'] : [])]
  const type = spec.type

  if (spec.oneOf !== undefined) {
    if (type !== undefined) throw new TypeError(`defineTool: ${path} cannot declare both type and oneOf`)
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) {
      throw new TypeError(`defineTool: ${path}.oneOf must be an array of at least two value schemas`)
    }
    rejectUnknown(spec, [...allowed, 'oneOf', 'type'], path)
    spec.oneOf.forEach((branch, index) => checkSpec(branch, `${path}.oneOf[${index}]`, false))
    return
  }

  if (type === 'json') {
    rejectUnknown(spec, [...allowed, 'type'], path)
    return
  }

  if (type === 'object') {
    rejectUnknown(spec, [...allowed, 'type', 'properties', 'additionalProperties'], path)
    if (typeof spec.additionalProperties !== 'boolean') {
      throw new TypeError(`defineTool: ${path}.additionalProperties must be explicitly true or false`)
    }
    for (const [key, child] of Object.entries(spec.properties ?? {})) {
      checkSpec(child, `${path}.properties.${key}`, allowRequired)
    }
    return
  }

  if (type === 'array') {
    rejectUnknown(spec, [...allowed, 'type', 'items'], path)
    if (spec.items !== undefined) checkSpec(spec.items, `${path}.items`, false)
    return
  }

  if (SCALARS.includes(type)) {
    rejectUnknown(spec, [...allowed, 'type', 'enum', 'const'], path)
    if (spec.enum !== undefined) {
      if (!Array.isArray(spec.enum) || spec.enum.length === 0) {
        throw new TypeError(`defineTool: ${path}.enum must be a non-empty array of scalar values`)
      }
    }
    return
  }

  throw new TypeError(
    `defineTool: ${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`,
  )
}

/** Reject any key the DSL does not know, the way `assertAuthorKeys` does. */
function rejectUnknown(spec, allowed, path) {
  for (const key of Object.keys(spec)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`defineTool: ${path}.${key} is not a supported keyword (allowed: ${allowed.join('/')})`)
    }
  }
}

/**
 * Wrap a tool definition, checking its schemas the way the real compiler does.
 *
 * @param definition - the definition.
 * @returns the same object, unchanged.
 */
export function defineTool(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError('defineTool: definition must be an object')
  }
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    throw new TypeError('defineTool: definition.name must be a non-empty string')
  }
  if (typeof definition.description !== 'string' || definition.description.length === 0) {
    throw new TypeError(`defineTool: tool "${definition.name}" must declare a description`)
  }
  if (typeof definition.execute !== 'function') {
    throw new TypeError(`defineTool: tool "${definition.name}" must declare execute`)
  }
  if (definition.output === null || typeof definition.output !== 'object' || typeof definition.output.render !== 'function') {
    throw new TypeError(`defineTool: tool "${definition.name}" must declare output { schema, render }`)
  }
  if (definition.timeoutMs !== undefined && !(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0)) {
    throw new Error(`defineTool(${definition.name}): timeoutMs must be a positive finite number`)
  }
  if (definition.isConcurrencySafe !== undefined && typeof definition.isConcurrencySafe !== 'function') {
    throw new TypeError(`defineTool: tool "${definition.name}": isConcurrencySafe must be a function`)
  }

  for (const [key, spec] of Object.entries(definition.parameters ?? {})) {
    checkSpec(spec, `parameters.${key}`, true)
  }
  checkSpec(definition.output.schema, 'output.schema', false)

  return definition
}
