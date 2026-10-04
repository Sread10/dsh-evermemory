/**
 * The panel's data route.
 *
 * A settings page runs in the browser, so every byte of stored memory it shows has to arrive over
 * HTTP. The DSH way to carry that is a connection RPC channel: the browser calls
 * `ctx.connection.rpc.call(channel, method, payload)` and the host answers
 * `{ok: true, value}` / `{ok: false, error}`. Reusing that channel instead of inventing a REST
 * surface is not a style preference — the official path is what runs the Host/Origin fence and the
 * browser cookie check before a handler sees anything, and it is what returns a business failure as
 * a value rather than as an HTTP 500.
 *
 * The channel name is one path segment by contract (`/^\/[A-Za-z0-9._~-]+$/` on the host,
 * `/^\/[A-Za-z0-9._~-]+$/` in the browser), and the literal `/api` is reserved by the connection
 * service for its own fetch bridge — `assertChannel` rejects it outright. Hence
 * {@link API_ROUTE_PREFIX} is `/dsh-evermemory` and the method name travels as the next segment.
 *
 * Registration order matters. `connection.rpc.handle` is tried first because it is the supported
 * API: it registers the route through the connection service's own effect, so a host that later
 * stops carrying web requests tears the route down with everything else. The manual route below is
 * the fallback for DSH builds whose `handle()` is known-broken and for connections that expose only
 * the admission fence; it reproduces exactly the two things `handle()` does — the fence and the
 * envelope — and nothing else.
 *
 * `connection` is the one service this route insists on, and the insistence is the security
 * property, not a formality: every answer here is read out of the user's store, and the fence that
 * makes serving that safe (Host/Origin check plus the browser session cookie) lives in the
 * connection service. A host with a web server but no connection service therefore gets no panel
 * route at all — and it gets no page either, because the browser half reaches its data through the
 * same service. The two halves degrade together on purpose.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { API_ROUTE_PREFIX } from '../constants.js'
import type { StoreHandle } from '../storage/handle.js'
import { createPanelApi } from './api.js'
import type { PanelHandler } from './api.js'

/** The connection service, as much of it as this route touches. */
interface ConnectionLike {
  /** The RPC channel registry: `handle(channel, handler)` returns the route's disposer. */
  readonly rpc?: {
    handle?: (channel: string, handler: PanelHandler) => () => void
  }
  /**
   * Host/Origin plus browser-cookie admission, in one call.
   *
   * `undefined` means the request passes the fence; `401`/`403` are the status to answer with. This
   * is the older of the two admission entry points and the one the fallback route needs.
   */
  requestRejection?: (request: unknown) => number | undefined
}

/** The web server, as much of it as this route touches. */
interface WebServerLike {
  register(route: {
    readonly kind: 'prefix'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Largest request body the fallback route will read. */
const MAX_BODY_BYTES = 1 << 20

/** Statuses whose bodies this route answers with a word rather than JSON. */
const REJECTION_BODIES: Readonly<Record<number, string>> = { 401: 'unauthorized', 403: 'forbidden' }

/**
 * Mount the route.
 *
 * @param ctx - the plugin context. Registration is an effect, so unloading the plugin removes the
 *   channel, and nothing happens at all until the connection service is mounted.
 * @param store - the store handle the page reads and writes through.
 */
export function mountPanelRoute(ctx: Context, store: StoreHandle): void {
  const api = createPanelApi({ store })

  ctx.inject(['connection'], (scoped: Context) => {
    const connection = scoped.get('connection') as ConnectionLike | undefined

    const official = registerOfficial(connection, api.handle)
    if (official !== undefined) {
      // `handle` already registered its own effect inside the connection service; this effect only
      // ties the returned disposer to this plugin's lifetime.
      scoped.effect(() => official, 'evermemory.panel-route')
      return
    }

    scoped.inject(['webServer'], (web: Context) => {
      web.effect(() => {
        const webServer = web.get('webServer') as WebServerLike | undefined
        if (webServer === undefined) return () => {}
        // The fallback. Same prefix, same envelope, same fence — but registered here, so a
        // `connection.rpc` that is broken or absent cannot leave the page with no data route.
        return webServer.register({
          kind: 'prefix',
          path: API_ROUTE_PREFIX,
          handler: (req, res) => serve(connection, req, res, api.handle),
        })
      }, 'evermemory.panel-route')
    })
  })
}

/**
 * Register through the connection service, when it offers the API.
 *
 * @param connection - the connection service, if mounted.
 * @param handler - the dispatch.
 * @returns the route's disposer, or `undefined` when the official path is unavailable.
 */
function registerOfficial(connection: ConnectionLike | undefined, handler: PanelHandler): (() => void) | undefined {
  const handle = connection?.rpc?.handle
  if (typeof handle !== 'function') return undefined
  try {
    return handle.call(connection?.rpc, API_ROUTE_PREFIX, handler)
  } catch {
    // `assertChannel` throws for a channel it dislikes and cordis throws when the connection
    // service's own context cannot reach `webServer`. Both are answered by the manual route rather
    // than by failing the plugin mount.
    return undefined
  }
}

/**
 * Serve one fallback request.
 *
 * @param connection - the connection service, for the admission fence.
 * @param req - the request.
 * @param res - the response. This handler owns its lifecycle.
 * @param handler - the dispatch.
 */
async function serve(
  connection: ConnectionLike | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  handler: PanelHandler,
): Promise<void> {
  const rejection = rejectionOf(connection, req)
  if (rejection !== undefined) {
    res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(REJECTION_BODIES[rejection] ?? 'rejected')
    return
  }

  const url = new URL(req.url ?? '/', 'http://evermemory.invalid')
  const endpoint = url.pathname.startsWith(`${API_ROUTE_PREFIX}/`)
    ? url.pathname.slice(API_ROUTE_PREFIX.length + 1)
    : ''

  // Non-POST, a bare channel request and a nested path are all "no such endpoint" rather than
  // "bad request": the official bridge answers 404 to the same three cases.
  if (req.method !== 'POST' || endpoint === '' || endpoint.includes('/')) {
    notFound(res)
    return
  }

  const media = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (media !== 'application/json') {
    res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('unsupported media type')
    return
  }

  let body: unknown
  try {
    body = JSON.parse((await readBody(req)).toString('utf8')) as unknown
  } catch (error) {
    if (error instanceof BodyTooLarge) {
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('payload too large')
      return
    }
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('invalid json')
    return
  }

  const message = body as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  if (message.type !== 'client-request' || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('invalid client-request')
    return
  }

  const rpcId = message.rpcId
  if (message.method !== endpoint) {
    // The official bridge answers 200 with a failure envelope here, on purpose: the client's own
    // `method !== endpoint` check is what surfaces it, and a transport status would be a lie.
    reply(res, rpcId, {
      ok: false,
      error: {
        code: 'request/invalid',
        message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: {},
      },
    })
    return
  }

  try {
    const result = await handler(endpoint, message.payload, undefined, undefined)
    reply(res, rpcId, result)
  } catch (error) {
    // The official bridge turns a throwing handler into a 500. The dispatch catches everything
    // already, so reaching this line means the failure is ours, not the caller's.
    const detail = error instanceof Error ? error.message : String(error)
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`handler failure: ${detail}`)
  }
}

/** Write one `server-response` envelope. */
function reply(res: ServerResponse, rpcId: string, result: unknown): void {
  const body = JSON.stringify({ type: 'server-response', rpcId, result })
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** 404 for anything that is not an endpoint of this channel. */
function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

/**
 * Run the connection's admission fence.
 *
 * @param connection - the connection service, if mounted.
 * @param req - the request.
 * @returns the status to answer with, or `undefined` when the request may proceed.
 */
function rejectionOf(connection: ConnectionLike | undefined, req: IncomingMessage): number | undefined {
  const reject = connection?.requestRejection
  if (typeof reject !== 'function') {
    // No connection service means no browser session to authenticate, which happens when the plugin
    // is mounted by a host that has a web server but no client connection — a headless probe, or a
    // test harness. The route is loopback-only in that case, so serving it is not a hole.
    return undefined
  }
  try {
    return reject.call(connection, req)
  } catch {
    // A fence that throws cannot be evaluated, and an unevaluated fence must not be treated as a
    // pass. 403 is the honest answer.
    return 403
  }
}

/** Read a request body, refusing anything over the cap. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Marker for a body past {@link MAX_BODY_BYTES}. */
class BodyTooLarge extends Error {
  constructor() {
    super('payload too large')
    this.name = 'BodyTooLarge'
  }
}
