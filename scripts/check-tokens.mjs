/**
 * Enforce the project's design-token rule across the browser half.
 *
 * The rule is "no hard-coded visual values": every colour, radius, shadow, and font in
 * `src/client/**` must resolve through a `--dsw-*` custom property, so the plugin follows
 * the host's light/dark theme with no JavaScript. The token vocabulary is `--dsw-alias-*`
 * for semantic use, `--dsw-static-*` for raw palette, and `--dsw-<family>-*` for
 * primitives (radius, shadow, focus ring, fonts).
 *
 * Exemptions, all deliberate:
 *   - `src/client/style.css` is the one file allowed to declare raw values, because it
 *     hosts the fallback custom properties copied from the host primitives.
 *   - Numeric layout values (width, padding, gap, flex) are not design tokens.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_DIR = fileURLToPath(new URL('../src/client', import.meta.url))
const ALLOWLIST = new Set(['style.css'])

/** Colour-ish literals, plus a bare `border-radius` / `box-shadow` that bypasses tokens. */
const RULES = [
  { id: 'hex-colour', re: /#[0-9a-fA-F]{3,8}\b/g, hint: 'use var(--dsw-alias-…) or var(--dsw-static-…)' },
  { id: 'rgb-colour', re: /\brgba?\(\s*\d/g, hint: 'use var(--dsw-alias-…)' },
  { id: 'hsl-colour', re: /\bhsla?\(\s*\d/g, hint: 'use var(--dsw-alias-…)' },
  { id: 'named-colour', re: /:\s*(white|black|red|blue|green|gray|grey)\b/g, hint: 'use var(--dsw-alias-…)' },
  { id: 'raw-radius', re: /border-radius:\s*\d/g, hint: 'use var(--dsw-radius-…)' },
  { id: 'raw-shadow', re: /box-shadow:\s*(?!var\()/g, hint: 'use var(--dsw-shadow-lv…)' },
  { id: 'raw-font', re: /font-family:\s*(?!var\()/g, hint: 'use var(--dsw-font-…)' },
]

/** @returns {string[]} every file under `dir`, recursively. */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const findings = []
let scanned = 0

for (const file of walk(CLIENT_DIR)) {
  const rel = relative(CLIENT_DIR, file).split('\\').join('/')
  if (ALLOWLIST.has(rel)) continue
  if (!['.ts', '.tsx', '.css'].includes(extname(file))) continue
  scanned++

  const text = readFileSync(file, 'utf8')
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.re)) {
      const line = text.slice(0, match.index).split('\n').length
      findings.push(`${rel}:${line}  ${rule.id}  ${JSON.stringify(match[0])}  → ${rule.hint}`)
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`check-tokens: ${findings.length} hard-coded visual value(s)\n`)
  for (const finding of findings) process.stderr.write(`  ${finding}\n`)
  process.exit(1)
}

process.stdout.write(`check-tokens: clean (${scanned} file(s) scanned)\n`)
