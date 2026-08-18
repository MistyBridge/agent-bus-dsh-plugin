/**
 * Agent Bus for DeepSeek Harness.
 *
 * A host-plane plugin that gives live sessions in the same workspace a way to
 * dispatch work to each other, with a durable ledger recording what was asked
 * and how it turned out. The ledger's lifecycle follows the A2A TaskState
 * vocabulary; the settlement verdict is recorded without changing the state.
 *
 * Two planes, deliberately separate. Delivery is the harness's own: a task
 * becomes one `followup()` on the recipient's inbox, and the driver claims one
 * queued item at a time, running each as its own turn with a durability
 * checkpoint between them. The ledger is this plugin's: it records intent and
 * outcome, and never mirrors the inbox — the inbox is the execution authority
 * and the two drift by design.
 *
 * Authority is derived from durable relationships, never from a stored role.
 * Reachability comes from shared workspace membership; settlement and cancel
 * authority belong to the session recorded as a task's dispatcher. So "PM" is
 * emergent: dispatch work to someone and you are that task's dispatcher, with
 * no role to assign and no way to approve your own work.
 *
 * Installation: `dsh plugin --profile <name> add <this package>`.
 *
 * @module dsh-agent-bus
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.storageDomain and ctx.systemPrompt visible.
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import { ReportStore } from './external.ts'
import { TaskLedger } from './ledger.ts'
import { DispatchRateLimiter } from './rate-limit.ts'
import { notifySession, registerAgentBusTools, type ToolsConfig } from './tools.ts'

export const name = 'agent-bus'

/**
 * Required services and provided values. `storageDomain` is a value the
 * storage-domain plugin provides (not a Service), so it is injected by name
 * exactly as the workspace package injects it. A profile that mounts neither
 * storage nor the workspace registry fails loud at load rather than booting a
 * gateway that could record nothing — misconfiguration must not degrade into
 * a silent prompt-only stub. `sessionTitle` ships with the base bundle, so it
 * resolves in every profile.
 */
export const inject = ['tools', 'agents', 'systemPrompt', 'sessionTitle', 'storageDomain', 'workspaceRegistry']

/** Plugin configuration. */
export interface Config {
  /** Character ceiling on relayed content; over-length content is refused, not truncated (default `16000`). */
  maxContentLength?: number
  /** Unfinished tasks one recipient may hold before dispatch is refused (default `20`). */
  maxPendingPerAgent?: number
  /** Dispatches one sender may issue per minute (default `10`). */
  maxSendsPerMinute?: number
  /** How long a working or input-required task may sit before failing (default `7200000`, 2 hours). */
  taskTimeoutMs?: number
  /** Reports longer than this are externalized to the report store (default `400`). */
  maxInlineReport?: number
  /** Prompt-section order for the usage policy (default `118`). */
  promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  maxContentLength: z.natural().min(1).default(16000),
  maxPendingPerAgent: z.natural().min(1).default(20),
  maxSendsPerMinute: z.natural().min(1).default(10),
  taskTimeoutMs: z.natural().min(60_000).default(7_200_000),
  maxInlineReport: z.natural().min(1).default(400),
  promptSectionOrder: z.natural().default(118),
})

/** The model-facing usage policy. */
const USAGE_TEXT = `You share a workspace with other agent sessions and can dispatch work to them.

- list_peers shows the live sessions in your workspace: their names, their self-declared cards, and how busy they are. They are the only valid dispatch_task targets.
- dispatch_task dispatches one task to one peer. The peer works its queued tasks one at a time, each as its own turn, and only starts the next one after finishing the current one — you do not need to pace dispatches. Passing task_id answers a peer's request_input and lets its paused task resume. Passing reviewer names a different session as the one that settles the result; without it you settle it yourself.
- list_tasks with scope=inbox shows work assigned to you, in the order you will do it. With scope=outbox it shows what you initiated: completed tasks carry the worker's report, waiting for the reviewer's verdict. Pass status to filter.
- get_task reads one task's full record, including the complete report and question text.
- report_task is the worker's way to finish: a working task becomes completed and the reviewer is notified to settle it. If the task was canceled, report_task attaches your work summary instead.
- settle_task is the reviewer's verdict: success accepts and the task is done; failure sends the SAME task back to the worker for rework with your feedback as the instruction — the task id never changes across attempts, and the worker is notified automatically. The initiator is notified of the final result.
- When you receive a notice that a task you review is completed, settle it promptly; leaving it unsettled stalls the worker.
- When you receive a notice that a task you initiated timed out, decide whether to redo it with a new dispatch_task; a timeout means the worker never finished or never answered.
- cancel_task is the initiator's way to stop a task that is still submitted, working, or awaiting input. The worker is interrupted and asked for a summary, which lands on the canceled task.
- request_input pauses a task you are working on when you need information only the initiator has; they answer with dispatch_task passing task_id.
- update_card maintains your own capability card: a description for other agents and machine-readable capabilities for routing.

When you receive a task, it arrives as an ordinary message with a <dsh-agent-bus> header naming the sender and task id. Do the work, then call report_task with that task id. When a notice tells you a task you review is completed, settle it promptly; when a notice tells you your task failed review, rework it and report again. Only the reviewer can settle and only the initiator can cancel, so never mark your own work complete.

Delivery reaches live sessions only. A refusal from dispatch_task is authoritative: the peer is not reachable, not in your workspace, or its queue is full.

Tools: list_peers, dispatch_task, list_tasks, get_task, report_task, settle_task, cancel_task, request_input, update_card`

/**
 * Mount the gateway.
 *
 * Opens the ledger first; a failed open is loud and the tools stay
 * unregistered rather than accepting dispatches the ledger cannot record.
 *
 * @param ctx - the plugin context.
 * @param config - validated configuration.
 * @returns resolution after the ledger is open and the tools are registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved: ToolsConfig = {
    maxContentLength: config.maxContentLength ?? 16000,
    maxPendingPerAgent: config.maxPendingPerAgent ?? 20,
    maxSendsPerMinute: config.maxSendsPerMinute ?? 10,
    maxInlineReport: config.maxInlineReport ?? 400,
  }

  ctx.systemPrompt.section({
    name: 'agent-bus:usage',
    order: config.promptSectionOrder ?? 118,
    text: USAGE_TEXT,
  })

  const ledger = await TaskLedger.open(ctx)
  const limiter = new DispatchRateLimiter(resolved.maxSendsPerMinute, 60_000)
  const reports = new ReportStore(
    dshHomePath('agent-bus', 'cache'),
    dshHomePath('agent-bus', 'archive'),
  )
  registerAgentBusTools(ctx, resolved, {
    ledger,
    workspaces: ctx.workspaceRegistry,
    limiter,
    reports,
  })

  // Ledger state follows the real inbox lifecycle. The events are scope-filtered
  // per agent; a listener on the host context admits them from every agent.
  ctx.on('agent/inbox/claimed', ({ message, turn }) => {
    const task = ledger.findByMessage(message.id)
    if (task === undefined) return
    // A claimed task starts working; a claimed answer resumes a paused task.
    if (task.status === 'submitted' || task.status === 'input-required') {
      void ledger.transition(task.id, 'working', { turn })
    }
  })
  ctx.on('agent/inbox/discarded', ({ message }) => {
    const task = ledger.findByMessage(message.id)
    if (task === undefined) return
    if (task.status === 'submitted' || task.status === 'working') {
      void ledger.transition(task.id, 'failed', { reason: 'discarded' })
    }
  })

  // Timeout sweep: a working row whose claimed step was rejected neither
  // reports nor discards, so only time can close it. An unanswered
  // input-required row is the same shape on the dispatcher's side. A timed
  // out task is terminal: its report moves hot -> cold and the INITIATOR is
  // notified — a timeout means a side of the loop went quiet, and the
  // initiator is the one who can decide to redo it.
  const timeoutMs = config.taskTimeoutMs ?? 7_200_000
  const timer = setInterval(() => {
    const cutoff = Date.now() - timeoutMs
    for (const row of ledger.listAll()) {
      if (row.status !== 'working' && row.status !== 'input-required') continue
      if (Date.parse(row.updatedAt) > cutoff) continue
      const reason = row.status === 'working' ? 'timeout' : 'no-response'
      void ledger.transition(row.id, 'failed', { reason }).then(() => {
        void reports.archive(row.id)
        notifySession(ctx, row.assignedBy, row.id,
          `任务 ${row.id} 已超时失败(failed, reason: ${reason})。执行方未在时限内完成或回答。如需重做,请派发新任务。`)
      })
    }
  }, Math.min(timeoutMs / 2, 600_000))
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'agent-bus.timeoutSweep')

  // Report-store sweep: hot files idle past 7 days and cold files idle past
  // 30 days are removed. Runs hourly; unref'd so it never holds the process.
  const cacheSweep = setInterval(() => {
    void reports.sweep()
  }, 3_600_000)
  cacheSweep.unref?.()
  ctx.effect(() => () => clearInterval(cacheSweep), 'agent-bus.cacheSweep')
}
