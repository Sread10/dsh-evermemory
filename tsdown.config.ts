/**
 * Build configuration.
 *
 * Two entries, and the split is not cosmetic:
 *
 *  - `index` becomes `lib/index.js`, the Host half. It is loaded by the Cordis Loader
 *    on the Node side, so every `@deepseek-ai/*` import stays external and unresolved
 *    at build time — those packages are injected by the Host process from the asar and
 *    are NOT installable from the registry at the runtime's version. Bundling them (or
 *    resolving them at build time) would be a correctness bug, not just a size one.
 *
 *  - `client` becomes `lib/client.js`, the browser half. See scripts/bundle-client.mjs
 *    for the second half of its build: the DSH client module system loads a client
 *    bundle as a single self-contained chunk, so the final artifact is the
 *    `window.__ModuleLoader__.load({ id, factory })` wrapper plus one flattened body.
 */
import { defineConfig } from 'tsdown'

/** Every DSH package is supplied by the host. None of them may be bundled. */
const DSH_EXTERNALS = [/^@deepseek-ai\//]

/**
 * React and its JSX runtime, resolved by the client module table at runtime.
 *
 * Keeping these external is not an optimisation — bundling them is a correctness bug. The
 * framework's module table already provides React, so a bundle carrying its own copy gives
 * the plugin a second React instance: hooks throw, and the failure appears only at render
 * time in the browser, never during the build. A regex is used rather than a plain string
 * so `react/jsx-runtime` and any future subpath are covered by the same rule.
 */
const REACT_EXTERNALS = [/^react($|\/)/, /^react-dom($|\/)/]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: false,
    external: DSH_EXTERNALS,
  },
  {
    entry: { 'client.body': 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    external: [...DSH_EXTERNALS, ...REACT_EXTERNALS],
  },
])
