/**
 * Stitch the browser half into the single artifact the DSH client module system loads.
 *
 * Why this step exists at all: the client module system implements CommonJS with a
 * `require` that resolves against a fixed module table (react, @deepseek-ai/cordis and a
 * handful of client packages). A `client*.js` output therefore cannot synchronously
 * require another relative `client*.js` output — there is no relative-module hook to
 * satisfy it. The safe artifact is one self-contained chunk, which is what this script
 * produces: the `window.__ModuleLoader__.load({ id, factory })` wrapper with the entire
 * bundled body inlined inside the factory.
 *
 * The plugin CSS is inlined as a string and tagged into `document.head` with
 * `data-plugin-css`, which is how first-party packages inject their own stylesheets. Any
 * later CSS import in the client sources is folded into that same string.
 *
 * The wrapper matches the shape every bundle already in this host uses — first-party
 * (`@deepseek-ai/dsh-client-locale`, `dsh-client-connection`), the market plugin
 * (`dshmarket`) and the shipped example (`dsh-better-sidebar`): the same
 * `window.__ModuleLoader__.load({ id, factory })` call, the same `module`/`exports` locals,
 * and the same `Symbol.toStringTag` marker that says these exports are a module namespace.
 * Divergence here is not a style question: this file is the loader's entire contract.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Script } from 'node:vm'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
/** tsdown names a CommonJS-format output `.cjs`, whatever the entry key was. */
const bodyPath = new URL('../lib/client.body.cjs', import.meta.url)

/** `dsh.client.platform === 'web'`, so the bundle id is the package name. */
const bundleId = pkg.name

let body = readFileSync(bodyPath, 'utf8')

/**
 * Markers of a framework that has been inlined instead of left external.
 *
 * This check exists because the failure is invisible until runtime. With React bundled, the
 * build succeeds, the bundle loads, and the plugin then holds a second React instance
 * alongside the one in the module table — at which point hooks throw inside the settings
 * page and nothing points back at the build configuration.
 */
const FORBIDDEN_INLINE = [
  'ReactCurrentOwner',
  '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
  'useSyncExternalStore',
]

for (const marker of FORBIDDEN_INLINE) {
  if (body.includes(marker)) {
    throw new Error(
      `bundle-client: the client body contains "${marker}", so React was bundled rather than left external. ` +
        `Check the REACT_EXTERNALS patterns in tsdown.config.ts — a bundled React is a second React instance ` +
        `and will break hooks at render time.`,
    )
  }
}

/**
 * Every module the body is allowed to `require` at runtime.
 *
 * The client module system resolves `require` against a fixed table, so a specifier that is
 * not in it is a bundle that builds, ships, and then throws on load with no clue which source
 * file asked for it. Two of these are rules this project already states elsewhere: React must
 * stay external (a second instance breaks hooks), and `@deepseek-ai/dsh-client-ui-primitives`
 * is a first-party INTERNAL package a third-party plugin must not depend on.
 */
const ALLOWED_REQUIRES = [/^react$/, /^react\/jsx-runtime$/, /^@deepseek-ai\//]

for (const specifier of body.matchAll(/require\(\s*"([^"]+)"\s*\)/g)) {
  const name = specifier[1]
  if (ALLOWED_REQUIRES.some((pattern) => pattern.test(name))) continue
  throw new Error(
    `bundle-client: the client body requires "${name}", which the DSH client module table does not ` +
      `resolve. Either import it from a package the table provides, or move the code to the host half.`,
  )
}

/**
 * A bundle this size means a dependency was inlined. The plugin's own browser half — five panels,
 * two locale dictionaries and the stylesheet — measured 76,311 bytes when this budget was raised
 * from 40 kB, and nothing but `react`/`react/jsx-runtime` was required in it. Anything much past
 * this is a build-configuration error rather than growth in the plugin.
 */
const BODY_BUDGET_BYTES = 120_000
if (body.length > BODY_BUDGET_BYTES) {
  throw new Error(
    `bundle-client: client body is ${body.length} bytes, over the ${BODY_BUDGET_BYTES}-byte budget. ` +
      `A dependency is probably being bundled instead of resolved from the client module table.`,
  )
}

/**
 * The body is interpolated into the template literal below as a VALUE, so its backticks and
 * `${` are already literal text and must be left exactly as rolldown emitted them.
 *
 * Escaping them here — which this script used to do, from an earlier revision that pasted
 * the body into the template literal by concatenation — writes a backslash in front of every
 * backtick in the shipped file. The bundle still passed every check in this script (a require
 * allow-list and a size budget both read text), the artifact still shipped, and the syntax
 * error only appeared in a browser: `const API_ROUTE_PREFIX = \`/\${PLUGIN_NAME}\`` is not
 * JavaScript. `tests/client-bundle.test.ts` now compiles and loads the artifact, and the
 * assertion below stops this at build time.
 */
const clientCss = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')

const out = `// Generated by scripts/bundle-client.mjs — do not edit. Source: src/client/**
window.__ModuleLoader__.load({
	id: ${JSON.stringify(bundleId)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
		return module.exports;
	},
});

// Plugin stylesheet, injected once and keyed so a reload replaces rather than stacks it.
(function () {
	if (typeof document === 'undefined') return;
	var tagId = ${JSON.stringify(`${bundleId}/style.css`)};
	if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return;
	var tag = document.createElement('style');
	tag.dataset.plugin = ${JSON.stringify(bundleId)};
	tag.dataset.pluginCss = tagId;
	tag.textContent = ${JSON.stringify(clientCss)};
	document.head.appendChild(tag);
})();
`

/**
 * The artifact has to compile, and only compiling can prove it.
 *
 * Every other check here reads the bundle as text, which is exactly how a bundle whose every
 * backtick had been turned into `\`` shipped as 0.1.0: the require allow-list matched, the
 * size budget passed, and the browser got a syntax error instead of a settings panel. A
 * compile costs milliseconds and is the difference between shipping a file and shipping code.
 */
try {
  new Script(out, { filename: 'lib/client.js' })
} catch (error) {
  throw new Error(
    `bundle-client: the artifact does not parse (${error instanceof Error ? error.message : String(error)}). ` +
      `The bundled body must reach the template literal untouched; any step that rewrites its text ` +
      `(escaping backticks or \`\${\`, HTML-escaping, a stray replace) breaks every template literal in it.`,
  )
}

writeFileSync(new URL('../lib/client.js', import.meta.url), out, 'utf8')

// The intermediate body is an implementation detail of the two-step build; leaving it in
// the published `files` list would ship a second copy of the browser half.
rmSync(bodyPath, { force: true })

process.stdout.write(`bundle-client: wrote lib/client.js (${out.length} bytes, id ${bundleId})\n`)
