import { CUE_PATTERNS, splitSentences } from '../src/distill/patterns.ts'
import { extractCandidates } from '../src/distill/extract.ts'

for (const s of ['以后都用中文回答', '提交信息都用中文', '用 pnpm', '我们这个项目目前用 pnpm']) {
  console.log(`\n--- ${JSON.stringify(s)}`)
  for (const [i, pattern] of CUE_PATTERNS.entries()) {
    const m = pattern.re.exec(s)
    if (m === null) continue
    console.log(`    #${i} ${pattern.kind.padEnd(11)} whole=${String(pattern.whole)} cap=${String(pattern.capture)} m[0]=${JSON.stringify(m[0])} m[1]=${JSON.stringify(m[1])}`)
  }
  console.log(`    => extracted ${JSON.stringify(extractCandidates(s).map((c) => c.text))}`)
}

console.log('\n--- splitter')
for (const s of ['one. two!\nthree?', '1. use pnpm\n2. never npm', '第一句。第二句！']) {
  console.log(`    ${JSON.stringify(s)} -> ${JSON.stringify(splitSentences(s))}`)
}
