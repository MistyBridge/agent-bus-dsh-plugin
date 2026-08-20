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
import { authorizeNoteRecipient, authorizePeerOrDormant, authorizeSettlement, resolveWorkspacePath } from './authorize.ts'
import { admitContent, buildMessageMessage, buildTaskMessage, deliverTask, type DeliverySource } from './delivery.ts'
import type { ReportStore } from './external.ts'
import { blockedByOf, type TaskLedger } from './ledger.ts'
import { isTokenBuckets, staffRoles } from './panel.ts'
import { DispatchRateLimiter } from './rate-limit.ts'
import { dispatchOne } from './scheduler.ts'
import { wakeSession } from './wake.ts'
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
  readonly title?: string
  readonly report?: string
  readonly outcome?: string
  readonly reason?: string
  readonly dependencies?: string[]
  readonly acceptanceCriteria?: string
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
    ...(task.title !== undefined ? { title: task.title } : {}),
    ...(task.report !== undefined ? { report: task.report } : {}),
    ...(task.outcome !== undefined ? { outcome: task.outcome } : {}),
    ...(task.reason !== undefined ? { reason: task.reason } : {}),
    ...(task.dependencies !== undefined ? { dependencies: task.dependencies.map(String) } : {}),
    ...(task.acceptanceCriteria !== undefined ? { acceptanceCriteria: task.acceptanceCriteria } : {}),
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
/** Settled rows stay in the active listing for this long (mirror of the panel). */
const ARCHIVE_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Whether one row is visible to the agent tools — the active set only.
 *
 * Archived tasks are invisible to list_tasks by design, using the SAME
 * archive rule as the panel: a terminal failure/cancel/reject leaves the
 * listing immediately, and a settled success leaves once the settlement is
 * more than 24h old (the panel's archive-phase age). Everything the agent
 * can still act on — submitted, working, awaiting input, and a completed
 * row awaiting its verdict — stays visible. History lives in the panel and
 * session logs; get_task still reads an archived row by id for a reference
 * that reached the agent before archiving.
 *
 * @param row - the ledger row.
 * @param now - current epoch milliseconds.
 * @returns `true` when the row belongs to the active set.
 */
export function isActiveTask(row: TaskRecord, now: number): boolean {
  if (row.status === 'failed' || row.status === 'canceled' || row.status === 'rejected') {
    return false
  }
  if (row.status === 'completed') {
    // Awaiting the verdict: still active. Settled: active for the archive
    // grace period only.
    if (row.outcome === undefined) return true
    return now - Date.parse(row.updatedAt) < ARCHIVE_AGE_MS
  }
  // queued (待投递) counts as active: the scheduler is still driving it.
  return true
}

export function renderTaskRow(t: TaskView): string {
  // Status badges mirror the panel: 「待投递」 for a queued (undelivered) task
  // and 「待验收」 for a completed row awaiting its verdict.
  const badge = t.status === 'queued'
    ? 'queued 待投递'
    : t.status === 'completed' && t.outcome === undefined
      ? 'completed 待验收'
      : t.status
  const label = t.title !== undefined && t.title !== '' ? t.title : t.content.slice(0, 80)
  const head = `${t.id} [${badge}] ${label}`
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
  readonly title?: string
  readonly acceptanceCriteria?: string
  readonly handoffs?: { fromTask: string; document: string; at: string }[]
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
    ...(task.title !== undefined ? { title: task.title } : {}),
    ...(task.acceptanceCriteria !== undefined ? { acceptanceCriteria: task.acceptanceCriteria } : {}),
    ...(task.handoffs !== undefined
      ? { handoffs: task.handoffs.map(handoff => ({
        fromTask: String(handoff.fromTask),
        document: handoff.document,
        at: handoff.at,
      })) }
      : {}),
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
    ...(t.title !== undefined ? ['title:', t.title] : []),
  ]
  if (t.acceptanceCriteria !== undefined) lines.push('acceptance criteria:', t.acceptanceCriteria)
  if (t.handoffs !== undefined && t.handoffs.length > 0) {
    lines.push('handoff documents:')
    for (const handoff of t.handoffs) {
      lines.push(`  from ${handoff.fromTask}:`, handoff.document)
    }
  }
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

/**
 * Per-task notice aggregator: several notices for the SAME task within one
 * short window (settle receipt + scheduler dispatch land together) are
 * merged into a single long message instead of N queued followups. The
 * inbox then carries one turn per task instead of a pile-up, which was the
 * PM's "notification bombing" pain. The window is short (3s) so a notice is
 * never meaningfully delayed; a missing flush on shutdown only drops a
 * duplicate-ish notice, never ledger state.
 */
const NOTICE_MERGE_MS = 3_000

class NoticeMerger {
  private readonly pending = new Map<string, {
    timer: ReturnType<typeof setTimeout>
    texts: string[]
    sessionId: SessionId
    taskId: TaskId
    tool: DeliverySource
  }>()

  push(ctx: Context, sessionId: SessionId, taskId: TaskId, text: string, tool: DeliverySource): void {
    const key = String(taskId)
    const existing = this.pending.get(key)
    if (existing !== undefined) {
      existing.texts.push(text)
      return
    }
    const entry = { texts: [text], sessionId, taskId, tool }
    const timer = setTimeout(() => this.flush(ctx, key), NOTICE_MERGE_MS)
    timer.unref?.()
    this.pending.set(key, { ...entry, timer })
  }

  private flush(ctx: Context, key: string): void {
    const entry = this.pending.get(key)
    this.pending.delete(key)
    if (entry === undefined) return
    const session = ctx.agents.get(entry.sessionId)
    if (session === undefined) return
    const body = entry.texts.join('\n')
    const notice = buildTaskMessage(entry.sessionId, entry.taskId, body, entry.tool)
    deliverTask(session, notice, 'followup')
  }
}

const noticeMerger = new NoticeMerger()

export function notifySession(
  ctx: Context,
  sessionId: SessionId,
  taskId: TaskId,
  text: string,
  tool: DeliverySource = 'create_task',
): void {
  if (ctx.agents.get(sessionId) === undefined) return
  noticeMerger.push(ctx, sessionId, taskId, text, tool)
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
      + 'create_task. Reachability is workspace membership: a session counts as a peer when its '
      + 'working directory is the same registered workspace as yours. Archived sessions never appear. '
      + 'Status comes from the live registry — working means it is busy right now, idle means it is '
      + 'loaded and between turns. A peer that wrote a card shows its self-description and '
      + 'machine-readable capabilities. This snapshot is not a delivery promise; create_task '
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
      'SMALL scope: send a lightweight note to a live peer in your workspace — a message, a '
      + 'question, a confirmation, a coordination ping; anything that is NOT work the peer must '
      + 'deliver a verifiable result for. The note lands in the peer\'s inbox like an ordinary '
      + 'message; there is NO task record, no acceptance, and nothing to report or settle. The '
      + 'peer simply replies in prose (with send_note back to you, if it replies at all). Use '
      + 'create_task instead when the peer must produce a result you will verify — a note channel '
      + 'needs no lifecycle, and a task channel whose work was really a chat is how tasks get '
      + 'stuck forever in working.',
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
          queued: { type: 'boolean', required: true },
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: result.delivered
          ? `note delivered (${String(result.messageId).slice(0, 8)}…)`
          : result.queued === true
            ? `recipient offline — note queued, delivered when they are live (${String(result.messageId).slice(0, 8)}…)`
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
      // Notes are durable (v1.5): the recipient may be offline — the note is
      // queued and delivered when the recipient is live again. The looser
      // authorization still confines recipients to the caller's workspace.
      const decision = await authorizeNoteRecipient(ctx, workspaces, callerId, targetId)
      if (!decision.ok) throw new Error(decision.message)
      const admitted = admitContent(args.content, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const messageId = randomUUID()
      // Wake-on-delivery: a dormant recipient is resumed so the note lands
      // immediately; only a session that cannot be woken falls back to the
      // durable queue.
      const recipient = await wakeSession(ctx, targetId)
      if (recipient !== undefined) {
        const message = buildMessageMessage(callerId, messageId, admitted.content)
        deliverTask(recipient, message, 'followup')
        return { delivered: true, queued: false, messageId }
      }
      // Unwakeable offline recipient: hold durably, bounded per sender.
      const queued = ledger.listPendingNotes()
        .filter(note => note.sender === callerId)
      if (queued.length >= 50) {
        throw new Error('your offline note queue is full (50); wait for deliveries or drop old notes')
      }
      await ledger.queueNote({
        id: messageId,
        sender: callerId,
        recipient: targetId,
        content: admitted.content,
        sentAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        attempts: 0,
      })
      return { delivered: false, queued: true, messageId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'create_flow',
    description:
      'LARGE scope: create a flow — the roadmap container for a multi-step effort. FIRST write out '
      + 'the full plan (what must happen, in what order, by whom, what "done" means for each step), '
      + 'THEN create the flow, then split the plan into tasks created with flow_id and dependencies '
      + 'so the DAG auto-schedules: each task delivers only after its predecessors settle, and a '
      + 'failure propagates down the chain automatically. Every dependency of a task must live in '
      + 'the same flow (add the task to the flow first with edit_task flow_id), so one flow is '
      + 'always one DAG and cross-flow references are impossible. The DAG view renders per flow; a '
      + 'flow whose tasks are all archived moves to the archived section automatically.',
    parameters: {
      name: { type: 'string', required: true, description: 'Flow display name, 1–80 characters.' },
      description: { type: 'string', description: 'Optional note about the flow.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flowId: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `flow ${result.flowId} created: ${result.name}`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:创建流程', kind: 'other', rawInput: { name: args.name } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:创建流程', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'create_flow')
      const name = String(args.name ?? '').trim()
      if (name.length === 0 || name.length > 80) {
        throw new Error('flow name must be 1–80 characters')
      }
      const description = args.description !== undefined
        ? admitContent(String(args.description), 400)
        : undefined
      if (description !== undefined && !description.ok) throw new Error(description.message)
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('create_flow: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) {
        throw new Error('create_flow: the calling session is not inside a registered workspace')
      }
      const flowId = randomUUID()
      const flow = await ledger.createFlow(
        flowId, name, description?.ok === true ? description.content : undefined,
        callerId, workspacePath,
      )
      return { flowId: flow.id, name: flow.name }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reassign_task',
    description:
      'As the initiator, reassign an unsettled task without recreating it: move the executor '
      + '(new_executor) and/or the reviewer (new_reviewer). The task id, history, dependencies, '
      + 'flow membership, and acceptance criteria all stay — only who works and who reviews '
      + 'changes. A new executor receives the task re-delivered (a working old executor\'s report '
      + 'is rejected automatically); a queued task simply gets the new owner and still waits for '
      + 'its dependencies. Use this when a worker dropped out or responsibilities shift — cancel '
      + 'and recreate is the fallback only for settled tasks.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The unsettled task to reassign.' },
      new_executor: {
        type: 'string',
        description: 'Session id of the new executor, from list_peers; omit to keep the current one.',
      },
      new_reviewer: {
        type: 'string',
        description: 'Session id of the new reviewer; omit to keep the current one.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          executor: { type: 'string' },
          reviewer: { type: 'string' },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `task ${result.taskId} reassigned → ${String(result.status)}`
          + (result.executor !== undefined ? `, executor: ${result.executor.slice(0, 8)}` : '')
          + (result.reviewer !== undefined ? `, reviewer: ${result.reviewer.slice(0, 8)}` : ''),
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:转派任务', kind: 'other', rawInput: { task_id: args.task_id, ...(args.new_executor !== undefined ? { new_executor: args.new_executor } : {}), ...(args.new_reviewer !== undefined ? { new_reviewer: args.new_reviewer } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:转派任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'reassign_task')
      const taskId = TaskId(args.task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedBy !== callerId) {
        throw new Error(`only the session that created task "${taskId}" may reassign it`)
      }
      if (args.new_executor === undefined && args.new_reviewer === undefined) {
        throw new Error('reassign_task needs new_executor and/or new_reviewer')
      }
      let newExecutor: SessionId | undefined
      if (args.new_executor !== undefined) {
        const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, args.new_executor as SessionId)
        if (!decision.ok) throw new Error(decision.message)
        newExecutor = args.new_executor as SessionId
        // Self-execution keeps an independent reviewer, same rule as create_task.
        const effectiveReviewer = args.new_reviewer !== undefined
          ? args.new_reviewer as SessionId
          : task.assignedReviewer
        if (newExecutor === callerId
          && (effectiveReviewer === undefined || effectiveReviewer === callerId)) {
          throw new Error(
            'self-execution requires reviewer: when the executor is yourself, name a different session as reviewer',
          )
        }
      }
      let newReviewer: SessionId | undefined
      if (args.new_reviewer !== undefined) {
        const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, args.new_reviewer as SessionId)
        if (!decision.ok) throw new Error(decision.message)
        newReviewer = args.new_reviewer as SessionId
      }
      const oldExecutor = task.assignedTo
      const wasWorking = task.status === 'working' || task.status === 'input-required'
      const wasQueued = task.status === 'queued'
      // Work-state detection: with the one-task-per-turn delivery model, a
      // working task IS the task the executor is currently on. Reassigning
      // while it runs must interrupt that turn so the old worker cannot
      // keep grinding on work that was taken from it.
      const executorOnThisTask = task.status === 'working' && oldExecutor !== undefined
        && ctx.agents.get(oldExecutor) !== undefined
      const reassigned = await ledger.reassign(taskId, {
        ...(newExecutor !== undefined ? { executor: newExecutor } : {}),
        ...(newReviewer !== undefined ? { reviewer: newReviewer } : {}),
      })
      if (!reassigned.ok) throw new Error(reassigned.message)

      // Re-deliver to the new executor: the old delivery was voided by the
      // reassign. A queued task is not delivered — the scheduler owns it. A
      // dormant new executor is woken; an unwakeable one falls back to queued
      // and the sweep retries.
      if (newExecutor !== undefined && !wasQueued) {
        const message = buildTaskMessage(callerId, taskId,
          `${reassigned.task.content}\n\n[任务已由 ${oldExecutor ?? '原执行方'} 转派给你执行,请按原要求完成并调用 report_task。]`,
          'reassign_task')
        const worker = await wakeSession(ctx, newExecutor)
        if (worker !== undefined) {
          await ledger.recordDelivery(taskId, message.id)
          deliverTask(worker, message, 'followup')
        } else {
          await ledger.transition(taskId, 'queued')
        }
      }
      // The old executor's in-flight turn is interrupted and told the task
      // moved (if it was mid-flight) — the reclaimed work is voided so it
      // cannot keep executing a task that no longer belongs to it.
      if (oldExecutor !== undefined && newExecutor !== undefined && oldExecutor !== newExecutor && executorOnThisTask) {
        const oldWorker = ctx.agents.get(oldExecutor)
        if (oldWorker !== undefined) {
          try {
            oldWorker.cancel({ kind: 'user' }, { keepInbox: true })
          } catch {
            // The interrupt is advisory; a worker that already settled its
            // turn needs no interruption.
          }
        }
        notifySession(ctx, oldExecutor, taskId,
          `任务 ${taskId} 已转派给 ${newExecutor.slice(0, 8)},你不再负责该任务,当前工作已作废。`,
          'reassign_task')
      }
      return {
        taskId: String(taskId),
        status: reassigned.task.status,
        ...(reassigned.task.assignedTo !== undefined ? { executor: String(reassigned.task.assignedTo) } : {}),
        ...(reassigned.task.assignedReviewer !== undefined ? { reviewer: String(reassigned.task.assignedReviewer) } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'submit_handoff',
    description:
      'As the executor of a settled task, deliver the handoff document to ONE task that depends on '
      + 'it (a task listing this one in its dependencies). The document is attached to the '
      + 'downstream task and is concatenated into its delivered content when it dispatches — this '
      + 'is how a chain passes structured context (computed values, decisions, caveats) instead of '
      + 'free-text archaeology. Call it once per downstream task.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task you executed and completed (its id).' },
      to_task_id: { type: 'string', required: true, description: 'The downstream task that depends on task_id.' },
      document: { type: 'string', required: true, description: 'The handoff content the downstream task needs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          handoffCount: { type: 'number', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `handoff attached to ${result.taskId} (${String(result.handoffCount)} total)`,
      }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:提交交接文档', kind: 'other', rawInput: { task_id: args.task_id, to_task_id: args.to_task_id } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:提交交接文档', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'submit_handoff')
      const taskId = TaskId(args.task_id)
      const toTaskId = TaskId(args.to_task_id)
      const task = ledger.get(taskId)
      if (task === undefined) throw new Error(`no such task "${taskId}"`)
      if (task.assignedTo !== callerId) {
        throw new Error(`task "${taskId}" is not assigned to you`)
      }
      const downstream = ledger.get(toTaskId)
      if (downstream === undefined) throw new Error(`no such task "${toTaskId}"`)
      if (!(downstream.dependencies ?? []).includes(taskId)) {
        throw new Error(`task "${toTaskId}" does not depend on "${taskId}"; handoffs go to downstream tasks only`)
      }
      const admitted = admitContent(args.document, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const attached = await ledger.appendHandoff(toTaskId, {
        fromTask: taskId,
        document: admitted.content,
        at: new Date().toISOString(),
      })
      if (!attached.ok) throw new Error(attached.message)
      return {
        taskId: String(toTaskId),
        handoffCount: (attached.task.handoffs ?? []).length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_flows',
    description:
      'List the flows in your workspace: each flow\'s name, task counts, and whether it is archived '
      + '(every task in it has settled and left the active set). Use create_task with flow_id to add '
      + 'tasks to a flow, and edit_task with flow_id to move a task between flows.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            description: { type: 'string' },
            taskCount: { type: 'number', required: true },
            unsettledCount: { type: 'number', required: true },
            archived: { type: 'boolean', required: true },
          },
        },
      },
      render: (_args, flows) => [{
        type: 'text',
        text: flows.length === 0
          ? '(no flows)'
          : flows.map(f =>
            `${f.name} [${f.archived ? '已归档' : '活跃'}] tasks=${String(f.taskCount)} unsettled=${String(f.unsettledCount)}${f.description !== undefined ? ` — ${f.description.slice(0, 60)}` : ''} (${f.id.slice(0, 8)})`,
          ).join('\n'),
      }],
    },
    presentCall: () => ({ card: 'generic', title: 'agent-bus:流程列表', kind: 'other' }),
    presentResult: (_args, flows) => ({ card: 'generic', title: 'agent-bus:流程列表', rawInput: flows }),
    async execute(_args, exec) {
      const callerId = requireCaller(exec.agent, 'list_flows')
      const caller = ctx.agents.get(callerId)
      if (caller === undefined) throw new Error('list_flows: the calling session is not a live agent')
      const workspacePath = await resolveWorkspacePath(workspaces, caller)
      if (workspacePath === undefined) return []
      const all = ledger.listAll()
      const flows = ledger.listFlows()
        .filter(flow => flow.workspacePath === workspacePath)
        .map(flow => {
          const tasks = all.filter(row => row.flowId === flow.id)
          const unsettled = tasks.filter(row => isActiveTask(row, Date.now()))
          return {
            id: flow.id,
            name: flow.name,
            ...(flow.description !== undefined ? { description: flow.description } : {}),
            taskCount: tasks.length,
            unsettledCount: unsettled.length,
            archived: unsettled.length === 0,
          }
        })
      return flows
    },
  }))

  ctx.tools.register(defineTool({
    name: 'create_task',
    description:
      'MEDIUM scope: create one task node for a live peer in your workspace — a single deliverable '
      + 'the peer must produce and you will review. The task is recorded in the ledger; a task whose '
      + 'dependencies are already settled is delivered to the peer\'s queue in one step, and a task '
      + 'with unsettled dependencies is created as 待投递(queued) and delivered automatically by the '
      + 'scheduler once every dependency settles — no pacing needed. The peer works delivered tasks '
      + 'one at a time, each as its own turn. You become the task\'s initiator. By default you also '
      + 'review its result; pass reviewer to name a different session as the one that settles it. '
      + 'acceptance_criteria is the minimum requirement the reviewer settles against. A rejected '
      + 'result sends the SAME task back to the worker for rework — the task id never changes across '
      + 'attempts. To answer a peer\'s request_input, pass task_id — your message becomes the answer '
      + 'and the task resumes. Use mode=steer only when the news invalidates what the peer is doing '
      + 'right now. For a multi-step effort, use create_flow instead and build the DAG.',
    parameters: {
      target: { type: 'string', required: true, description: 'Session id of the peer, from list_peers.' },
      content: { type: 'string', required: true, description: 'The task instruction or answer.' },
      title: { type: 'string', required: true, description: 'Short display title (1–80 chars); lists and DAG nodes display it.' },
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
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'DAG predecessors: task ids that must settle before this one is delivered. '
          + 'While any predecessor is unsettled the task stays 待投递(queued) — the scheduler delivers '
          + 'it automatically once every dependency settles. Edit with edit_task before it dispatches.',
      },
      acceptance_criteria: {
        type: 'string',
        description: 'The minimum acceptance requirement the reviewer settles against; the worker can '
          + 'read it to know what "done" means.',
      },
      flow_id: {
        type: 'string',
        description: 'Flow to join (from create_flow). When set, every dependency must belong to the '
          + 'same flow — add a target task to the flow first if it is not there.',
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
    presentCall: (args) => ({ card: 'generic', title: 'agent-bus:创建任务', kind: 'other', rawInput: { target: args.target, ...(args.reviewer !== undefined ? { reviewer: args.reviewer } : {}), ...(args.task_id !== undefined ? { task_id: args.task_id } : {}) } }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'agent-bus:创建任务', rawInput: result }),
    async execute(args, exec) {
      const callerId = requireCaller(exec.agent, 'create_task')
      if (!limiter.admit(callerId, Date.now())) {
        throw new Error(
          `dispatch rate exceeded: at most ${config.maxSendsPerMinute} sends per minute`,
        )
      }
      const targetId = args.target as SessionId
      const decision = await authorizePeerOrDormant(ctx, workspaces, callerId, targetId)
      if (!decision.ok) throw new Error(decision.message)

      const admitted = admitContent(args.content, config.maxContentLength)
      if (!admitted.ok) throw new Error(admitted.message)
      const criteria = args.acceptance_criteria !== undefined
        ? admitContent(args.acceptance_criteria, 2000)
        : undefined
      if (criteria !== undefined && !criteria.ok) throw new Error(criteria.message)
      const title = admitContent(String(args.title ?? ''), 80)
      if (!title.ok) throw new Error(title.message)

      const mode: DeliveryMode = args.mode === 'steer' ? 'steer' : 'followup'

      // Answer path: the initiator replies to a worker's request_input. The
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

      // Create path: a fresh task node. Reviewer defaults to the initiator.
      const taskId = TaskId(randomTaskId())
      let reviewer: SessionId | undefined
      if (args.reviewer !== undefined) {
        const reviewerDecision = await authorizePeerOrDormant(ctx, workspaces, callerId, args.reviewer as SessionId)
        if (!reviewerDecision.ok) throw new Error(reviewerDecision.message)
        reviewer = args.reviewer as SessionId
      }
      // Self-execution keeps accountability: when the caller is also the
      // executor, the reviewer MUST be a different session — nobody approves
      // their own work.
      if (targetId === callerId) {
        if (reviewer === undefined || reviewer === callerId) {
          throw new Error(
            'self-execution requires reviewer: when target is yourself, name a different session as reviewer',
          )
        }
      }
      const dependencies = (args.dependencies as string[] | undefined)?.map(id => TaskId(id))
      // Flow membership: the flow must exist in the caller's workspace. The
      // same-flow dependency rule is enforced by the ledger at write time.
      let flowId: string | undefined
      if (args.flow_id !== undefined) {
        const flow = ledger.getFlow(args.flow_id)
        if (flow === undefined) throw new Error(`no such flow "${args.flow_id}"`)
        if (flow.workspacePath !== decision.workspacePath) {
          throw new Error(`flow "${args.flow_id}" belongs to another workspace`)
        }
        flowId = flow.id
      }
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
        ...(criteria?.ok === true ? { acceptanceCriteria: criteria.content } : {}),
        ...(flowId !== undefined ? { flowId } : {}),
        title: title.content,
      }, config.maxPendingPerAgent)
      if (!recorded.ok) throw new Error(recorded.message)

      // A task with dependencies is created queued(待投递) without delivery
      // until every predecessor settles; the scheduler delivers it then. A
      // task whose dependencies are already settled delivers immediately,
      // recording the message id before the inbox can claim it. A dormant
      // target is WOKEN (v1.5): the harness resumes the persisted session,
      // so the dispatch never fails on a closed tab; if the session cannot
      // be woken the task falls back to queued and the sweep retries.
      const blocked: string[] = dependencies === undefined
        ? []
        : [...blockedByOf(recorded.task, ledger.listAll()).map(String)]
      if (blocked.length === 0) {
        const target = await wakeSession(ctx, targetId)
        if (target !== undefined) {
          await ledger.recordDelivery(taskId, message.id)
          deliverTask(target, message, mode)
        } else {
          await ledger.transition(taskId, 'queued')
        }
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
      'Edit a task you created that has not been dispatched yet: rewrite its requirement text, its '
      + 'DAG predecessors (dependencies), and/or its acceptance criteria. The DAG is program-driven — '
      + 'if you find your flow unreasonable, fix it here before the task dispatches. A dispatched or '
      + 'running task cannot be edited; cancel and recreate instead. After the edit, the task '
      + 'dispatches automatically if every dependency has settled.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The undispatched task to edit.' },
      content: { type: 'string', description: 'New requirement text; omit to keep the current one.' },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'New predecessor list; omit to keep the current one, pass [] to clear all dependencies.',
      },
      acceptance_criteria: {
        type: 'string',
        description: 'New minimum acceptance requirement; omit to keep the current one.',
      },
      title: {
        type: 'string',
        description: 'New display title (1–80 chars); omit to keep the current one.',
      },
      flow_id: {
        type: 'string',
        description: 'Move the task to another flow; the new flow must contain every dependency of '
          + 'the task (dependencies move with it, so add them to the new flow first if needed).',
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
      rawInput: { task_id: args.task_id, ...(args.dependencies !== undefined ? { dependencies: args.dependencies } : {}) },
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
      const patch: {
        content?: string
        title?: string
        dependencies?: TaskId[]
        acceptanceCriteria?: string
        flowId?: string
      } = {}
      if (args.content !== undefined) {
        const admitted = admitContent(args.content, config.maxContentLength)
        if (!admitted.ok) throw new Error(admitted.message)
        patch.content = admitted.content
      }
      if (args.title !== undefined) {
        const admitted = admitContent(args.title, 80)
        if (!admitted.ok) throw new Error(admitted.message)
        patch.title = admitted.content
      }
      if (args.dependencies !== undefined) {
        patch.dependencies = (args.dependencies as string[]).map(id => TaskId(id))
      }
      if (args.acceptance_criteria !== undefined) {
        const admitted = admitContent(args.acceptance_criteria, 2000)
        if (!admitted.ok) throw new Error(admitted.message)
        patch.acceptanceCriteria = admitted.content
      }
      if (args.flow_id !== undefined) {
        const flow = ledger.getFlow(args.flow_id)
        if (flow === undefined) throw new Error(`no such flow "${args.flow_id}"`)
        patch.flowId = flow.id
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
      'List the ACTIVE tasks in the ledger. Scope inbox (default) shows work addressed to you, in the '
      + 'order you will do it; scope outbox shows what you dispatched and its current state. Archived '
      + 'tasks are invisible by design: a task leaves the listing once it failed, was canceled, or its '
      + 'settlement is more than 24 hours old — history lives in the panel and session logs. A completed '
      + 'task awaiting your verdict is still active and includes its report text, so read it before '
      + 'settling. Pass status to filter to one task state. Use get_task when a listing truncates a '
      + 'long report.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['inbox', 'outbox'],
        description: 'inbox (default) lists tasks assigned to you; outbox lists tasks you dispatched.',
      },
      status: {
        type: 'string',
        enum: [
          'queued', 'submitted', 'working', 'input-required', 'auth-required',
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
            acceptanceCriteria: { type: 'string' },
            dependencies: { type: 'array', items: { type: 'string' } },
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
      rows = rows.filter(row => isActiveTask(row, Date.now()))
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
          acceptanceCriteria: { type: 'string' },
          handoffs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fromTask: { type: 'string', required: true },
                document: { type: 'string', required: true },
                at: { type: 'string', required: true },
              },
            },
          },
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
        `任务 ${taskId} 已完成,当前状态为「待验收」,请调用 settle_task 验收。提交结果摘要:${excerpt}`,
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
        // Result returns to the initiator: the loop closes. The notice names
        // every downstream task this one feeds, and the executor is asked to
        // hand off structured context to each of them.
        const downstream = ledger.listAll()
          .filter(row => (row.dependencies ?? []).includes(taskId))
          .map(row => row.id)
        const handoffHint = downstream.length > 0
          ? `该任务为以下后向任务提供前向依赖:${downstream.join(', ')}。执行方请为每个后向任务调用 submit_handoff 提交交接文档。`
          : ''
        notifySession(ctx, task.assignedBy, taskId,
          `任务 ${taskId} 已验收通过,状态「已完成」(success)。${handoffHint}最终结果:${settled.task.report ?? '(无)'}`,
          'settle_task')
        if (task.assignedTo !== undefined && task.assignedTo !== task.assignedBy && downstream.length > 0) {
          notifySession(ctx, task.assignedTo, taskId,
            `任务 ${taskId} 已验收通过。它为以下后向任务提供前向依赖:${downstream.join(', ')}。`
              + `请为每个后向任务调用 submit_handoff(task_id=${taskId}, to_task_id=<后向任务id>, document=<交接文档>) 提交交接文档。`,
            'settle_task')
        }
        // End-of-flow summary: when the settled task closes out its whole
        // flow, the creator gets one aggregated notice instead of silence —
        // "the flow finished, here is every step's result".
        if (task.flowId !== undefined) {
          const flow = ledger.getFlow(task.flowId)
          const flowTasks = ledger.listAll().filter(row => row.flowId === task.flowId)
          const allDone = flowTasks.length > 0 && flowTasks.every(row =>
            (row.status === 'completed' && row.outcome === 'success')
            || row.status === 'failed' || row.status === 'canceled' || row.status === 'rejected')
          if (flow !== undefined && allDone) {
            const summary = flowTasks.map(row =>
              `${row.id.slice(0, 8)}: ${row.status === 'completed' ? `已完成(${row.outcome})` : row.status}`,
            ).join('\n')
            notifySession(ctx, flow.createdBy, taskId,
              `流程「${flow.name}」已全部结算,不再有进行中的任务。各任务结果:\n${summary}`,
              'settle_task')
          }
        }
      } else if (task.assignedTo !== undefined) {
        // Rework loop: the worker is woken to execute the SAME task again.
        // The rework notice is a new delivery of the task, so its message id
        // must be recorded on the row first — otherwise the claimed listener
        // cannot find the task and it never leaves `submitted`.
        const instruction = args.feedback !== undefined ? args.feedback : '请根据验收意见重新执行。'
        const reworkNotice = buildTaskMessage(callerId, taskId,
          `任务 ${taskId} 验收未通过,已返回「待执行」等待重新执行(failure)。修改意见:${instruction}。请重新执行后调用 report_task 再次提交。`,
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
      'As the dispatcher, cancel a task you dispatched while it is queued(待投递), submitted, '
      + 'working, or awaiting your input. The worker is interrupted, told the task is canceled, and '
      + 'asked to report a summary of what it had done; the summary lands on the task (read it with '
      + 'get_task). A task that was never delivered (待投递) is canceled without bothering the '
      + 'worker. Only the session that dispatched a task may cancel it; workers cannot cancel their '
      + 'own dispatched tasks.',
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
      // summary request is skipped. A queued task was never delivered, so its
      // worker has nothing to summarize — cancel quietly.
      const worker = task.assignedTo !== undefined && task.status !== 'queued'
        ? ctx.agents.get(task.assignedTo)
        : undefined
      if (worker !== undefined) {
        try {
          worker.cancel({ kind: 'user' }, { keepInbox: true })
        } catch {
          // The cancel signal is advisory; a worker that already settled the
          // turn needs no interruption.
        }
        const note = `任务 ${taskId} 状态「已取消」,由派发方取消${reason?.ok === true ? `(${reason.content})` : ''}。`
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
      + 'with create_task passing task_id, and the task resumes when the answer arrives. Keep the '
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
