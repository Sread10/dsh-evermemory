/**
 * Typed access to the `tools` service.
 *
 * Same shape as `inject/prompt.ts`: the service is reached through `ctx.get('tools')`, typed
 * `unknown`, and the check is a runtime one. A cast would compile and then fail at the first tool
 * call with a message about the host build instead of about this plugin. When the check fails the
 * plugin simply mounts no tools — memory and rules keep working.
 */

import type { ToolsService } from '@deepseek-ai/dsh-tools'

/** The smallest thing that must be true for `register` to work. */
function isToolsService(value: unknown): value is ToolsService {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as Record<string, unknown>).register === 'function'
}

/** Read the service from a context, or `undefined` when this host does not provide it. */
export function toolsOf(ctx: unknown): ToolsService | undefined {
  const getter = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  if (typeof getter !== 'function') return undefined
  const service = (ctx as { get: (name: string) => unknown }).get('tools')
  return isToolsService(service) ? service : undefined
}
