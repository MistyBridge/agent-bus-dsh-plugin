/**
 * The model-facing tool surface: nine tools over the ledger and the delivery
 * path, named after the A2A operation set where one exists.
 *
 * The surface stays deliberately small. The reference implementation this
 * draws on grew to 73 tools and had to fold them behind a router to keep the
 * prompt-cache prefix stable; the lesson taken here is not to build a router
 * but to never need one. Orchestration concerns — dependency graphs, goals,
 * file locks, shared knowledge — are a different capability and stay out.
 *
 * There is no receive-side tool. `followup()` turns a delivered task into an
 * ordinary turn on the recipient, so a worker reads its task as user input
 * with no claim step to perform.
 *
 * @module dsh-agent-bus/tools
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { authorizePeer, authorizeSettlement, resolveWorkspacePath } from './authorize.ts'
import { admitContent, buildMessageMessage, buildTaskMessage, deliverTask, type DeliverySource } from './delivery.ts'
import type { ReportStore } from './external.ts'
import { blockedByOf, type TaskLedger } from './ledger.ts'
import { isTokenBuckets, staffRoles } from './panel.ts'
import { DispatchRateLimiter } from './rate-limit.ts'
import { dispatchOne } from './scheduler.ts'
import { TaskId, type DeliveryMode, type TaskRecord, type TokenBuckets } from './types.ts'

/** Resolved plugin configuration the tools read. */
export interface ToolsConfig {
  readonly maxContentLength: number
  readonly maxPendingPerAgent: number
  readonly maxSendsPerMinute: number
  /** Reports longer than this are externalized to the report store (default `400`). */
  readonly maxInlineReport: number
  /** Lightweight messages one sender may send per minute (default `20`). */
  readonly maxMessagesPerMinute: number
}

/** Services the tool bodies need beyond `ctx`. */
export interface ToolsDeps {
  readonly ledger: TaskLedger
  readonly workspaces: WorkspaceRegistry
  readonly limiter: DispatchRateLimiter
  /** Separate sliding window for send_note, so chatter cannot exhaust task quota. */
  readonly messageLimiter: DispatchRateLimiter
  readonly reports: ReportStore
}

/** Model-facing projection of one ledger row for listings. */
interface TaskView {
  readonly id: string
  readonly status: string
  readonly from: string
  readonly to?: string
  readonly content: string
  readonly report?: string
  readonly outcome?: string
  readonly reason?: string
  readonly dependencies?: string[]
  readonly retries: number
}

function view(task: TaskRecord): TaskView {
  // Undefined optional fields are omitted: the harness rejects tool output
  // that is not lossless JSON, and JSON.stringify drops undefined keys.
  return {
    id: task.id,
    status: task.status,
    from: task.assignedBy,
    ...(task.assignedTo !== undefined ? { to: task.assignedTo } : {}),
    content: task.content,
    ...(task.report !== undefined ? { report: task.report } : {}),
    ...(task.outcome !== undefined ? { outcome: task.outcome } : {}),
    ...(task.reason !== undefined ? { reason: task.reason } : {}),
    ...(task.dependencies !== undefined ? { dependencies: task.dependencies.map(String) } : {}),
    retries: task.retries,
  }
}

/**
 * Render one task row for the model.
 *
 * A completed task's report is the evidence a dispatcher settles on, so it is
 * printed rather than summarized; the verdict appears once recorded. The
 * truncation caps are listing hygiene only — get_task reads the full record.
 *
 * @param t - the projected row.
 * @returns the text lines for one row.
 */
export function renderTaskRow(t: TaskView): string {
  const head = `${t.id} [${t.status}] ${t.content.slice(0, 80)}`
  const report = t.report !== undefined
    ? `\n  submitted result: ${t.report.slice(0, 400)}`
    : ''
  const verdict = t.outcome !== undefined ? `\n  verdict: ${t.outcome}` : ''
  const reason = t.reason !== undefined ? `\n  reason: ${t.reason}` : ''
  const deps = t.dependencies !== undefined && t.dependencies.length > 0
    ? `\n  depends on: ${t.dependencies.join(', ')}`
    : ''
  return head + report + verdict + reason + deps
}

/** Model-facing projection of one full task record. */
interface TaskDetailView {
  readonly id: string
  readonly status: string
  readonly from: string
  readonly to?: string
  readonly content: string
  readonly report?: string
  readonly question?: string
  readonly outcome?: string
  readonly feedback?: string
  readonly reason?: string
  readonly reviewer?: string
  readonly retries: number
  readonly createdAt: string
  readonly updatedAt: string
}

function detailView(task: TaskRecord): TaskDetailView {
  return {
    id: task.id,
    status: task.status,
    from: task.assignedBy,
    ...(task.assignedTo !== undefined ? { to: task.assignedTo } : {}),
    content: task.content,
    ...(task.report !== undefined ? { report: task.report } : {}),
    ...(task.question !== undefined ? { question: task.question } : {}),
    ...(task.outcome !== undefined ? { outcome: task.outcome } : {}),
    ...(task.feedback !== undefined ? { feedback: task.feedback } : {}),
    ...(task.reason !== undefined ? { reason: task.reason } : {}),
    ...(task.assignedReviewer !== undefined ? { reviewer: task.assignedReviewer } : {}),
    retries: task.retries,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/**
 * Decide whether one session may read a task.
 *
 * The workspace is the trust boundary, matching the harness's own
 * cross-session authorization (tool-session-query's cwd predicate):
 * participants always pass, and any other session sharing the task's
 * workspace does too. Task ids can reach non-participants through relayed
 * messages and future visibility surfaces, so the read gate stays even where
 * ids are undiscoverable today.
 *
 * @param task - the row being read.
 * @param callerId - the session requesting the read.
 * @param callerWorkspace - the caller's resolved workspace path, if any.
 * @returns `true` when the read is authorized.
 */
export function canReadTask(
  task: TaskRecord,
  callerId: SessionId,
  callerWorkspace: string | undefined,
): boolean {
  return task.assignedBy === callerId
    || task.assignedTo === callerId
    || (callerWorkspace !== undefined && callerWorkspace === task.workspacePath)
}

/**
 * Render one full task record.
 *
 * get_task exists so a listing's truncation caps never cost information: the
 * content and report are printed complete here.
 *
 * @param t - the projected full record.
 * @returns the text of the record.
 */
export function renderTaskDetail(t: TaskDetailView): string {
  const lines = [
    `${t.id} [${t.status}]`,
    `from: ${t.from}`,
    ...(t.to !== undefined ? [`to: ${t.to}`] : []),
    `retries: ${t.retries}`,
    `created: ${t.createdAt}`,
    `updated: ${t.updatedAt}`,
    'task:',
    t.content,
  ]
  if (t.question !== undefined) lines.push('question:', t.question)
  if (t.report !== undefined) lines.push('submitted result:', t.report)
  if (t.outcome !== undefined) lines.push(`verdict: ${t.outcome}`)
  if (t.feedback !== undefined) lines.push(`feedback: ${t.feedback}`)
  if (t.reason !== undefined) lines.push(`reason: ${t.reason}`)
  if (t.reviewer !== undefined) lines.push(`reviewer: ${t.reviewer}`)
  return lines.join('\n')
}

/** Require a calling agent, since every operation is session-scoped. */
function requireCaller(agent: { id: SessionId } | undefined, tool: string): SessionId {
  if (agent === undefined) {
    throw new Error(`${tool} requires a calling agent (exec.agent was undefined)`)
  }
  return agent.id
}

/**
 * Wake one session with a task notice.
 *
 * This is the loop-closing step of the lifecycle: report notifies the
 * reviewer, a failed settle wakes the worker for rework, a successful settle
 * returns the result to the initiator. Notices are one-directional by
 * construction — every step they invite is another tool call, never another
 * notice — so the loops cannot cycle. An offline session is skipped silently;
 * the ledger remains the durable record either way.
 *
 * @param ctx - context carrying the live Agent registry.
 * @param sessionId - the session to wake.
 * @param taskId - the task the notice concerns.
 * @param text - the notice body.
 */
/**
 * Snapshot the dispatch-time token totals of a task's participants.
 *
 * The panel computes task-period consumption as `current projection − this
 * snapshot`, so the snapshot is taken once, at dispatch, and never refreshed.
 * A participant that is offline, or a profile without the projection
 * registry, simply leaves its key out of the record — the panel then shows
 * that staff row's delta as unavailable.
 *
 * @param ctx - plugin context; services are read via `ctx.get` and may be absent.
 * @param initiator - the dispatching session.
 * @param executor - the target session.
 * @param reviewer - the named reviewer, or `undefined` for the initiator default.
 * @returns the token snapshot keyed by participant session id, or `undefined`
 *   when no participant's usage could be read.
 */
function snapshotTokensAtDispatch(
  ctx: Context,
  initiator: SessionId,
  executor: SessionId,
  reviewer: SessionId | undefined,
): Record<string, TokenBuckets> | undefined {
  const projections = ctx.get('sessionProjections') as
    | { snapshot(session: Session): { values: Record<string, unknown> } }
    | undefined
  const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
  if (projections === undefined || agents === undefined) return undefined
  const out: Record<string, TokenBuckets> = {}
  for (const { sessionId } of staffRoles(initiator, executor, reviewer)) {
    const agent = agents.get(sessionId)
    if (agent === undefined) continue
    const value = projections.snapshot(agent.session).values.tokenUsage
    if (isTokenBuckets(value)) out[sessionId] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

export function notifySession(
  ctx: Context,
  sessionId: SessionId,
  taskId: TaskId,
  text: string,
  tool: DeliverySource = 'dispatch_task',
): void {
  const session = ctx.agents.get(sessionId)
  if (session === undefined) return
  const notice = buildTaskMessage(sessionId, taskId, text, tool)
  deliverTask(session, notice, 'followup')
}

/**
 * Register the nine agent-bus tools.
 *
 * @param ctx - context carrying the tool registry and live Agent registry.
 * @param config - resolved tunables.
 * @param deps - the opened ledger and the workspace registry.
 */
export function registerAgentBusTools(ctx: Context, config: ToolsConfig, deps: ToolsDeps): void {
  const { ledger, workspaces, limiter } = deps

  ctx.tools.register(defineTool({
    name: 'list_peers',
    description:
      'List the other live agent sessions in your workspace, which are the only valid targets for '
      + 'dispatch_task. Reachability is workspace membership: a session counts as a peer when its '
      + 'working directory is the same registered workspace as yours. Archived sessions never appear. '
      + 'Status comes from the live registry — working means it is busy right now, idle means it is '
      + 'loaded and between turns. A peer that wrote a card shows its self-description and '
      + 'machine-readable capabilities. This snapshot is not a delivery promise; dispatch_task '
      + 'performs the authoritative check and may still refuse.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string' },
            status: { type: 'string', required: true, enum: ['running', 'idle'] },
            pendingTasks: { type: 'number', required: true },
            description: { type: 'string' },
            capabilities: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  label: { type: 'string', required: true },
                },
              },
            },
          },
        },
      },
      render: (_args, peers) => [{
        type: 'text',
        text: peers.length === 0
          ? '(no reachable peers in this workspace)'
          : peers.map(p => {
            const name = p.title !== undefined && p.title !== '' ? p.title : p.id
            const caps = Array.isArray(p.capabilities) && p.capabilities.length > 0
              ? ` caps=${p.capabilities.map(c => c.id).join(',')}`
              : ''
            const desc = p.description !== undefined && p.description !== ''
              ? ` — ${p.description.slice(0, 60)}`
              : ''
            return `${name} [${p.status}] pending=${String(p.pendingTasks)}${caps}${desc} (${p.id})`
          }).join('\n'),
      }],
    },
    presentCall: () => ({ card: 'generic', title: 'agent-bus:发现 peer', kind: 'other' }),
    presentResult: (_args, peers) => ({ card: 'generic', title: 'agent-bus:发现 peer', rawInput: peers }),
    async execute(_args, exec) {
      const callerId = requireCaller(exec.agent, 'list_peers')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('list_peers: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) return []
      const archived = new Set<string>(workspaces.archivedSessionIds as readonly string[])
      const peers: {
        id: SessionId; title?: string; status: 'running' | 'idle'; pendingTasks: number;
        description?: string; capabilities?: { id: string; label: string }[];
      }[] = []
      for (const agent of ctx.agents.list()) {
        if (agent.id === callerId) continue
        if (archived.has(agent.id)) continue
        // Subagents answer to their parent through the harness lineage, not
        // to workspace peers.
        if (agent.session.header.origin === 'subagent') continue
        if (await resolveWorkspacePath(workspaces, agent) !== workspacePath) continue
        const pending = ledger.listFor(agent.id).filter(
          row => row.status === 'submitted' || row.status === 'working' || row.status === 'input-required',
        )
        const title = ctx.sessionTitle.get(agent.session)?.title
        const card = ledger.getCard(agent.id)
        peers.push({
          id: agent.id,
          ...(title !== undefined && title !== '' ? { title } : {}),
          status: agent.status === 'running' ? 'running' : 'idle',
          pendingTasks: pending.length,
          ...(card !== undefined ? { description: card.description } : {}),
          ...(card !== undefined && card.capabilities.length > 0
            ? { capabilities: card.capabilities.map(c => ({ id: c.id, label: c.label })) }
            : {}),
        })
      }
      return peers
    },
  }))

  ctx.tools.register(defineTool({
    // Named send_note, NOT send_message: the harness bundle reserves
    // send_message globally for subagent conversation (dsh-tool-subagent-
    // control), so the peer channel must not collide with it.
    name: 'send_note',
    description:
      'Send a lightweight note to a live peer in your workspace: a message, a question, a '
      + 'confirmation, a coordination ping — anything that is NOT work the peer must deliver a '
      + 'verifiable result for. The note lands in the peer\'s inbox like an ordinary message; '
      + 'there is NO task record, no acceptance, and nothing to report or settle. The peer simply '
      + 'replies in prose (with send_note back to you, if it replies at all). Use dispatch_task '
      + 'instead when the peer must produce a result you will verify — a note channel needs no '
      + 'lifecycle, and a task channel whose work was really a chat is how tasks get stuck forever '
      + 'in working.',
    parameters: {
      target: { type: 'string', required: true, description: 'Session id of the peer, from list_peers.' },
      content: { type: 'string', required: true, description: 'The note text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: result.delivered
          ? `note delivered (${String(result.messageId).slice(0, 8)}…)`
          : 'note not delivered',
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:发送消息', kind: 'other', rawInput: { target: args.target } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:发送消息', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'send_note')
      if (!deps.messageLimiter.admit(callerId, Date.now())) {
        throw new Error(
          `message rate exceeded: at most ${config.maxMessagesPerMinute} messages per minute`,
        )
      }
      const targetId = args.target as SessionId
      const decision = await authorizePeer(ctx, workspaces, callerId, targetId)
      if (!decision.ok) throw new Error(decision.message)
      const admitted = admitContent(args.content, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      // No ledger write: a note has no row, so the claimed-listener cannot
      // match it and no lifecycle ever starts. The message id is generated
      // here and returned so the sender keeps a delivery receipt.
      const message = buildMessageMessage(callerId, randomUUID(), admitted.content)
      deliverTask(decision.target, message, 'followup')
      return { delivered: true, messageId: message.id }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'dispatch_task',
    description:
      'Dispatch one task to a live peer in your workspace. The task is recorded in the ledger and '
      + 'delivered to the peer\'s queue in one step, so a recorded task is always one that was actually '
      + 'sent. The peer works queued tasks one at a time, each as its own turn, and only picks up the '
      + 'next one after finishing the current one — you do not need to pace them. Use mode=followup '
      + '(default) to add work to the end of that queue; use mode=steer only when the news invalidates '
      + 'what the peer is doing right now, since it interrupts the current step. You become the task\'s '
      + 'initiator. By default you also review its result; pass reviewer to name a different session as '
      + 'the one that settles it. A rejected result sends the SAME task back to the worker for rework — '
      + 'the task id never changes across attempts. To answer a peer\'s request_input, pass task_id — '
      + 'your message becomes the answer and the task resumes.',
    parameters: {
      target: { type: 'string', required: true, description: 'Session id of the peer, from list_peers.' },
      content: { type: 'string', required: true, description: 'The task instruction or answer.' },
      mode: {
        type: 'string',
        enum: ['followup', 'steer'],
        description: 'followup (default) queues the task; steer interrupts the peer\'s current step.',
      },
      reviewer: {
        type: 'string',
        description: 'Session id of the reviewer who settles this task; defaults to you.',
      },
      task_id: {
        type: 'string',
        description: 'Answering a request_input: the input-required task id. The message answers its question.',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'DAG predecessors: task ids that must settle before this one is dispatched. '
          + 'When any predecessor is unsettled the task is only created — the scheduler dispatches '
          + 'it automatically once every dependency settles. Edit it with edit_task before it dispatches.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          queuePosition: { type: 'number', required: true },
          blockedBy: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} → ${String(result.status)}, `
          + `${String(result.queuePosition)} unfinished task(s) in that queue`
          + (result.blockedBy.length > 0
            ? `, awaiting dependencies: ${result.blockedBy.join(', ')}`
            : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:派发任务', kind: 'other', rawInput: { target: args.target, ...(args.reviewer !== undefined ? { reviewer: args.reviewer } : {}), ...(args.task_id !== undefined ? { task_id: args.task_id } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:派发任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'dispatch_task')
      if (!limiter.admit(callerId, Date.now())) {
        throw new Error(
          `dispatch rate exceeded: at most ${config.maxSendsPerMinute} sends per minute`,
        )
      }
      const targetId = args.target as SessionId
      const decision = await authorizePeer(ctx, workspaces, callerId, targetId)
      if (!decision.ok) throw new Error(decision.message)

      const admitted = admitContent(args.content, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)

      const mode: DeliveryMode = args.mode === 'steer' ? 'steer' : 'followup'

      // Answer path: the dispatcher replies to a worker's request_input. The
      // answer is a new delivery; the task resumes working when it is claimed.
      if (args.task_id !== undefined) {
        const taskId = TaskId(args.task_id)
        const task = ledger.get(taskId)
        if (task === undefined) throw new Error(`no such task "${taskId}"`)
        if (task.status !== 'input-required') {
          throw new Error(`task "${taskId}" is ${task.status}, not awaiting input`)
        }
        if (task.assignedBy !== callerId) {
          throw new Error(`only the dispatching session may answer task "${taskId}"`)
        }
        const message = buildTaskMessage(callerId, taskId, admitted.content)
        await ledger.recordDelivery(taskId, message.id)
        deliverTask(decision.target, message, mode)
        const pending = ledger.listFor(targetId).filter(
          row => row.status === 'submitted' || row.status === 'working' || row.status === 'input-required',
        )
        return { taskId: String(taskId), status: 'input-required', queuePosition: pending.length, blockedBy: [] as string[] }
      }

      // Dispatch path: a fresh task. Reviewer defaults to the initiator.
      const taskId = TaskId(randomTaskId())
      let reviewer: SessionId | undefined
      if (args.reviewer !== undefined) {
        const reviewerDecision = await authorizePeer(ctx, workspaces, callerId, args.reviewer as SessionId)
        if (!reviewerDecision.ok) throw new Error(reviewerDecision.message)
        reviewer = args.reviewer as SessionId
      }
      const dependencies = (args.depends_on as string[] | undefined)?.map(id => TaskId(id))
      const message = buildTaskMessage(callerId, taskId, admitted.content)
      const tokensAtStart = snapshotTokensAtDispatch(ctx, callerId, targetId, reviewer)
      const recorded = await ledger.record({
        id: taskId,
        assignedBy: callerId,
        assignedTo: targetId,
        ...(reviewer !== undefined ? { assignedReviewer: reviewer } : {}),
        workspacePath: decision.workspacePath,
        content: admitted.content,
        mode,
        retries: 0,
        ...(tokensAtStart !== undefined ? { tokensAtStart } : {}),
        ...(dependencies !== undefined ? { dependencies } : {}),
      }, config.maxPendingPerAgent)
      if (!recorded.ok) throw new Error(recorded.message)

      // A task with dependencies is created without delivery until every
      // predecessor settles; the scheduler dispatches it then. A task whose
      // dependencies are already settled delivers immediately, recording the
      // message id before the inbox can claim it.
      const blocked: string[] = dependencies === undefined
        ? []
        : [...blockedByOf(recorded.task, ledger.listAll()).map(String)]
      if (blocked.length === 0) {
        await ledger.recordDelivery(taskId, message.id)
        deliverTask(decision.target, message, mode)
      }
      const pending = ledger.listFor(targetId).filter(
        row => row.status === 'submitted' || row.status === 'working' || row.status === 'input-required',
      )
      return { taskId: String(taskId), status: recorded.task.status, queuePosition: pending.length, blockedBy: blocked }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'edit_task',
    description:
      'Edit a task you created that has not been dispatched yet: rewrite its requirement text and/or its '
      + 'DAG predecessors (depends_on). The DAG is program-driven — if you find your flow unreasonable, '
      + 'fix it here before the task dispatches. A dispatched or running task cannot be edited; cancel and '
      + 'recreate instead. After the edit, the task dispatches automatically if every dependency has settled.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The undispatched task to edit.' },
      content: { type: 'string', description: 'New requirement text; omit to keep the current one.' },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'New predecessor list; omit to keep the current one, pass [] to clear all dependencies.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          blockedBy: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} updated → ${String(result.status)}`
          + (result.blockedBy.length > 0
            ? `, awaiting dependencies: ${result.blockedBy.join(', ')}`
            : ', dependencies satisfied'),
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'agent-bus:编辑任务',
      kind: 'other',
      rawInput: { task_id: args.task_id, ...(args.depends_on !== undefined ? { depends_on: args.depends_on } : {}) },
    }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:编辑任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'edit_task')
      const taskId = TaskId(args.task_id)
      const existing = ledger.get(taskId)
      if (existing === undefined) throw new Error(`no such task "${taskId}"`)
      if (existing.assignedBy !== callerId) {
        throw new Error(`only the session that created task "${taskId}" may edit it`)
      }
      const patch: { content?: string; dependencies?: TaskId[] } = {}
      if (args.content !== undefined) {
        const admitted = admitContent(args.content, config.maxContentLength)
        if (!admitted.ok) throw new Error(admitted.message)
        patch.content = admitted.content
      }
      if (args.depends_on !== undefined) {
        patch.dependencies = (args.depends_on as string[]).map(id => TaskId(id))
      }
      const edited = await ledger.editTask(taskId, patch)
      if (!edited.ok) throw new Error(edited.message)

      // Recompute readiness: a dependency edit may have cleared the last
      // blocker, in which case the task dispatches immediately.
      const blocked: string[] = [...blockedByOf(edited.task, ledger.listAll()).map(String)]
      if (blocked.length === 0) {
        await dispatchOne(ctx, ledger, taskId)
      }
      return { taskId: String(taskId), status: edited.task.status, blockedBy: blocked }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_tasks',
    description:
      'List tasks in the ledger. Scope inbox (default) shows tasks addressed to you, in the order you '
      + 'will work them; scope outbox shows tasks you dispatched and their current state. A completed '
      + 'task includes its report text, so read it before settling. Pass status to filter to one task '
      + 'state. Use get_task when a listing truncates a long report.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['inbox', 'outbox'],
        description: 'inbox (default) lists tasks assigned to you; outbox lists tasks you dispatched.',
      },
      status: {
        type: 'string',
        enum: [
          'submitted', 'working', 'input-required', 'auth-required',
          'completed', 'failed', 'canceled', 'rejected',
        ],
        description: 'Optional: list only tasks in this state.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            status: { type: 'string', required: true },
            from: { type: 'string', required: true },
            to: { type: 'string' },
            content: { type: 'string', required: true },
            report: { type: 'string' },
            outcome: { type: 'string' },
            reason: { type: 'string' },
            retries: { type: 'number', required: true },
          },
        },
      },
      render: (_args, tasks) => [{
        type: 'text',
        text: tasks.length === 0
          ? '(no tasks)'
          : tasks.map(renderTaskRow).join('\n'),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:任务列表', kind: 'other', rawInput: { scope: args.scope, ...(args.status !== undefined ? { status: args.status } : {}) } }),
    presentResult: (_args, tasks) => ({ card: 'generic', title: 'agent-bus:任务列表', rawInput: tasks }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'list_tasks')
      const scope = args.scope === 'outbox' ? 'outbox' : 'inbox'
      let rows: TaskRecord[]
      switch (scope) {
        case 'inbox':
          rows = ledger.listFor(callerId)
          break
        case 'outbox':
          rows = ledger.listBy(callerId)
          break
        /* v8 ignore next 2 -- the schema-validated closed enum is normalized before dispatch. */
        default:
          return assertNever(scope, 'list_tasks scope')
      }
      if (args.status !== undefined) {
        rows = rows.filter(row => row.status === args.status)
      }
      return rows.map(view)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_task',
    description:
      'Read one task\'s full record: the complete task content and submitted result, without the '
      + 'truncation list_tasks applies. The dispatching session, the assigned session, and any other '
      + 'session in the same workspace may read a task. Use it to review a long report before settling.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string' },
          content: { type: 'string', required: true },
          report: { type: 'string' },
          question: { type: 'string' },
          outcome: { type: 'string' },
          feedback: { type: 'string' },
          reason: { type: 'string' },
          reviewer: { type: 'string' },
          retries: { type: 'number', required: true },
          createdAt: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
        },
      },
      render: (_args, detail) => [{ type: 'text', text: renderTaskDetail(detail) }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:读取任务', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, detail) => ({ card: 'generic', title: 'agent-bus:读取任务', rawInput: detail }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'get_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('get_task: the calling session is not a live agent')
      const callerWorkspace = await resolveWorkspacePath(workspaces, caller)
      if (!canReadTask(task, callerId, callerWorkspace)) {
        throw new Error(`session "${callerId}" is outside task "${taskId}"'s workspace`)
      }
      // Externalized reports are read back so the reviewer sees the full
      // result; a missing file degrades to the inline summary.
      let fullReport: string | undefined
      if (task.reportRef !== undefined) {
        fullReport = await deps.reports.read(task.reportRef)
      }
      return fullReport !== undefined
        ? { ...detailView(task), report: fullReport }
        : detailView(task)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'report_task',
    description:
      'As the worker, submit the result of a task assigned to you: a working task becomes completed '
      + 'and waits for the dispatcher\'s verdict; you cannot settle it yourself. If the task was '
      + 'canceled, calling this attaches a summary of the work you had done — the status stays '
      + 'canceled. You may not report tasks that are still submitted (not yet claimed) or that are '
      + 'awaiting input.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id.' },
      result: { type: 'string', required: true, description: 'Your result (or the cancel summary).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} is now ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:提交结果', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:提交结果', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'report_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedTo !== callerId) {
        throw new Error(`task "${taskId}" is not assigned to you`)
      }
      const admitted = admitContent(args.result, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      if (task.status === 'canceled') {
        const attached = await ledger.attachReport(taskId, admitted.content)
        if (!attached.ok) throw new Error(attached.message)
        return { taskId, status: attached.task.status }
      }
      // Long reports are externalized: the ledger row carries a bounded
      // summary plus the reference, and get_task reads the full text back.
      let report = admitted.content
      let reportRef: string | undefined
      if (report.length > config.maxInlineReport) {
        reportRef = await deps.reports.save(taskId, admitted.content)
        report = `${admitted.content.slice(0, config.maxInlineReport)}…`
      }
      const completed = await ledger.transition(taskId, 'completed', {
        report,
        ...(reportRef !== undefined ? { reportRef } : {}),
      })
      if (!completed.ok) throw new Error(completed.message)
      // The reviewer is woken to settle; default reviewer is the initiator.
      const reviewer = task.assignedReviewer ?? task.assignedBy
      const excerpt = admitted.content.length > 200
        ? `${admitted.content.slice(0, 200)}…`
        : admitted.content
      notifySession(ctx, reviewer, taskId,
        `任务 ${taskId} 已完成,请调用 settle_task 验收。提交结果摘要:${excerpt}`,
        'report_task')
      return { taskId, status: completed.task.status }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'settle_task',
    description:
      'As the reviewer, settle a completed task: outcome=success accepts it and the task is done; '
      + 'outcome=failure sends the SAME task back to the worker for rework, with your feedback as the '
      + 'rework instruction — the task id never changes across attempts. The worker is notified to '
      + 'rework automatically, and the initiator is notified of the final result. Only the task\'s '
      + 'reviewer (the reviewer named at dispatch, or the initiator by default) may settle it.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The completed ledger task id.' },
      outcome: {
        type: 'string',
        required: true,
        enum: ['success', 'failure'],
        description: 'success accepts; failure sends the task back for rework.',
      },
      feedback: { type: 'string', description: 'On failure: the rework instruction. On success: optional note.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} verdict: ${result.outcome} (status: ${result.status})`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:验收', kind: 'other', rawInput: { task_id: args.task_id, outcome: args.outcome } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:验收', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'settle_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      const denial = authorizeSettlement(task, callerId)
      if (denial !== undefined) throw new Error(denial.message)
      const outcome = args.outcome === 'failure' ? 'failure' : 'success'
      const settled = await ledger.settle(taskId, outcome, args.feedback)
      if (!settled.ok) throw new Error(settled.message)
      // A settled task is terminal: its report moves hot -> cold.
      await deps.reports.archive(taskId)
      // DAG release: a success verdict frees every dependent whose blockers
      // cleared. The scheduler listener dispatches them.
      if (outcome === 'success') {
        ctx.emit('agent-bus/settle', taskId)
        // Result returns to the initiator: the loop closes.
        notifySession(ctx, task.assignedBy, taskId,
          `任务 ${taskId} 已验收通过(success)。最终结果:${settled.task.report ?? '(无)'}`,
          'settle_task')
      } else if (task.assignedTo !== undefined) {
        // Rework loop: the worker is woken to execute the SAME task again.
        // The rework notice is a new delivery of the task, so its message id
        // must be recorded on the row first — otherwise the claimed listener
        // cannot find the task and it never leaves `submitted`.
        const instruction = args.feedback !== undefined ? args.feedback : '请根据验收意见重新执行。'
        const reworkNotice = buildTaskMessage(callerId, taskId,
          `任务 ${taskId} 未通过验收(failure)。修改意见:${instruction}。请重新执行后调用 report_task 再次提交。`,
          'settle_task')
        const recorded = await ledger.recordDelivery(taskId, reworkNotice.id)
        if (!recorded.ok) throw new Error(recorded.message)
        const worker = ctx.agents.get(task.assignedTo)
        if (worker !== undefined) deliverTask(worker, reworkNotice, 'followup')
      }
      return { taskId, status: settled.task.status, outcome }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cancel_task',
    description:
      'As the dispatcher, cancel a task you dispatched while it is still submitted, working, or '
      + 'awaiting your input. The worker is interrupted, told the task is canceled, and asked to '
      + 'report a summary of what it had done; the summary lands on the task (read it with get_task). '
      + 'Only the session that dispatched a task may cancel it; workers cannot cancel their own '
      + 'dispatched tasks.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The ledger task id to cancel.' },
      reason: { type: 'string', description: 'Why the task is canceled, shown to the worker.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} is now ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:取消任务', kind: 'other', rawInput: { task_id: args.task_id, ...(args.reason !== undefined ? { reason: args.reason } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:取消任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'cancel_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      const denial = authorizeSettlement(task, callerId)
      if (denial !== undefined) throw new Error(denial.message)
      const reason = args.reason !== undefined ? admitContent(args.reason, 400) : undefined
      if (reason !== undefined && !reason.ok) throw new Error(reason.message)
      const canceled = await ledger.transition(taskId, 'canceled', {
        ...(reason?.ok === true ? { reason: reason.content } : {}),
      })
      if (!canceled.ok) throw new Error(canceled.message)
      // A canceled task is terminal: its report moves hot -> cold.
      await deps.reports.archive(taskId)

      // Interrupt the worker's in-flight turn, then ask for the summary. Both
      // are best-effort: an absent worker keeps the canceled row and the
      // summary request is skipped.
      const worker = task.assignedTo !== undefined ? ctx.agents.get(task.assignedTo) : undefined
      if (worker !== undefined) {
        try {
          worker.cancel({ kind: 'user' }, { keepInbox: true })
        } catch {
          // The cancel signal is advisory; a worker that already settled the
          // turn needs no interruption.
        }
        const note = `任务 ${taskId} 已被派发方取消${reason?.ok === true ? `(${reason.content})` : ''}。`
          + '请用 report_task 提交你已完成部分的摘要。'
        const summary = buildTaskMessage(callerId, taskId, note, 'cancel_task')
        deliverTask(worker, summary, 'followup')
      }
      return { taskId, status: canceled.task.status }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'request_input',
    description:
      'As the worker, pause a task you are working on because you need information only the '
      + 'dispatcher has. The task enters input-required with your question; the dispatcher answers '
      + 'with dispatch_task passing task_id, and the task resumes when the answer arrives. Keep the '
      + 'question specific so one round-trip suffices.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The working ledger task id.' },
      question: { type: 'string', required: true, description: 'What you need from the dispatcher.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} is now ${result.status}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:请求输入', kind: 'other', rawInput: { task_id: args.task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:请求输入', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'request_input')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedTo !== callerId) {
        throw new Error(`task "${taskId}" is not assigned to you`)
      }
      const admitted = admitContent(args.question, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const paused = await ledger.transition(taskId, 'input-required', { question: admitted.content })
      if (!paused.ok) throw new Error(paused.message)
      return { taskId, status: paused.task.status }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_card',
    description:
      'Maintain your own capability card, which list_peers shows to the workspace. description is '
      + 'what you say about yourself, for other agents to read; capabilities are machine-readable '
      + 'labels — ids are lowercase kebab-case keys, at most 8, each with a short label. The update '
      + 'replaces the whole card. Keep the description honest and the capabilities narrow: peers '
      + 'route work by what you claim here.',
    parameters: {
      description: { type: 'string', description: 'One or two sentences about what you do well.' },
      capabilities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Lowercase kebab-case machine key.' },
            label: { type: 'string', required: true, description: 'Short human-readable label.' },
          },
        },
        description: 'Your machine-readable capability list, at most 8 entries.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true },
          capabilities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, card) => [{
        type: 'text',
        text: card.description === ''
          ? '(card cleared)'
          : `${card.description}\n${(card.capabilities ?? []).map(c => `${c.id}: ${c.label}`).join('\n')}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:更新卡片', kind: 'other', rawInput: { description: args.description, capabilities: args.capabilities } }),
    presentResult: (_args, card) => ({ card: 'generic', title: 'agent-bus:更新卡片', rawInput: card }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'update_card')
      const description = (args.description ?? '').trim()
      if (description.length > 200) {
        throw new Error(`description is ${description.length} characters, over the 200 limit`)
      }
      const capabilities = (args.capabilities ?? []).map(item => ({
        id: String(item.id).trim(),
        label: String(item.label).trim(),
      }))
      const seen = new Set<string>()
      for (const cap of capabilities) {
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(cap.id)) {
          throw new Error(`capability id "${cap.id}" must be lowercase kebab-case`)
        }
        if (cap.label.length === 0 || cap.label.length > 50) {
          throw new Error(`capability label for "${cap.id}" must be 1-50 characters`)
        }
        if (seen.has(cap.id)) {
          throw new Error(`duplicate capability id "${cap.id}"`)
        }
        seen.add(cap.id)
      }
      const card = { description, capabilities, updatedAt: new Date().toISOString() }
      await ledger.putCard(callerId, card)
      // The durable record carries updatedAt; the tool result is the
      // model-facing projection, which must match the declared output schema.
      return { description, capabilities }
    },
  }))
}

/** Generate a fresh task id. */
function randomTaskId(): string {
  return randomUUID()
}
