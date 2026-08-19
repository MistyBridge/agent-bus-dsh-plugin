/**
 * Vocabulary types for the agent-bus task ledger: branded ids, the A2A-aligned
 * task lifecycle, the peer card, and the durable record shape.
 *
 * The ledger records intent and outcome. It is deliberately NOT a mirror of
 * the agent inbox: the inbox is the execution authority and the two drift by
 * design (an interrupt keeps unclaimed queue items but does not requeue a
 * claimed one, and disposal discards every unclaimed item).
 *
 * @module dsh-agent-bus/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Ledger-owned task identity. Independent of the harness `MessageId` because
 * a task exists in `submitted` before any delivery has produced one.
 */
export type TaskId = string & { readonly __brand: 'AgentBusTaskId' }

/** Brand a raw string as a {@link TaskId}; branding has no runtime effect. */
export function TaskId(value: string): TaskId {
  return value as TaskId
}

/**
 * Task lifecycle, verbatim A2A TaskState vocabulary. Extensions never add
 * states; they ride {@link TaskRecord.reason} and friends.
 *
 * - `submitted` — delivered to the worker, awaiting claim.
 * - `working` — claimed into a turn and executing.
 * - `input-required` — the worker asked the dispatcher for input; the task
 *   resumes `working` when the answer is claimed.
 * - `auth-required` — retained for vocabulary completeness; this plugin
 *   never produces it.
 * - `completed` — terminal. The worker reported; the report is the artifact.
 * - `failed` — terminal; {@link TaskRecord.reason} distinguishes timeout,
 *   no-response, discarded, and rejected-by-dispatcher.
 * - `canceled` — terminal; the dispatcher canceled.
 * - `rejected` — reserved; no transition produces it yet.
 */
export type TaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'

/** Verdict the dispatcher records on a completed task. */
export type TaskOutcome = 'success' | 'failure'

/**
 * Delivery mode requested for a task, mapped onto the harness inbox
 * boundaries. Task delivery uses `followup`; `inject` only enqueues and waits
 * for another message to wake the recipient, so it never carries work.
 */
export type DeliveryMode = 'followup' | 'steer'

/**
 * Four-bucket token usage, the same shape as the token-meter projection
 * (`uncachedInputTokens` / `outputTokens` / `cacheReadTokens` /
 * `cacheWriteTokens`). Used for task-period consumption deltas.
 */
export interface TokenBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** One machine-readable capability a peer advertises. */
export interface Capability {
  /** Machine key: kebab-case, matched by programs and future routing. */
  readonly id: string
  /** Short label for human and model readers. */
  readonly label: string
}

/**
 * One peer's self-maintained card. Keyed by the session id; the whole record
 * is overwritten on update, never field-merged.
 */
export interface PeerCard {
  /** Model-facing self-introduction. */
  readonly description: string
  /** Machine-readable capabilities, at most 8, ids unique. */
  readonly capabilities: readonly Capability[]
  /** ISO-8601 stamp of the last update. */
  readonly updatedAt: string
}

/**
 * One durable task row.
 */
export interface TaskRecord {
  /** Ledger identity. */
  readonly id: TaskId
  /** The session that initiated the task; cancel authority and final result reports belong to it. */
  readonly assignedBy: SessionId
  /** The worker that executes the task, absent until dispatched. */
  readonly assignedTo?: SessionId
  /** The session that reviews and settles the result; defaults to the initiator. */
  readonly assignedReviewer?: SessionId
  /** Canonical workspace path all parties shared at admission. */
  readonly workspacePath: string
  /** The task instruction delivered to the recipient. */
  readonly content: string
  /** Current lifecycle position. */
  readonly status: TaskStatus
  /** Requested delivery mode. */
  readonly mode: DeliveryMode
  /** Harness message identity of the latest delivery, present once dispatched. */
  readonly messageId?: string
  /** Turn that claimed the latest delivery, present from `working` onward. */
  readonly turn?: number
  /** Worker's report (the artifact) of the latest attempt; when externalized, an inline summary. */
  readonly report?: string
  /** Reference into the report store when the full report lives on disk. */
  readonly reportRef?: string
  /** The question the worker asked, present while `input-required`. */
  readonly question?: string
  /** Latest verdict: success is terminal; failure returns the row to `submitted` for rework. */
  readonly outcome?: TaskOutcome
  /** Review feedback: on failure it is the rework instruction. */
  readonly feedback?: string
  /** Failure classification: timeout, no-response, discarded, rejected-by-dispatcher. */
  readonly reason?: string
  /** Rework count: how many times this task has been sent back to the worker. */
  readonly retries: number
  /**
   * Dispatch-time token totals per participant session (deduplicated staff),
   * taken when the task was recorded. Task-period consumption is the current
   * projection minus this snapshot; absent sessions were offline at dispatch.
   */
  readonly tokensAtStart?: Record<string, TokenBuckets>
  /**
   * DAG predecessors: task ids that must settle (outcome success) before this
   * task may be dispatched. Written at creation, editable via edit_task while
   * the task is undispatched; the ledger rejects cycles and self-references.
   */
  readonly dependencies?: readonly TaskId[]
  /** Set when the scheduler auto-dispatched this task after its dependencies cleared. */
  readonly auto?: boolean
  /** ISO-8601 creation stamp. */
  readonly createdAt: string
  /** ISO-8601 stamp of the last status change. */
  readonly updatedAt: string
}
