import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractCandidates } from '../src/distill/extract.ts'
import { judge } from '../src/distill/judge.ts'
import { splitSentences } from '../src/distill/patterns.ts'

for (const message of [
  '以后都用中文回答',
  '不要用 npm，改用 pnpm',
  '这个项目用 pnpm',
  '这个项目不要用 pnpm，改用 npm',
  '更正一下，是 pnpm 不是 npm',
  '我是做后端的，叫我老王',
  '- 用 pnpm\n- 不要用 npm\n- 提交信息用中文',
]) {
  console.log(`\n--- ${JSON.stringify(message)}`)
  console.log('  sentences:', JSON.stringify(splitSentences(message)))
  const candidates = extractCandidates(message)
  console.log('  candidates:', candidates.length)
  for (const candidate of candidates) {
    console.log(`    [${candidate.kind}] ${JSON.stringify(candidate.text)} ex=${String(candidate.explicit)}`)
    console.log('      judge:', JSON.stringify(judge(candidate, true)))
  }
}

void mkdtempSync
void tmpdir
void join
