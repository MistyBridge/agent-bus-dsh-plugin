/**
 * Browser plugin for dsh-agent-bus.
 *
 * Registers the collapsed `agent-bus-task` tool rows: every agent-bus tool
 * call in the conversation is rendered as one always-collapsed producer line
 * instead of the generic "Tool call" card. The registration targets the
 * keyed `tool.call.toolview` slot, one entry per tool name; an unclaimed key
 * would fall back to the generic row, so registering is purely additive.
 *
 * @module dsh-agent-bus/client
 */

import { createRoot } from 'react-dom/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { AgentBusToolRow } from './AgentBusToolRow.tsx'
import { TaskPanel } from './TaskPanel.tsx'

/** Required services: slot registry plus the session list used for current-session highlight. */
export const inject = ['slots', 'sessions']

/** Every model-facing tool this plugin renders in collapsed form. */
const AGENT_BUS_TOOLS = [
  'list_peers',
  'dispatch_task',
  'list_tasks',
  'get_task',
  'report_task',
  'settle_task',
  'cancel_task',
  'request_input',
  'update_card',
]

/**
 * Mount the toolview registrations.
 *
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  for (const tool of AGENT_BUS_TOOLS) {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: tool }, AgentBusToolRow))
  }

  const host = document.createElement('div')
  host.dataset.agentBusPanelHost = ''
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(<TaskPanel sessionsList={ctx.sessions.list} />)
  ctx.effect(() => () => { root.unmount(); host.remove() }, 'agent-bus: task panel')
}
