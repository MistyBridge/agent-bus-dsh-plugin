/**
 * DAG auto-dispatch: the code that turns a settled dependency into a
 * delivered task.
 *
 * The scheduler is deliberately dumb — it reads ledger state and delivers
 * exactly the tasks that are ready, through the same message path a tool
 * call uses. Idempotency comes from the state itself: a task whose row has a
 * messageId is already delivered, so a restart sweep or a second release
 * trigger can never double-dispatch.
 *
 * @module dsh-agent-bus/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { buildTaskMessage, deliverTask } from './delivery.ts'
import { blockedByOf, type TaskLedger } from './ledger.ts'
import type { TaskId } from './types.ts'

/** Deliver one notice to a live session (the scheduler's only notification). */
function notifySession(ctx: Context, sessionId: SessionId, taskId: TaskId, text: string): void {
  const session = ctx.agents.get(sessionId)
  if (session === undefined) return
  const notice = buildTaskMessage(sessionId, taskId, text, 'scheduler')
  deliverTask(session, notice, 'followup')
}

/**
 * Deliver one queued task: transition it to submitted, record the delivery
 * with the auto flag, and hand it to the harness inbox. Idempotent by
 * construction — a task that is not queued (already delivered, running, or
 * terminal) is skipped, so the client's event-driven POST /dispatch and the
 * server backstop sweep can race without double-delivery.
 *
 * Exported so the edit_task tool can dispatch a task whose dependencies just
 * cleared.
 *
 * @param ctx - plugin context (notifications).
 * @param ledger - the task ledger.
 * @param id - the ready task's id.
 */
export async function dispatchOne(ctx: Context, ledger: TaskLedger, id: TaskId): Promise<void> {
  const task = ledger.get(id)
  if (task === undefined || task.assignedTo === undefined) return
  if (task.status !== 'queued') return // idempotent: nothing to deliver
  const worker = ctx.agents.get(task.assignedTo)
  if (worker === undefined) return // offline worker: the row stays queued and the sweep retries
  // Handoff documents from settled predecessors ride along: structured
  // context (values, decisions, caveats) concatenated after the instruction,
  // so the worker reads the chain's state instead of excavating old reports.
  const handoffs = ledger.handoffsFor(task.id)
  const body = handoffs.length > 0
    ? `${task.content}\n\n【前置任务交接文档】\n${handoffs.map(handoff =>
      `来自 ${String(handoff.fromTask)}:\n${handoff.document}`).join('\n\n')}`
    : task.content
  const message = buildTaskMessage(task.assignedBy, task.id, body, 'scheduler')
  const advanced = await ledger.transition(id, 'submitted')
  if (!advanced.ok) return // raced: another dispatcher already moved it
  await ledger.recordDelivery(task.id, message.id, true)
  deliverTask(worker, message, task.mode)
  notifySession(
    ctx,
    task.assignedBy,
    task.id,
    `任务 ${task.id} 的前置依赖已全部结算,已自动派发,状态「待执行」,等待执行方认领。`,
  )
}

/**
 * Release the dependents of one just-settled task. Every dependent that is
 * submitted, undelivered, and no longer blocked is dispatched.
 *
 * @param ctx - plugin context.
 * @param ledger - the task ledger.
 * @param taskId - the task that just settled.
 * @returns how many tasks were dispatched.
 */
export async function releaseDependents(
  ctx: Context,
  ledger: TaskLedger,
  taskId: TaskId,
): Promise<number> {
  const ready = await ledger.pendingReleases(taskId)
  for (const id of ready) {
    await dispatchOne(ctx, ledger, id)
  }
  return ready.length
}

/**
 * Sweep every ready-but-undelivered task. Used at startup (restore
 * auto-scheduling after a restart) and as a periodic backstop; idempotent by
 * construction.
 *
 * @param ctx - plugin context.
 * @param ledger - the task ledger.
 * @returns how many tasks were dispatched.
 */
export async function dispatchReadyTasks(ctx: Context, ledger: TaskLedger): Promise<number> {
  const all = ledger.listAll()
  const ready = all.filter(task =>
    task.status === 'queued'
    && blockedByOf(task, all).length === 0)
  for (const task of ready) {
    await dispatchOne(ctx, ledger, task.id)
  }
  return ready.length
}
