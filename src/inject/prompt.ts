/**
 * Typed access to the `systemPrompt` service.
 *
 * The service is reached through `ctx.get('systemPrompt')`, which is typed `unknown`: the host
 * supplies the real object at runtime, and this plugin's shallow declaration of
 * `@deepseek-ai/dsh-system-prompt` covers only what it touches. A cast would silence the
 * compiler without telling anyone which build of the host is actually mounted, so the shape is
 * checked instead. When the check fails the plugin degrades — no injection — rather than
 * throwing inside prompt assembly, where the failure would take out every agent in the session.
 */

import type { SystemPromptService } from '@deepseek-ai/dsh-system-prompt'

/** The smallest thing that must be true for the two registration calls to work. */
function isSystemPromptService(value: unknown): value is SystemPromptService {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.section === 'function' && typeof candidate.context === 'function'
}

/** Read the service from a context, or `undefined` when this host does not provide it. */
export function systemPromptOf(ctx: unknown): SystemPromptService | undefined {
  const getter = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  if (typeof getter !== 'function') return undefined
  const service = (ctx as { get: (name: string) => unknown }).get('systemPrompt')
  return isSystemPromptService(service) ? service : undefined
}
