/**
 * The panel's client for the Host data route.
 *
 * One wrapper per method, so the page never writes a channel name, a URL or an envelope by hand.
 * The interesting decision is that a transport failure is folded into the same `{ok: false}`
 * shape the Host uses for a refusal. The page then has exactly one error path — read `ok`, render
 * `error.message` — instead of two, and the wrapped case that a user actually hits (the desktop
 * app restarting under an open panel) reads as an ordinary failure with an honest message rather
 * than as an unhandled rejection.
 *
 * The connection service itself is created with a channel per call, so nothing here holds a socket
 * or keeps a retry queue: a call made after the host came back simply works.
 */

import { API_ROUTE_PREFIX } from '../constants.js'
import type {
  PanelDailyResult,
  PanelExportRequest,
  PanelExportResult,
  PanelForgetResult,
  PanelGetResult,
  PanelImportRequest,
  PanelImportResult,
  PanelListRequest,
  PanelListResult,
  PanelLogResult,
  PanelOverview,
  PanelProjectRef,
  PanelRememberRequest,
  PanelRememberResult,
  PanelSearchRequest,
  PanelSearchResult,
  PanelUpdateRequest,
  PanelUpdateResult,
} from '../panel/protocol.js'
import type { ConnectionService, RemoteResult } from './services.js'

/** Failure code used when the call never reached the Host. */
export const TRANSPORT_FAILURE = 'transport'

/** The data route, as the page uses it. */
export interface PanelClient {
  /** Store status, counts, projects and the tag vocabulary. */
  overview(): Promise<RemoteResult<PanelOverview>>
  /** One filtered page of memories. */
  list(request: PanelListRequest): Promise<RemoteResult<PanelListResult>>
  /** One memory, text intact. */
  get(id: number): Promise<RemoteResult<PanelGetResult>>
  /** Ranked search. */
  search(request: PanelSearchRequest): Promise<RemoteResult<PanelSearchResult>>
  /** Store a new memory through the same gate the conversational tools use. */
  remember(request: PanelRememberRequest): Promise<RemoteResult<PanelRememberResult>>
  /** Archive one memory. */
  forget(id: number, project?: PanelProjectRef): Promise<RemoteResult<PanelForgetResult>>
  /** Edit one memory. */
  update(id: number, patch: PanelUpdateRequest['patch'], project?: PanelProjectRef): Promise<RemoteResult<PanelUpdateResult>>
  /** One day's log. */
  daily(project?: PanelProjectRef, date?: string): Promise<RemoteResult<PanelDailyResult>>
  /** Append to one day's log. */
  log(entries: readonly string[], project?: PanelProjectRef, date?: string): Promise<RemoteResult<PanelLogResult>>
  /** The Markdown export. */
  exportDocument(request: PanelExportRequest): Promise<RemoteResult<PanelExportResult>>
  /** Run the step-7 import engine against a path. */
  importPath(request: PanelImportRequest): Promise<RemoteResult<PanelImportResult>>
}

/**
 * Build the client.
 *
 * @param connection - the browser connection service.
 * @returns the wrapper the page calls.
 */
export function panelClient(connection: ConnectionService): PanelClient {
  const call = <T>(method: string, payload?: unknown): Promise<RemoteResult<T>> =>
    guard(connection.rpc.call<T>(API_ROUTE_PREFIX, method, payload ?? {}))

  return {
    overview: () => call<PanelOverview>('overview'),
    list: (request) => call<PanelListResult>('list', request),
    get: (id) => call<PanelGetResult>('get', { id }),
    search: (request) => call<PanelSearchResult>('search', request),
    remember: (request) => call<PanelRememberResult>('remember', request),
    forget: (id, project) => call<PanelForgetResult>('forget', project === undefined ? { id } : { id, project }),
    update: (id, patch, project) =>
      call<PanelUpdateResult>('update', project === undefined ? { id, patch } : { id, patch, project }),
    daily: (project, date) =>
      call<PanelDailyResult>('daily', { ...(project === undefined ? {} : { project }), ...(date === undefined ? {} : { date }) }),
    log: (entries, project, date) =>
      call<PanelLogResult>('log', {
        entries,
        ...(project === undefined ? {} : { project }),
        ...(date === undefined ? {} : { date }),
      }),
    exportDocument: (request) => call<PanelExportResult>('export', request),
    importPath: (request) => call<PanelImportResult>('import', request),
  }
}

/**
 * Turn a rejected call into a failure result.
 *
 * `connection.rpc.call` rejects only when the carrier itself failed — a wrong envelope, a dropped
 * connection, a Host that answered a status instead of a result. Those are the cases the page
 * cannot do anything about, and they must still arrive as a value so the page's single error branch
 * sees them.
 *
 * @param pending - the in-flight call.
 * @returns the Host's answer, or a transport failure.
 */
async function guard<T>(pending: Promise<RemoteResult<T>>): Promise<RemoteResult<T>> {
  try {
    return await pending
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: {
        code: TRANSPORT_FAILURE,
        message: `无法连接到宿主：${detail}`,
        details: { detail },
      },
    }
  }
}
