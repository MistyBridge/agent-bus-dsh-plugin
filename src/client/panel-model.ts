/**
 * Pure view-model helpers for the v1.1 read-only task panel.
 *
 * Snapshot shapes match docs/v1.1-task-panel-spec.md §3.6–3.7 / §4.4.
 * No I/O, no React — every export is unit-tested from tests/panel-model.test.ts.
 *
 * @module dsh-agent-bus/client/panel-model
 */

/** A2A TaskState vocabulary, mirrored so the client never imports the host module. */
export type TaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'archived'

/** Delivery mode requested for a task. */
export type DeliveryMode = 'followup' | 'steer'

/** Dispatcher verdict on a completed task. */
export type TaskOutcome = 'success' | 'failure'

/** Four-bucket token usage, same shape as the host TokenBuckets. */
export interface TokenBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** One participant on a task card's staff directory. */
export interface StaffEntry {
  readonly sessionId: string
  readonly title: string
  readonly role: 'initiator' | 'executor' | 'reviewer'
  readonly live: boolean
  readonly tokensInTask: TokenBuckets | null
}

/** One task row as projected by GET /plugins/dsh-agent-bus/state. */
export interface TaskView {
  readonly id: string
  readonly workspacePath: string
  readonly status: TaskStatus
  readonly settled: boolean
  readonly content: string
  readonly contentPreview: string
  readonly mode: DeliveryMode
  readonly assignedBy: string
  readonly assignedTo: string | null
  readonly assignedReviewer: string | null
  readonly byTitle: string
  readonly toTitle: string | null
  readonly reviewerTitle: string | null
  readonly retries: number
  readonly reason: string | null
  readonly outcome: TaskOutcome | null
  readonly feedback: string | null
  readonly question: string | null
  readonly reportZone: 'inline' | 'hot' | 'cold' | 'missing' | null
  readonly hasReportRef: boolean
  readonly turn: number | null
  readonly staff: readonly StaffEntry[]
  readonly taskTokensTotal: TokenBuckets | null
  /** Whether the executor (assignedTo) is live; the authoritative tab-partition key. */
  readonly executorLive: boolean
  /** Host-set when the task has entered the archive phase (completed ≥ 24h). */
  readonly archived?: boolean
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

/** Status counters, isomorphic with the host snapshot `stats` object. */
export interface StatsView {
  readonly submitted: number
  readonly working: number
  readonly 'input-required': number
  readonly completed: number
  readonly failed: number
  readonly canceled: number
  readonly total: number
}

/** One workspace in the snapshot directory. */
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
}

/** Full panel snapshot returned by the state route. */
export interface PanelSnapshot {
  readonly workspaces: readonly WorkspaceView[]
  readonly sessions: readonly SessionView[]
  readonly tasks: readonly TaskView[]
  readonly stats: StatsView
}

/** Color tone for a status dot / badge. */
export type Tone = 'tertiary' | 'business' | 'warning' | 'success' | 'danger'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

const EMPTY_STATS: StatsView = {
  submitted: 0,
  working: 0,
  'input-required': 0,
  completed: 0,
  failed: 0,
  canceled: 0,
  total: 0,
}

/**
 * Format a snapshot-relative age as a Chinese relative-time string.
 *
 * @param updatedMs - milliseconds since `updatedAt` (snapshot `updatedMs`).
 * @param nowMs - clock used only for the absolute `yyyy-mm-dd` fallback.
 */
export function relativeTime(updatedMs: number, nowMs: number): string {
  if (updatedMs < MINUTE_MS) return '刚刚'
  if (updatedMs < HOUR_MS) return `${Math.floor(updatedMs / MINUTE_MS)} 分钟前`
  if (updatedMs < DAY_MS) return `${Math.floor(updatedMs / HOUR_MS)} 小时前`
  if (updatedMs < WEEK_MS) return `${Math.floor(updatedMs / DAY_MS)} 天前`
  const date = new Date(nowMs - updatedMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Tasks that have not reached a terminal settled state. */
export function unsettledTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter(task => !task.settled)
}

/** Terminal settled tasks — the archive list. */
export function settledTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter(task => task.settled)
}

/** One historical participant drawn from settled workspace tasks. */
export interface ArchiveAgent {
  readonly sessionId: string
  readonly title: string
  readonly live: boolean
}

/**
 * Restrict tasks to those a session participates in.
 *
 * @param sessionId - `null` keeps every task.
 */
export function tasksOfSession(
  tasks: readonly TaskView[],
  sessionId: string | null,
): TaskView[] {
  if (sessionId === null) return [...tasks]
  return tasks.filter(task =>
    task.assignedBy === sessionId
    || task.assignedTo === sessionId
    || task.assignedReviewer === sessionId)
}

/**
 * Restrict tasks to one workspace path.
 *
 * @param workspacePath - `null` keeps every task.
 */
export function tasksOfWorkspace(
  tasks: readonly TaskView[],
  workspacePath: string | null,
): TaskView[] {
  if (workspacePath === null) return [...tasks]
  return tasks.filter(task => task.workspacePath === workspacePath)
}

/**
 * Unsettled tasks, oldest-updated first (the ones stuck longest sit on top).
 * Ties break on `createdAt` ascending. `nowMs` is accepted for the §4.4
 * signature; ordering is by the ISO stamps, not the clock.
 */
export function sortUnsettled(tasks: readonly TaskView[], _nowMs: number): TaskView[] {
  return unsettledTasks(tasks).sort((left, right) => {
    const updated = left.updatedAt.localeCompare(right.updatedAt)
    if (updated !== 0) return updated
    return left.createdAt.localeCompare(right.createdAt)
  })
}

/** Settled tasks, newest-updated first so the archive reads as history. */
export function sortSettled(tasks: readonly TaskView[]): TaskView[] {
  return settledTasks(tasks).sort((left, right) => {
    const updated = right.updatedAt.localeCompare(left.updatedAt)
    if (updated !== 0) return updated
    return right.createdAt.localeCompare(left.createdAt)
  })
}

/**
 * Distinct agents that participated in settled tasks, live first.
 * Titles prefer the session directory, then the task's resolved names.
 */
export function archiveAgents(
  tasks: readonly TaskView[],
  sessions: readonly SessionView[],
): ArchiveAgent[] {
  const byId = new Map(sessions.map(session => [session.id, session]))
  const seen = new Map<string, ArchiveAgent>()
  const consider = (sessionId: string | null, fallbackTitle: string | null): void => {
    if (sessionId === null || sessionId === '' || seen.has(sessionId)) return
    const session = byId.get(sessionId)
    seen.set(sessionId, {
      sessionId,
      title: session?.title ?? fallbackTitle ?? sessionId.slice(0, 8),
      live: session?.live ?? false,
    })
  }
  for (const task of settledTasks(tasks)) {
    consider(task.assignedTo, task.toTitle)
    consider(task.assignedReviewer, task.reviewerTitle)
    consider(task.assignedBy, task.byTitle)
  }
  return [...seen.values()].sort((left, right) => Number(right.live) - Number(left.live))
}

/** Recount status buckets from a task list (same keys as the host `stats`). */
export function statsOf(tasks: readonly TaskView[]): StatsView {
  const next: { -readonly [K in keyof StatsView]: number } = { ...EMPTY_STATS }
  for (const task of tasks) {
    next.total += 1
    switch (task.status) {
      case 'submitted':
      case 'working':
      case 'input-required':
      case 'completed':
      case 'failed':
      case 'canceled':
        next[task.status] += 1
        break
      default:
        break
    }
  }
  return next
}

/**
 * Most recently updated unsettled tasks, newest first — preview hover list.
 *
 * @param count - maximum rows to return.
 */
export function recentActivity(tasks: readonly TaskView[], count: number): TaskView[] {
  return unsettledTasks(tasks)
    .sort((left, right) => {
      const updated = right.updatedAt.localeCompare(left.updatedAt)
      if (updated !== 0) return updated
      return right.createdAt.localeCompare(left.createdAt)
    })
    .slice(0, Math.max(0, count))
}

/**
 * Truncate by Unicode code point so a surrogate pair (emoji) is never split.
 * Overflow is marked with a single `…`.
 */
export function truncateCodePoints(text: string, max: number): string {
  if (max <= 0) return text === '' ? '' : '…'
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, max).join('')}…`
}

/** Sum the four token buckets. */
export function tokenTotal(tokens: TokenBuckets): number {
  return tokens.uncachedInputTokens
    + tokens.outputTokens
    + tokens.cacheReadTokens
    + tokens.cacheWriteTokens
}

/** Three-part display: cache hit / input / output. */
export interface TokenParts {
  readonly cacheHit: number
  readonly input: number
  readonly output: number
}

/** Project four host buckets onto the three-part staff display. */
export function tokenParts(tokens: TokenBuckets): TokenParts {
  return {
    cacheHit: tokens.cacheReadTokens,
    input: tokens.uncachedInputTokens,
    output: tokens.outputTokens,
  }
}

/**
 * Cache-hit rate: cache-read / (cache-read + uncached input).
 * Missing when there is no input of either kind.
 */
export function cacheHitPercent(tokens: TokenBuckets): number | null {
  const denom = tokens.cacheReadTokens + tokens.uncachedInputTokens
  if (denom <= 0) return null
  return Math.round((tokens.cacheReadTokens / denom) * 100)
}

/** `缓存命中 92% · 输入 1,261 · 输出 732` */
/** One hop in the task's invocation chain. */
export interface CallHop {
  readonly sessionId: string
  readonly title: string
  readonly role: 'initiator' | 'executor' | 'reviewer'
}

/**
 * Invocation order for one task: initiator → executor → reviewer.
 * Executor is omitted when the task has no assignee yet.
 */
export function callChain(task: TaskView): CallHop[] {
  const hops: CallHop[] = [
    { sessionId: task.assignedBy, title: task.byTitle, role: 'initiator' },
  ]
  if (task.assignedTo !== null && task.assignedTo !== '') {
    hops.push({
      sessionId: task.assignedTo,
      title: task.toTitle ?? task.assignedTo.slice(0, 8),
      role: 'executor',
    })
  }
  const reviewerId = task.assignedReviewer ?? task.assignedBy
  hops.push({
    sessionId: reviewerId,
    title: task.reviewerTitle ?? task.byTitle,
    role: 'reviewer',
  })
  return hops
}

/** One directed call in the task: A → B plus the summary for that hop. */
export interface CallStep {
  readonly from: CallHop
  readonly to: CallHop
  readonly summary: string
}

/**
 * Expand the hop list into consecutive calls.
 * Dispatch uses the task instruction; review uses feedback / question.
 */
export function callSteps(task: TaskView): CallStep[] {
  const hops = callChain(task)
  const steps: CallStep[] = []
  for (let index = 0; index < hops.length - 1; index += 1) {
    const from = hops[index]
    const to = hops[index + 1]
    if (from === undefined || to === undefined) continue
    const reviewHop = from.role === 'executor' && to.role === 'reviewer'
    const summary = reviewHop
      ? (task.feedback !== null && task.feedback !== ''
        ? task.feedback
        : task.question !== null && task.question !== ''
          ? task.question
          : '提交验收')
      : task.contentPreview
    steps.push({ from, to, summary })
  }
  return steps
}

/** Task-period tokens for one participant, or null when unread. */
export function tokensForSession(task: TaskView, sessionId: string): TokenBuckets | null {
  return task.staff.find(entry => entry.sessionId === sessionId)?.tokensInTask ?? null
}

export function formatTokenUsage(tokens: TokenBuckets | null): string {
  if (tokens === null) return '缓存命中 — · 输入 — · 输出 —'
  const percent = cacheHitPercent(tokens)
  const hit = percent === null ? '—' : `${percent}%`
  return `缓存命中 ${hit} · 输入 ${formatNumber(tokens.uncachedInputTokens)} · 输出 ${formatNumber(tokens.outputTokens)}`
}

/** Thousand-separated integer (en-US grouping, ASCII digits). */
export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/**
 * Chinese status badge copy.
 *
 * `completed` without an outcome is 「待验收」; a recorded outcome is 「已完成」.
 */
export function statusLabel(status: TaskStatus, outcome?: TaskOutcome | null): string {
  switch (status) {
    case 'submitted': return '待执行'
    case 'working': return '进行中'
    case 'input-required': return '等待输入'
    case 'completed': return outcome === null || outcome === undefined ? '待验收' : '已完成'
    case 'failed': return '失败'
    case 'canceled': return '已取消'
    case 'archived': return '已归档'
    case 'auth-required': return '待授权'
    case 'rejected': return '已拒绝'
  }
}

/**
 * Status color tone. `completed` is warning while awaiting a verdict and
 * success once an outcome is recorded; the optional `outcome` exists because
 * the two completed presentations do not share a color.
 */
export function statusTone(status: TaskStatus, outcome?: TaskOutcome | null): Tone {
  switch (status) {
    case 'working': return 'business'
    case 'input-required': return 'warning'
    case 'completed': return outcome === 'success' || outcome === 'failure' ? 'success' : 'warning'
    case 'failed': return 'danger'
    case 'submitted':
    case 'canceled':
    case 'archived':
    case 'auth-required':
    case 'rejected':
      return 'tertiary'
  }
}

/** Sessions of one workspace, live rows first, original order otherwise preserved. */
export function sessionsOfWorkspace(
  sessions: readonly SessionView[],
  workspaceId: string | null,
): SessionView[] {
  const scoped = workspaceId === null
    ? [...sessions]
    : sessions.filter(session => session.workspaceId === workspaceId)
  return scoped.sort((left, right) => Number(right.live) - Number(left.live))
}

/**
 * A completed task stays in the active tab for this long after settlement;
 * the host then marks it archived. The client also applies this locally
 * when the snapshot has not yet set `archived`.
 */
export const ARCHIVE_AGE_MS = 24 * 60 * 60 * 1000

/** Host flag, dedicated status, or completed/settled older than 24h. */
export function isArchived(task: TaskView): boolean {
  if (task.archived === true || task.status === 'archived') return true
  return task.settled && task.updatedMs >= ARCHIVE_AGE_MS
}

/**
 * Active tab: in-progress (not settled) plus 已完成 that is not yet archived.
 * Failed / canceled rows go to archive; they are not "进行中" or "已完成".
 * An offline executor cannot hold active work, so its rows are
 * archive-bound immediately.
 */
export function activeTabTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter(task => {
    if (!task.executorLive) return false
    if (isArchived(task)) return false
    if (!task.settled) return true
    return task.status === 'completed'
  })
}

/**
 * Archive tab: everything of offline executors, host-archived rows,
 * completed-over-24h, and other terminals (failed / canceled) that are not
 * shown as active work.
 */
export function archiveTabTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter(task =>
    !task.executorLive || isArchived(task) || (task.settled && task.status !== 'completed'))
}

/** Active-tab order: in-progress first (oldest update), then 已完成 (newest). */
export function sortActive(tasks: readonly TaskView[]): TaskView[] {
  return [...tasks].sort((left, right) => {
    const leftDone = left.settled ? 1 : 0
    const rightDone = right.settled ? 1 : 0
    if (leftDone !== rightDone) return leftDone - rightDone
    if (!left.settled) {
      const updated = left.updatedAt.localeCompare(right.updatedAt)
      return updated !== 0 ? updated : left.createdAt.localeCompare(right.createdAt)
    }
    const updated = right.updatedAt.localeCompare(left.updatedAt)
    return updated !== 0 ? updated : right.createdAt.localeCompare(left.createdAt)
  })
}

/**
 * Sidebar sessions for one tab. The active tab lists live sessions only (an
 * offline session cannot have active work); the archive tab lists live
 * sessions first — without offline marking — and offline sessions after,
 * which the UI renders as its offline module.
 */
export function sessionsForTab(
  sessions: readonly SessionView[],
  archiveMode: boolean,
): SessionView[] {
  if (!archiveMode) return sessions.filter(session => session.live)
  return [...sessions].sort((left, right) => Number(right.live) - Number(left.live))
}

/** True when any staff row is missing a task-period token delta. */
export function hasUnreadableTokens(staff: readonly StaffEntry[]): boolean {
  return staff.some(entry => entry.tokensInTask === null)
}

const EMPTY_SNAPSHOT: PanelSnapshot = {
  workspaces: [],
  sessions: [],
  tasks: [],
  stats: EMPTY_STATS,
}

/** Empty snapshot used before the first successful poll (and on hard failure). */
export function emptySnapshot(): PanelSnapshot {
  return EMPTY_SNAPSHOT
}
