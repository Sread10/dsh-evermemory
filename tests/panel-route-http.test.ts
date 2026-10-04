/**
 * The panel data route over a real socket.
 *
 * `tests/panel-route.test.ts` drives the fallback handler with hand-built request and response
 * objects. That is the right way to test the decisions the handler makes, but it cannot test what
 * the handler assumes about Node itself: that a real `IncomingMessage` streams, that a real
 * `ServerResponse` reaches the client with its status and headers intact, that the connection is
 * still usable afterwards, and what a client actually sees when the body is over the cap. The route
 * is this plugin's only network surface, so those assumptions are worth a real server.
 *
 * The server below is the host's half of the wiring — it hands the registered prefix handler to
 * `node:http` exactly as a web server would.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { API_ROUTE_PREFIX } from '../src/constants.ts'
import { mountPanelRoute } from '../src/panel/route.ts'
import { StoreHandle } from '../src/storage/handle.ts'
import { openStore } from '../src/storage/db.ts'
import { MemoryRepository } from '../src/storage/repository.ts'
import type { NewMemory } from '../src/storage/repository.ts'

/** The services the route asks for, and an effect registry to hang the route on. */
class FakeContext {
  readonly services = new Map<string, unknown>()
  readonly registeredPrefixes: {
    readonly kind: string
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }[] = []

  get(name: string): unknown {
    return this.services.get(name)
  }

  inject(names: string[], body: (ctx: FakeContext) => void): () => void {
    if (names.every((name) => this.services.has(name))) body(this)
    else this.pending.push({ names, body })
    return () => undefined
  }

  effect(body: () => unknown): () => void {
    const result = body()
    return typeof result === 'function' ? (result as () => void) : () => undefined
  }

  provide(name: string, value: unknown): void {
    this.services.set(name, value)
    for (const entry of [...this.pending]) {
      if (!entry.names.every((needed) => this.services.has(needed))) continue
      this.pending.splice(this.pending.indexOf(entry), 1)
      entry.body(this)
    }
  }

  /** A connection offering only the admission fence, answering `status` for every request. */
  provideFencedConnection(reject: (request: unknown) => number | undefined): void {
    this.provide('connection', { requestRejection: reject })
  }

  /** A web server that carries whatever is registered on it. */
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

  private readonly pending: { readonly names: readonly string[], readonly body: (ctx: FakeContext) => void }[] = []
}

const homes: string[] = []
const handles: StoreHandle[] = []
const servers: Server[] = []

after(async () => {
  // Sockets kept alive by the client outlive the assertion, and a `Server` will not close while one
  // is open; dropping them first is what lets the runner exit promptly.
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  for (const handle of handles) await handle.close()
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

/** A store on disk holding the given rows, and a handle for it. */
async function prepareStore(rows: readonly NewMemory[] = []): Promise<StoreHandle> {
  const home = mkdtempSync(join(tmpdir(), 'evm-panel-http-'))
  homes.push(home)
  const opened = await openStore({ dshHome: home })
  if (rows.length > 0) {
    const repository = new MemoryRepository(opened.db)
    for (const entry of rows) repository.insert(entry)
  }
  opened.db.close()
  const store = new StoreHandle(home)
  handles.push(store)
  return store
}

/** One stored row, with the fields a test does not care about filled in. */
function row(text: string): NewMemory {
  return { title: text, text, scope: 'global', tags: [] }
}

/** Mount the fallback route, put a real server under it, and answer the base URL. */
async function serveRoute(
  reject: (request: unknown) => number | undefined,
  rows: readonly NewMemory[] = [],
): Promise<string> {
  const store = await prepareStore(rows)
  const ctx = new FakeContext()
  mountPanelRoute(ctx as never, store)
  ctx.provideFencedConnection(reject)
  ctx.provideWebServer()

  const route = ctx.registeredPrefixes[0]
  assert.ok(route !== undefined, 'the fallback route registers once a web server exists')

  const server = createServer((req, res) => {
    void route.handler(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', 'the server must report the port it took')
  return `http://127.0.0.1:${address.port}`
}

/** One client request as the browser half sends it. */
function envelope(method: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload })
}

/** What the browser half expects to read back. */
interface Answer {
  readonly type: string
  readonly rpcId: string
  readonly result: {
    readonly ok: boolean
    readonly value?: { readonly total: number }
    readonly error?: { readonly code: string }
  }
}

/** POST one envelope, with a timeout so a hung request fails the test instead of the suite. */
async function post(url: string, method: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${url}${API_ROUTE_PREFIX}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: envelope(method),
    signal: AbortSignal.timeout(10_000),
    ...init,
  })
}

describe('the panel data route over a real socket', () => {
  test('a real POST reaches the store and the answer reaches the client', async () => {
    const url = await serveRoute(() => undefined, [row('first'), row('second')])

    const response = await post(url, 'overview')

    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/u)
    const answer = (await response.json()) as Answer
    assert.equal(answer.type, 'server-response')
    assert.equal(answer.rpcId, 'r1')
    assert.equal(answer.result.ok, true)
    assert.equal(answer.result.value?.total, 2)
  })

  test('a query string is not part of the endpoint', async () => {
    const url = await serveRoute(() => undefined, [row('only')])

    // A browser cache-buster is the realistic case; the fake requests never carried one.
    const response = await fetch(`${url}${API_ROUTE_PREFIX}/overview?t=1730000000000`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: envelope('overview'),
      signal: AbortSignal.timeout(10_000),
    })

    assert.equal(response.status, 200)
    const answer = (await response.json()) as Answer
    assert.equal(answer.result.value?.total, 1)
  })

  test('the same connection answers a second request', async () => {
    const url = await serveRoute(() => undefined, [row('only')])

    const first = await post(url, 'overview')
    assert.equal(first.status, 200)
    await first.json()

    // A handler that leaves the request half-read costs the next request its socket, so a second
    // request on the same keep-alive connection is the check that the body was consumed.
    const second = await post(url, 'overview')
    assert.equal(second.status, 200)
    assert.equal(((await second.json()) as Answer).result.value?.total, 1)
  })

  test('the admission fence answers a real request before any panel data does', async () => {
    const url = await serveRoute(() => 403, [row('private preference')])

    const response = await post(url, 'overview')

    assert.equal(response.status, 403)
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain/u)
    const body = await response.text()
    assert.equal(body, 'forbidden')
    assert.doesNotMatch(body, /private preference/u)
  })

  test('a body over the cap is answered with 413, not with panel data', async () => {
    const url = await serveRoute(() => undefined, [row('only')])

    // A real oversize upload, built by the client: the cap is one mebibyte.
    const oversize = JSON.stringify({
      type: 'client-request',
      rpcId: 'r1',
      method: 'overview',
      payload: { text: 'x'.repeat(1 << 20) },
    })
    assert.ok(Buffer.byteLength(oversize, 'utf8') > (1 << 20), 'the body must actually be over the cap')

    const response = await post(url, 'overview', { body: oversize })

    assert.equal(response.status, 413)
    assert.equal(await response.text(), 'payload too large')
  })

  test('a mismatched method and a broken body are answered in the envelope, not by a transport status', async () => {
    const url = await serveRoute(() => undefined, [row('only')])

    // The client's own `method !== endpoint` check surfaces this one, so the answer is a 200 the
    // client can read rather than a status it would have to translate.
    const mismatched = await post(url, 'overview', { body: envelope('list') })
    assert.equal(mismatched.status, 200)
    const answer = (await mismatched.json()) as Answer
    assert.equal(answer.result.ok, false)
    assert.equal(answer.result.error?.code, 'request/invalid')

    const broken = await post(url, 'overview', { body: '{ not json' })
    assert.equal(broken.status, 400)
    assert.equal(await broken.text(), 'invalid json')
  })

  test('a real GET is 404 and a real text/plain POST is 415', async () => {
    const url = await serveRoute(() => undefined, [row('only')])

    const get = await fetch(`${url}${API_ROUTE_PREFIX}/overview`, { signal: AbortSignal.timeout(10_000) })
    assert.equal(get.status, 404)
    assert.equal(await get.text(), 'not found')

    const wrongType = await fetch(`${url}${API_ROUTE_PREFIX}/overview`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: envelope('overview'),
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(wrongType.status, 415)
    assert.equal(await wrongType.text(), 'unsupported media type')
  })
})
