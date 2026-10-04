/**
 * Test shim for `react/jsx-runtime`.
 *
 * Node's type stripping does not transform JSX, so no `.tsx` file under `src/client/` is
 * importable by the test runner. This module therefore only exists so the specifier is not
 * a dangling entry in the loader hook's map; the JSX-bearing components are covered by
 * `ignore` markers on the tsc side and by the token audit for styling.
 *
 * A future test that genuinely needs a component should extract its pure logic into a
 * `.ts` module and test that, rather than reaching for a JSX transform.
 */

/**
 * Element factory used by the automatic JSX runtime.
 *
 * @param type - a tag name or component.
 * @param props - the element's props.
 * @param key - an optional React key.
 * @returns a minimal element description.
 */
export function jsx(type, props, key) {
  return { type, props, key }
}

/** Alias of {@link jsx}; React uses two names for the same thing. */
export const jsxs = jsx

/** Fragment marker. */
export const Fragment = Symbol.for('dsh-evermemory.react-fragment-stub')
