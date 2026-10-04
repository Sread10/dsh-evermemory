import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unwrapConfig } from '../src/config.ts'
import { InjectionState } from '../src/inject/context.ts'
import { openStore } from '../src/storage/db.ts'
import { MemoryRepository } from '../src/storage/repository.ts'

const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), 'evm-probe-')), 'store.sqlite') })
const repository = new MemoryRepository(store.db)

const cfg = unwrapConfig({} as never)
console.log('config:', JSON.stringify(cfg, null, 1))

repository.insert({ text: '不要用 npm', scope: 'global', pinned: true, importance: 9 })
repository.insert({ text: '背景知识一条', scope: 'global' })
repository.insert({ text: '项目约定', scope: 'project', projectKey: 'p'.repeat(16) })

const state = new InjectionState()
const text = state.rebuild({ repository, config: cfg, projectKey: 'p'.repeat(16), cards: () => repository.list({ limit: 5 }) })
console.log('--- text ---')
console.log(JSON.stringify(text))
console.log('report:', JSON.stringify(state.report?.outcomes))
console.log('rows:', repository.list({ limit: 10 }).map((r: { id: number }) => r.id))
store.db.close()
