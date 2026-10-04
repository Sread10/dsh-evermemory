/**
 * The panel's data route, tested against the two ways a Host can carry it.
 *
 * The route is the only place where the browser half touches the user's store, so the assertions
 * here are about registration and refusal rather than about formatting: which service makes the
 * route exist, what happens when that service is missing, and what a request that the admission
 * fence turns away looks like.
 *
 * The fake context is structural, like the one in `inject-mount.test.ts`, and models the property
 * that matters: `inject` runs its body only once every named service is present, and runs it when a
 * missing one arrives later. A fake that ran the body immediately would test the route under a
 * condition the real Host never produces.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { API_ROUTE_PREFIX } from '../src/constants.ts'
import { mountPanelRoute } from '../src/panel/route.ts'
import type { PanelHandler } from '../src/panel/api.ts'
import { StoreHandle } from '../src/storage/handle.ts'
import { openStore } from '../src/storage/db.ts'
import { databasePath } from '../src/storage/paths.ts'
import { MemoryRepository } from '../src/storage/repository.ts'
import type { NewMemory } from '../src/storage/repository.ts'

/** A service the test can publish, and the injections waiting for one. */
class FakeContext {
  readonly services = new Map<string, unknown>()
  readonly channels = new Map<string, PanelHandler>()
  readonly registeredPrefixes: {
    readonly kind: string
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }[] = []
  readonly disposers: (() => void)[] = []

  get(name: string): unknown {
    return this.services.get(name)
  }

  inject(names: string[], body: (ctx: FakeContext) => void): () => void {
    if (names.every((name) => this.services.has(name))) {
      body(this)
      return () => undefined
    }
    this.pending.push({ names, body })
    return () => undefined
  }

  effect(body: () => unknown): () => void {
    const result = body()
    const dispose = typeof result === 'function' ? (result as () => void) : () => undefined
    this.disposers.push(dispose)
    return dispose
  }

  private readonly pending: { readonly names: readonly string[], readonly body: (ctx: FakeContext) => void }[] = []

  /** Publish a service and run the injections that were waiting for it. */
  provide(name: string, value: unknown): void {
    this.services.set(name, value)
    for (const entry of [...this.pending]) {
      if (!entry.names.every((needed) => this.services.has(needed))) continue
      this.pending.splice(this.pending.indexOf(entry), 1)
      entry.body(this)
    }
  }

  /** A connection that offers the supported channel API. */
  provideOfficialConnection(): void {
    this.provide('connection', {
      rpc: {
        handle: (channel: string, handler: PanelHandler): (() => void) => {
          this.channels.set(channel, handler)
          return () => this.channels.delete(channel)
        },
      },
    })
  }

  /** A connection that offers only the admission fence, with `reject` as its answer. */
  provideFencedConnection(reject: (request: unknown) => number | undefined): void {
    this.provide('connection', { requestRejection: reject })
  }

  /** A web server that records what it is asked to carry. */
  provideWebServer(): void {
    this.provide('webServer', {
      register: (route: {
        readonly kind: string
        readonly path: string
        readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): (() => void) => {
        this.registeredPrefixes.push(route)
        return () => undefined
      },
    })
  }
}

const homes: string[] = []
const handles: StoreHandle[] = []

after(async () => {
  // A `StoreHandle` opens the database on first use and holds it open, and Windows refuses to
  // remove a file another handle still holds. Closing first is what makes the cleanup below honest
  // rather than merely quiet.
  for (const handle of handles) await handle.close()
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

/** A store on disk holding the given rows, and a handle for it. */
async function prepareStore(rows: readonly NewMemory[] = []): Promise<{ home: string, store: StoreHandle }> {
  const home = mkdtempSync(join(tmpdir(), 'evm-panel-route-'))
  homes.push(home)
  const opened = await openStore({ dshHome: home })
  if (rows.length > 0) {
    const repository = new MemoryRepository(opened.db)
    for (const row of rows) repository.insert(row)
  }
  opened.db.close()
  const store = new StoreHandle(home)
  handles.push(store)
  return { home, store }
}

/** One stored row, with the fields a test does not care about filled in. */
function row(text: string): NewMemory {
  return { title: text, text, scope: 'global', tags: [] }
}

/** A request the fallback route can read: a POST with a JSON body. */
function fakeRequest(url: string, body: unknown, contentType = 'application/json'): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  return {
    method: 'POST',
    url,
    headers: { 'content-type': contentType },
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  } as unknown as IncomingMessage
}

/** A response that records its status, headers and body instead of writing to a socket. */
function fakeResponse(): { readonly res: ServerResponse, readonly status: number, readonly body: string } {
  const record = {
    status: 0,
    body: '',
    writeHead(status: number): void {
      record.status = status
    },
    end(chunk?: string): void {
      record.body = chunk ?? ''
    },
  }
  return { res: record as unknown as ServerResponse, get status() { return record.status }, get body() { return record.body } }
}

describe('the panel data route', () => {
  test('registers nothing until the connection service exists, then claims the channel', async () => {
    const { store } = await prepareStore([row('a preference')])
    const ctx = new FakeContext()

    mountPanelRoute(ctx as never, store)

    // The whole point of the optional-service pattern: a Host without a connection service must get
    // a working plugin, not a registration that throws during mount.
    assert.equal(ctx.channels.size, 0)

    ctx.provideOfficialConnection()

    assert.deepEqual([...ctx.channels.keys()], [API_ROUTE_PREFIX])
  })

  test('answers a panel call through the registered channel', async () => {
    const { home, store } = await prepareStore([row('first'), row('second')])
    const ctx = new FakeContext()
    mountPanelRoute(ctx as never, store)
    ctx.provideOfficialConnection()

    const handler = ctx.channels.get(API_ROUTE_PREFIX)
    assert.ok(handler !== undefined)

    const answer = (await handler('overview', {})) as { readonly ok: boolean, readonly value: { readonly total: number, readonly database: string | null } }
    assert.equal(answer.ok, true)
    assert.equal(answer.value.total, 2)
    assert.equal(answer.value.database, databasePath(home))
  })

  test('reports an unknown method as a failure value, not as a throw', async () => {
    const { store } = await prepareStore()
    const ctx = new FakeContext()
    mountPanelRoute(ctx as never, store)
    ctx.provideOfficialConnection()

    const handler = ctx.channels.get(API_ROUTE_PREFIX)
    const answer = (await handler?.('nonsense', {})) as { readonly ok: boolean, readonly error: { readonly code: string } }

    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'request/invalid')
  })

  test('falls back to a fenced prefix route when the connection offers no channel API', async () => {
    const { store } = await prepareStore([row('a preference')])
    const ctx = new FakeContext()
    mountPanelRoute(ctx as never, store)

    ctx.provideFencedConnection(() => undefined)
    assert.equal(ctx.registeredPrefixes.length, 0, 'the route waits for a web server to carry it')

    ctx.provideWebServer()

    assert.equal(ctx.channels.size, 0)
    assert.equal(ctx.registeredPrefixes.length, 1)
    assert.equal(ctx.registeredPrefixes[0]?.kind, 'prefix')
    assert.equal(ctx.registeredPrefixes[0]?.path, API_ROUTE_PREFIX)
  })

  test('the fallback route answers the connection envelope', async () => {
    const { store } = await prepareStore([row('a preference')])
    const ctx = new FakeContext()
    mountPanelRoute(ctx as never, store)
    ctx.provideFencedConnection(() => undefined)
    ctx.provideWebServer()

    const route = ctx.registeredPrefixes[0]
    assert.ok(route !== undefined)
    const res = fakeResponse()
    await route.handler(
      fakeRequest(`${API_ROUTE_PREFIX}/overview`, { type: 'client-request', rpcId: 'r1', method: 'overview' }),
      res.res,
    )

    assert.equal(res.status, 200)
    const envelope = JSON.parse(res.body) as { readonly type: string, readonly rpcId: string, readonly result: { readonly ok: boolean, readonly value: { readonly total: number } } }
    assert.equal(envelope.type, 'server-response')
    assert.equal(envelope.rpcId, 'r1')
    assert.equal(envelope.result.ok, true)
    assert.equal(envelope.result.value.total, 1)
  })

  test('the fallback route refuses a request the admission fence rejects, without answering panel data', async () => {
    const { store } = await prepareStore([row('a preference')])
    const ctx = new FakeContext()
    mountPanelRoute(ctx as never, store)
    ctx.provideFencedConnection(() => 401)
    ctx.provideWebServer()

    const route = ctx.registeredPrefixes[0]
    assert.ok(route !== undefined)
    const res = fakeResponse()
    await route.handler(
      fakeRequest(`${API_ROUTE_PREFIX}/overview`, { type: 'client-request', rpcId: 'r1', method: 'overview' }),
      res.res,
    )

    assert.equal(res.status, 401)
    assert.equal(res.body, 'unauthorized')
  })

  test('the fallback route answers 404 to a method that is not an endpoint, and 415 to a non-JSON body', async () => {
    const { store } = await prepareStore()
    const ctx = new FakeContext()
    mountPanelRoute(ctx as never, store)
    ctx.provideFencedConnection(() => undefined)
    ctx.provideWebServer()
    const route = ctx.registeredPrefixes[0]
    assert.ok(route !== undefined)

    const nested = fakeResponse()
    await route.handler(
      fakeRequest(`${API_ROUTE_PREFIX}/a/b`, { type: 'client-request', rpcId: 'r1', method: 'overview' }),
      nested.res,
    )
    assert.equal(nested.status, 404)

    const wrongType = fakeResponse()
    await route.handler(fakeRequest(`${API_ROUTE_PREFIX}/overview`, {}, 'text/plain'), wrongType.res)
    assert.equal(wrongType.status, 415)
  })

  test('a host with a web server but no connection service gets no route at all', async () => {
    const { store } = await prepareStore()
    const ctx = new FakeContext()
    mountPanelRoute(ctx as never, store)

    ctx.provideWebServer()

    // Deliberate: the fence that makes reading the user's store over HTTP safe lives in the
    // connection service, so serving without it would be worse than serving nothing.
    assert.equal(ctx.registeredPrefixes.length, 0)
    assert.equal(ctx.channels.size, 0)
  })
})
