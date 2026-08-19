/**
 * Panel snapshot builder for the v1.1 task panel route.
 *
 * Serves the browser floater one whole workspace-scoped snapshot per poll:
 * the workspace directory, the session directory (with live flags), every
 * task projected to the panel's read view, and status counters. All inputs
 * come through `ctx.get` so the snapshot degrades — never throws — when a
 * service the Web profile mounts is absent.
 *
 * Token figures are the panel's only non-ledger data. A session's global
 * usage is dsh's own (token-meter projection, shown by the native UI); this
 * module only computes the task-period delta (`tokensAtStart` snapshot taken
 * at dispatch, see tools.ts) and its sum. Staff rows whose current projection
 * or starting snapshot is unavailable carry `null` and the sum is partial.
 *
 * @module dsh-agent-bus/panel
 */

import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry, Workspace } from '@deepseek-ai/dsh-workspace'
import type { ReportStore } from './external.ts'
import { blockedByOf, type TaskLedger } from './ledger.ts'
import type { TaskRecord, TokenBuckets } from './types.ts'
import { fallbackTitle, readTitlesFile } from './titles.ts'

export type { TokenBuckets } from './types.ts'

/** Four-bucket token usage reported by the token-meter projection. */
const TOKEN_KEYS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

/** Whether a value has the token-meter projection's bucket shape. */
export function isTokenBuckets(value: unknown): value is TokenBuckets {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return TOKEN_KEYS.every(key =>
    typeof record[key] === 'number' && Number.isFinite(record[key]) && record[key] >= 0)
}

/** One workspace entry in the snapshot directory. */
export interface WorkspaceView {
  readonly id: string
  readonly title: string
  readonly path: string
}

/** One session in the snapshot directory. */
export interface SessionView {
  readonly id: string
  readonly title: string
  readonly workspaceId: string | null
  readonly live: boolean
  /** Whether the session was archived in the workspace registry. */
  readonly archived: boolean
}

/** One participant on a task card's staff directory. */
export interface StaffEntry {
  readonly sessionId: string
  readonly title: string
  readonly role: 'initiator' | 'executor' | 'reviewer'
  readonly live: boolean
  /** Task-period token delta; unavailable projection or start snapshot → null. */
  readonly tokensInTask: TokenBuckets | null
}

/** One task row projected for the panel. Report text is never included. */
export interface TaskView {
  readonly id: string
  readonly workspacePath: string
  readonly status: TaskRecord['status']
  readonly settled: boolean
  readonly content: string
  readonly contentPreview: string
  readonly mode: TaskRecord['mode']
  readonly assignedBy: string
  readonly assignedTo: string | null
  readonly assignedReviewer: string | null
  readonly byTitle: string
  readonly toTitle: string | null
  readonly reviewerTitle: string | null
  readonly retries: number
  readonly reason: string | null
  readonly outcome: TaskRecord['outcome'] | null
  readonly feedback: string | null
  readonly question: string | null
  readonly reportZone: 'inline' | 'hot' | 'cold' | 'missing' | null
  readonly hasReportRef: boolean
  readonly turn: number | null
  readonly staff: readonly StaffEntry[]
  readonly taskTokensTotal: TokenBuckets | null
  /** Whether the executor (assignedTo) is live; the authoritative tab-partition key. */
  readonly executorLive: boolean
  /**
   * Whether the task reached the lifecycle's archive phase: settled and
   * settled more than {@link ARCHIVE_AGE_MS} ago. Host-derived so the panel
   * never computes the age client-side.
   */
  readonly archived: boolean
  /** DAG predecessors (task ids), in declaration order; empty when none. */
  readonly dependencies: readonly string[]
  /** Tasks that depend on this one (reverse edges for the DAG view). */
  readonly dependents: readonly string[]
  /** Unsettled dependencies; empty means the task is ready to dispatch. */
  readonly blockedBy: readonly string[]
  /** Whether the scheduler (not a tool call) delivered this task. */
  readonly auto: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly ageMs: number
  readonly updatedMs: number
}

/**
 * How long a settled task stays in the active tab before the lifecycle's
 * archive phase takes it over (24 hours).
 */
export const ARCHIVE_AGE_MS = 24 * 60 * 60 * 1000

/** Status counters, mirroring the client panel-model keys. */
export interface PanelStats {
  readonly submitted: number
  readonly working: number
  readonly 'input-required': number
  readonly completed: number
  readonly failed: number
  readonly canceled: number
  readonly total: number
}

/** The full document served by GET /plugins/dsh-agent-bus/state. */
export interface PanelSnapshot {
  readonly workspaces: readonly WorkspaceView[]
  readonly sessions: readonly SessionView[]
  readonly tasks: readonly TaskView[]
  readonly stats: PanelStats
}

/** Structural face of the projection registry (Service, optional at runtime). */
interface ProjectionRegistryLike {
  snapshot(session: Session): { values: Record<string, unknown> }
}

/** Structural face of the agent registry (already injected as `agents`). */
interface AgentRegistryLike {
  get(id: string): Agent | undefined
}

/** Mutable stats accumulator; the builder fills it in creation order. */
type MutableStats = { -readonly [K in keyof PanelStats]: number }

/** Empty stats row. */
function emptyStats(): MutableStats {
  return {
    submitted: 0, working: 0, 'input-required': 0,
    completed: 0, failed: 0, canceled: 0, total: 0,
  }
}

/**
 * Truncate by Unicode code point so a surrogate pair (emoji) is never split;
 * overflow is marked with a single ellipsis. Mirrors the client model.
 *
 * @param text - the text to truncate.
 * @param max - maximum code points before the ellipsis.
 * @returns the truncated text.
 */
export function truncateCodePoints(text: string, max: number): string {
  if (max <= 0) return text === '' ? '' : '…'
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, max).join('')}…`
}

/**
 * Locate an externalized report in the two-zone store.
 *
 * @param reports - the report store.
 * @param task - the row whose report zone is asked for.
 * @returns `'inline'` when the report rides the row, `'hot'` / `'cold'` when
 *   the file exists in the matching zone, `'missing'` when the reference
 *   names a file in neither zone, and `null` when the task has no report.
 */
export async function detectReportZone(
  reports: ReportStore,
  task: TaskRecord,
): Promise<TaskView['reportZone']> {
  if (task.report !== undefined && task.reportRef === undefined) return 'inline'
  if (task.reportRef === undefined) return null
  if (await reports.existsHot(task.reportRef)) return 'hot'
  if (await reports.existsCold(task.reportRef)) return 'cold'
  return 'missing'
}

/** Whether a completed row has been settled. */
function isSettled(task: TaskRecord): boolean {
  return task.status === 'completed'
    ? task.outcome !== undefined
    : task.status === 'failed' || task.status === 'canceled'
}

/** One role of the staff directory, in display order. */
type StaffRole = 'executor' | 'reviewer' | 'initiator'

/** Staff assembly input: session id plus the role it plays. */
interface RoleSlot {
  readonly sessionId: string
  readonly role: StaffRole
}

/**
 * The staff of one task from its three role holders: executor, reviewer,
 * initiator — deduplicated by session id (the initiator reviewing its own
 * task appears once, as executor or reviewer), fixed order executor →
 * reviewer → initiator. The reviewer defaults to the initiator.
 *
 * @param initiator - the dispatching session.
 * @param executor - the worker; may be absent until dispatched.
 * @param reviewer - the settling session; `undefined` falls back to the initiator.
 * @returns the role slots in display order.
 */
export function staffRoles(
  initiator: string | undefined,
  executor: string | undefined,
  reviewer: string | undefined,
): readonly RoleSlot[] {
  const slots: RoleSlot[] = []
  const seen = new Set<string>()
  const push = (sessionId: string | undefined, role: StaffRole): void => {
    if (sessionId === undefined || seen.has(sessionId)) return
    seen.add(sessionId)
    slots.push({ sessionId, role })
  }
  push(executor, 'executor')
  push(reviewer ?? initiator, 'reviewer')
  push(initiator, 'initiator')
  return slots
}

/**
 * The staff of one ledger row (see {@link staffRoles}).
 *
 * @param task - the row.
 * @returns the role slots in display order.
 */
export function staffRolesOf(task: TaskRecord): readonly RoleSlot[] {
  return staffRoles(task.assignedBy, task.assignedTo, task.assignedReviewer)
}

/**
 * The task-period token delta for one session: current projection minus the
 * dispatch-time snapshot, clamped at zero. Either side unavailable → null.
 *
 * @param projections - the projection registry, or `undefined` when absent.
 * @param agents - the agent registry (live sessions only).
 * @param task - the row holding the `tokensAtStart` snapshot.
 * @param sessionId - the staff session.
 * @returns the delta buckets, or `null` when it cannot be computed.
 */
export function tokenDeltaOf(
  projections: ProjectionRegistryLike | undefined,
  agents: AgentRegistryLike | undefined,
  task: TaskRecord,
  sessionId: string,
): TokenBuckets | null {
  const start = task.tokensAtStart?.[sessionId]
  if (start === undefined) return null
  const agent = agents?.get(sessionId)
  const current = agent === undefined ? undefined : projections?.snapshot(agent.session).values.tokenUsage
  if (!isTokenBuckets(current)) return null
  const clamp = (a: number, b: number): number => Math.max(0, a - b)
  return {
    uncachedInputTokens: clamp(current.uncachedInputTokens, start.uncachedInputTokens),
    outputTokens: clamp(current.outputTokens, start.outputTokens),
    cacheReadTokens: clamp(current.cacheReadTokens, start.cacheReadTokens),
    cacheWriteTokens: clamp(current.cacheWriteTokens, start.cacheWriteTokens),
  }
}

/** Sum token buckets; `null` when every input is null (never partial here). */
function sumTokens(entries: readonly (TokenBuckets | null)[]): TokenBuckets | null {
  let total: TokenBuckets | null = null
  for (const entry of entries) {
    if (entry === null) continue
    total = total === null
      ? { ...entry }
      : {
        uncachedInputTokens: total.uncachedInputTokens + entry.uncachedInputTokens,
        outputTokens: total.outputTokens + entry.outputTokens,
        cacheReadTokens: total.cacheReadTokens + entry.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens + entry.cacheWriteTokens,
      }
  }
  return total
}

/**
 * Build the panel's task view for one row: projection plus zone and staff.
 * Exported for unit tests with stub dependencies.
 *
 * @param task - the ledger row.
 * @param titles - session id → title.
 * @param agents - agent registry for live flags and projections.
 * @param projections - projection registry for token deltas.
 * @param reports - the two-zone report store (zone detection).
 * @param now - snapshot clock (ms since epoch).
 * @returns the projected row.
 */
export async function buildTaskView(
  task: TaskRecord,
  titles: ReadonlyMap<string, string>,
  agents: AgentRegistryLike | undefined,
  projections: ProjectionRegistryLike | undefined,
  reports: ReportStore,
  now: number,
): Promise<TaskView> {
  const titleOf = (sessionId: string | undefined): string | null =>
    sessionId === undefined ? null : titles.get(sessionId) ?? fallbackTitle(sessionId)
  const liveOf = (sessionId: string | undefined): boolean =>
    sessionId !== undefined && agents?.get(sessionId) !== undefined

  const staff: StaffEntry[] = staffRolesOf(task).map(({ sessionId, role }) => ({
    sessionId,
    title: titles.get(sessionId) ?? fallbackTitle(sessionId),
    role,
    live: liveOf(sessionId),
    tokensInTask: tokenDeltaOf(projections, agents, task, sessionId),
  }))

  return {
    id: task.id,
    workspacePath: task.workspacePath,
    status: task.status,
    settled: isSettled(task),
    dependencies: [...(task.dependencies ?? [])],
    content: task.content,
    contentPreview: truncateCodePoints(task.content, 120),
    mode: task.mode,
    assignedBy: task.assignedBy,
    assignedTo: task.assignedTo ?? null,
    assignedReviewer: task.assignedReviewer ?? null,
    byTitle: titleOf(task.assignedBy) ?? fallbackTitle(task.assignedBy),
    toTitle: titleOf(task.assignedTo),
    reviewerTitle: titleOf(task.assignedReviewer ?? task.assignedBy),
    retries: task.retries,
    reason: task.reason ?? null,
    outcome: task.outcome ?? null,
    feedback: task.feedback !== undefined ? truncateCodePoints(task.feedback, 200) : null,
    question: task.question !== undefined ? truncateCodePoints(task.question, 200) : null,
    reportZone: await detectReportZone(reports, task),
    hasReportRef: task.reportRef !== undefined,
    turn: task.turn ?? null,
    staff,
    taskTokensTotal: sumTokens(staff.map(entry => entry.tokensInTask)),
    executorLive: task.assignedTo !== undefined && agents?.get(task.assignedTo) !== undefined,
    archived: isSettled(task) && now - Date.parse(task.updatedAt) >= ARCHIVE_AGE_MS,
    dependents: [],
    blockedBy: [],
    auto: task.auto === true,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ageMs: Math.max(0, now - Date.parse(task.createdAt)),
    updatedMs: Math.max(0, now - Date.parse(task.updatedAt)),
  }
}

/**
 * How long a persisted session counts as "recently active" for the panel's
 * active-people directory (24 hours).
 */
export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * A log file at or below this size holds metadata events only (a seed that
 * ended without a turn); such blank sessions are excluded from the active
 * directory just like the harness sidebar hides them.
 */
const BLANK_LOG_BYTES = 8 * 1024

/** Cached per-session log probe: the stat calls are disk I/O, throttled. */
const logProbeCache = new Map<string, { at: number; ok: boolean }>()
const LOG_PROBE_TTL_MS = 30_000

/** Cached recent-activity probe: the mtime scan is disk I/O, throttled. */
let activeProbeCache: { at: number; ids: Set<string> } | null = null

/**
 * Whether a session's log exists on disk with more than metadata (a
 * substantial, real session). Blank seeds and vanished files return false.
 * Cached per session id so the 2s poll does not stat every log each tick.
 *
 * @param ctx - plugin context; the persistence store is optional.
 * @param sessionId - the session to probe.
 * @param now - probe clock.
 */
async function hasSubstantialLog(ctx: Context, sessionId: string, now: number): Promise<boolean> {
  const cached = logProbeCache.get(sessionId)
  if (cached !== undefined && now - cached.at < LOG_PROBE_TTL_MS) return cached.ok
  const persistence = ctx.get('sessionPersistence') as
    | { locate(meta: { id: string }): { path: string } | undefined }
    | undefined
  // No persistence store (degraded profile): cannot probe, keep the session.
  if (persistence === undefined) return true
  let ok = false
  try {
    const location = persistence.locate({ id: sessionId as never })
    if (location !== undefined) {
      const info = await stat(location.path)
      ok = info.size > BLANK_LOG_BYTES
    }
  } catch {
    ok = false
  }
  logProbeCache.set(sessionId, { at: now, ok })
  return ok
}

/**
 * The session directory: live non-subagent sessions that actually hold work,
 * plus persisted sessions whose log was written within
 * {@link ACTIVE_WINDOW_MS} (recently active, offline right now), plus any
 * session a task references (added by the caller).
 *
 * The harness attaches sessions lazily — a restarted host only knows the
 * sessions a browser has opened — so "live" alone would shrink the directory
 * to nothing after a restart. The mtime probe restores the recently-active
 * people without resurrecting the 41-session ghost pile (their logs are
 * older than the window). Blank sessions (seed without a turn) stay
 * excluded, mirroring the harness sidebar.
 *
 * @param ctx - plugin context; the session store is optional at runtime.
 * @param now - probe clock.
 * @returns the authoritative set of visible session ids.
 */
async function visibleSessionIds(ctx: Context, now: number): Promise<Set<string>> {
  const sessionStore = ctx.get('sessions') as
    | { list(): { id: string; header: { origin?: string }; events: readonly { type: string }[] }[] }
    | undefined
  const ids = new Set<string>()
  if (sessionStore !== undefined) {
    for (const session of sessionStore.list()) {
      if (session.header.origin === 'subagent') continue
      const hasTurn = session.events.some(
        event => event.type === 'user/message' || event.type === 'assistant/message',
      )
      if (!hasTurn) continue
      // A store entry without a real log on disk is not a conversation peer.
      if (!await hasSubstantialLog(ctx, session.id, now)) continue
      ids.add(session.id)
    }
  }
  const active = await recentlyActiveIds(ctx, now)
  for (const id of active) ids.add(id)
  // Archived sessions stay visible — the archive tab's offline module is
  // where they live — but only when they are also attached or recently
  // active: the registry's archive set accumulates every disposed session,
  // and a ghost pile must not resurrect on the sidebar.
  const registry = ctx.get('workspaceRegistry') as { archivedSessionIds?: readonly string[] } | undefined
  for (const id of registry?.archivedSessionIds ?? []) {
    if (ids.has(String(id)) || active.has(String(id))) ids.add(String(id))
  }
  return ids
}

/**
 * Persisted session ids whose log was modified within the active window.
 * Probed via the persistence store's own `locate`, cached for 30 seconds —
 * the 2s poll must not stat every log file on every tick.
 *
 * @param ctx - plugin context; the persistence store is optional.
 * @param now - probe clock.
 * @returns the recently-active session ids.
 */
async function recentlyActiveIds(ctx: Context, now: number): Promise<Set<string>> {
  if (activeProbeCache !== null && now - activeProbeCache.at < 30_000) {
    return activeProbeCache.ids
  }
  const persistence = ctx.get('sessionPersistence') as
    | { list(): Promise<{ id: string }[]>; locate(meta: { id: string }): { path: string } | undefined }
    | undefined
  const ids = new Set<string>()
  if (persistence !== undefined) {
    try {
      for (const meta of await persistence.list()) {
        const location = persistence.locate(meta)
        if (location === undefined) continue
        try {
          const info = await stat(location.path)
          if (now - info.mtimeMs >= ACTIVE_WINDOW_MS) continue
          if (info.size <= BLANK_LOG_BYTES) continue // metadata-only seed
          ids.add(meta.id)
        } catch {
          // No log file on disk: nothing to be active about.
        }
      }
      // Fold the store-probe results into the shared cache so the two paths
      // agree within one TTL window.
      for (const id of ids) {
        if (!logProbeCache.has(id)) logProbeCache.set(id, { at: now, ok: true })
      }
    } catch {
      // Degrade to the live set; the directory is a display concern.
    }
  }
  activeProbeCache = { at: now, ids }
  return ids
}

/**
 * Assemble the full snapshot: workspace directory, session directory, all
 * tasks, and counters. Any missing service degrades to empty arrays / nulls.
 *
 * @param ctx - the plugin context (services read via `ctx.get`).
 * @param ledger - the task ledger.
 * @param reports - the two-zone report store.
 * @param now - snapshot clock (ms since epoch); defaults to the current time.
 * @returns the snapshot document.
 */
export async function buildPanelSnapshot(
  ctx: Context,
  ledger: TaskLedger,
  reports: ReportStore,
  now: number = Date.now(),
): Promise<PanelSnapshot> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
  const workspaces = registry?.list() ?? []
  const agents = ctx.get('agents') as AgentRegistryLike | undefined
  const projections = ctx.get('sessionProjections') as ProjectionRegistryLike | undefined
  const titles = await readTitlesFile(
    dshHomePath('storages', 'session_projcache.json'),
  )
  // Live sessions: the title MUST match what the harness sidebar shows. The
  // sidebar reads the session-title projection ('title'), so the same
  // projection value overrides the disk cache for every live session; the
  // projection may legitimately be absent (title not generated yet), in which
  // case the disk value — or the id-prefix fallback — stands.
  const sessionStore = ctx.get('sessions') as { list(): { id: string; header: { origin?: string } }[] } | undefined
  if (agents !== undefined && projections !== undefined) {
    for (const session of sessionStore?.list() ?? []) {
      if (session.header.origin === 'subagent') continue
      const agent = agents.get(session.id)
      if (agent === undefined) continue
      const title = projections.snapshot(agent.session).values.title
      if (typeof title === 'string' && title !== '') titles.set(session.id, title)
    }
  }

  // Session directory: every visible session (sidebar same-source), mapped to
  // its owning workspace through the registry account, plus any session a
  // task references that is no longer visible (an offline reference).
  const registrySessionWorkspace = new Map<string, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      registrySessionWorkspace.set(String(sessionId), String(workspace.id))
    }
  }
  const visible = await visibleSessionIds(ctx, now)
  const archivedIds = new Set((registry?.archivedSessionIds ?? []).map(String))
  const sessionWorkspace = new Map<string, string>()
  for (const sessionId of visible) {
    sessionWorkspace.set(sessionId, registrySessionWorkspace.get(sessionId) ?? '')
  }
  for (const task of ledger.listAll()) {
    for (const sessionId of [task.assignedBy, task.assignedTo, task.assignedReviewer]) {
      if (sessionId !== undefined) sessionWorkspace.set(String(sessionId), sessionWorkspace.get(String(sessionId)) ?? '')
    }
  }
  const sessions: SessionView[] = []
  for (const [sessionId, workspaceId] of sessionWorkspace) {
    sessions.push({
      id: sessionId,
      title: titles.get(sessionId) ?? fallbackTitle(sessionId),
      workspaceId: workspaceId === '' ? null : workspaceId,
      live: agents?.get(sessionId) !== undefined,
      archived: archivedIds.has(sessionId),
    })
  }

  const tasks: TaskView[] = []
  const stats = emptyStats()
  const allRows = ledger.listAll()
  for (const task of allRows) {
    const view = await buildTaskView(task, titles, agents, projections, reports, now)
    tasks.push(view)
    stats.total += 1
    switch (task.status) {
      case 'submitted':
      case 'working':
      case 'input-required':
      case 'completed':
      case 'failed':
      case 'canceled':
        stats[task.status] += 1
        break
      default:
        break
    }
  }
  // DAG columns need the whole table: reverse edges and unsettled blockers.
  const rowById = new Map(allRows.map(row => [String(row.id), row]))
  for (let index = 0; index < tasks.length; index++) {
    const view = tasks[index]!
    const row = rowById.get(view.id)
    tasks[index] = {
      ...view,
      dependents: allRows
        .filter(item => (item.dependencies ?? []).some(dep => String(dep) === view.id))
        .map(item => String(item.id)),
      blockedBy: row === undefined ? [] : [...blockedByOf(row, allRows).map(String)],
    }
  }

  return {
    workspaces: workspaces.map(workspace => ({
      id: String(workspace.id),
      title: workspace.title,
      path: workspace.path,
    })),
    sessions,
    tasks,
    stats,
  }
}
