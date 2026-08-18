/**
 * The task ledger: durable storage plus the A2A-aligned lifecycle machine.
 *
 * The ledger is the authority on intent and outcome, never on execution. The
 * agent inbox owns execution, and the two drift by design: an interrupt keeps
 * unclaimed queue items but does not requeue one already claimed into the
 * interrupted turn, and disposal discards every unclaimed item. So a row in
 * `submitted` or `working` records what was asked, not a promise that it will
 * finish. Two of those drifts are observable through inbox lifecycle events;
 * the third — a claimed message whose step is rejected, which emits neither
 * `discarded` nor any execution — is why `working` needs a timeout sweep
 * rather than pure event tracking.
 *
 * Domain reads are synchronous from the authoritative in-memory state; only
 * writes queue on the domain's own write chain.
 *
 * @module dsh-agent-bus/ledger
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  agentBusDomainSpec,
  type AgentBusDomainState,
  type StoredPeerCard,
  type StoredTaskRecord,
} from './spec.ts'
import {
  TaskId,
  type DeliveryMode,
  type PeerCard,
  type TaskOutcome,
  type TaskRecord,
  type TaskStatus,
  type TokenBuckets,
} from './types.ts'

/**
 * Lifecycle transitions. `completed` is NOT terminal: a failure verdict sends
 * the row back to `submitted` for rework, so one task id carries its whole
 * life across repeated attempts.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  submitted: ['working', 'failed', 'canceled'],
  working: ['completed', 'input-required', 'failed', 'canceled'],
  'input-required': ['working', 'failed', 'canceled'],
  'auth-required': [],
  completed: ['submitted'],
  failed: [],
  canceled: [],
  rejected: [],
}

/**
 * Report whether one lifecycle transition is permitted.
 *
 * @param from - the current status.
 * @param to - the proposed status.
 * @returns `true` when the transition is part of the state machine.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/**
 * Report whether a status admits no further transition.
 *
 * @param status - the status to test.
 * @returns `true` when the status is terminal.
 */
export function isTerminal(status: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0
}

/** Statuses that occupy a slot in a recipient's queue. */
const UNFINISHED: readonly TaskStatus[] = ['submitted', 'working', 'input-required']

/** Fields a caller supplies when recording a new task. */
export interface NewTask {
  /** Ledger identity, pre-generated so the delivery message can reference it. */
  readonly id: TaskId
  readonly assignedBy: SessionId
  readonly assignedTo: SessionId
  /** Reviewer, defaults to the initiator when absent. */
  readonly assignedReviewer?: SessionId
  readonly workspacePath: string
  readonly content: string
  readonly mode: DeliveryMode
  /** Harness message identity, recorded before delivery so the claimed listener can find the row. */
  readonly messageId: string
  /** Rework count; starts at 0 for a fresh task. */
  readonly retries: number
  /**
   * Dispatch-time token totals per participant session (deduplicated staff).
   * Optional: an offline session or an absent projection registry simply
   * leaves its key out, and the panel shows the delta as unavailable.
   */
  readonly tokensAtStart?: Record<string, TokenBuckets>
}

/** Result of a ledger mutation. */
export type LedgerResult =
  | { readonly ok: true; readonly task: TaskRecord }
  | { readonly ok: false; readonly message: string }

/**
 * Durable task ledger over one storage domain.
 *
 * Mutations that read-then-write are serialized through one local chain. The
 * domain form offers no cross-table transaction, so ordering those pairs here
 * is what keeps concurrent mutations from overwriting each other.
 */
export class TaskLedger {
  private table!: KvTable<TaskId, StoredTaskRecord>
  private peers!: KvTable<SessionId, StoredPeerCard>
  private global!: DomainGlobal<AgentBusDomainState>
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * Open the ledger domain and bind its teardown to the plugin lifetime.
   *
   * @param ctx - the plugin context, which must have `storageDomain` bound.
   * @returns the opened ledger.
   */
  static async open(ctx: Context): Promise<TaskLedger> {
    const ledger = new TaskLedger()
    const domain = await ctx.storageDomain.open(agentBusDomainSpec)
    ctx.effect(() => () => domain.close(), 'agent-bus.domainClose')
    ledger.table = domain.table('tasks')
    ledger.peers = domain.table('peers')
    ledger.global = domain.global
    return ledger
  }

  /** Serialize one mutation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => undefined)
    return next
  }

  /**
   * Record a new task in `submitted`.
   *
   * The row is written before any delivery so a delivery failure leaves a
   * durable trace instead of a silent loss.
   *
   * @param task - the dispatch intent.
   * @param maxPending - ceiling on unfinished rows for this recipient.
   * @returns the created row, or a refusal when the recipient's queue is full.
   */
  async record(task: NewTask, maxPending: number): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const pending = this.listFor(task.assignedTo).filter(row => UNFINISHED.includes(row.status))
      if (pending.length >= maxPending) {
        return {
          ok: false as const,
          message: `session "${task.assignedTo}" already has ${pending.length} unfinished tasks, at the ${maxPending} limit; wait for it to drain`,
        }
      }
      const now = new Date().toISOString()
      const record: StoredTaskRecord = {
        id: task.id,
        assignedBy: task.assignedBy,
        assignedTo: task.assignedTo,
        workspacePath: task.workspacePath,
        content: task.content,
        status: 'submitted',
        mode: task.mode,
        messageId: task.messageId,
        retries: task.retries,
        createdAt: now,
        updatedAt: now,
        ...(task.assignedReviewer !== undefined ? { assignedReviewer: task.assignedReviewer } : {}),
        ...(task.tokensAtStart !== undefined ? { tokensAtStart: task.tokensAtStart } : {}),
      }
      await this.table.put(record.id, record)
      const state = this.global.get()
      await this.global.set({ ...state, taskIds: [...state.taskIds, record.id] })
      return { ok: true as const, task: record }
    })
  }

  /**
   * Apply one status transition, rejecting a move the machine forbids.
   *
   * @param id - the row to advance.
   * @param to - the target status.
   * @param patch - fields to merge alongside the status change.
   * @returns the updated row, or a refusal naming the illegal transition.
   */
  async transition(
    id: TaskId,
    to: TaskStatus,
    patch: Partial<Omit<StoredTaskRecord, 'id' | 'status'>> = {},
  ): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        return { ok: false as const, message: `no such task "${id}"` }
      }
      if (!canTransition(current.status, to)) {
        return {
          ok: false as const,
          message: `task "${id}" is ${current.status}; it cannot become ${to}`,
        }
      }
      const updated: StoredTaskRecord = {
        ...current,
        ...patch,
        id: current.id,
        status: to,
        updatedAt: new Date().toISOString(),
      }
      await this.table.put(id, updated)
      return { ok: true as const, task: updated }
    })
  }

  /**
   * Record the delivery identity of the latest message without changing the
   * status. Used by the input-required answer path: the answer is a new
   * delivery on a paused task, and `transition` cannot move
   * `input-required → input-required`.
   *
   * @param id - the row to update.
   * @param messageId - the harness identity of the delivered answer.
   * @returns the updated row, or a refusal.
   */
  async recordDelivery(id: TaskId, messageId: string): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        return { ok: false as const, message: `no such task "${id}"` }
      }
      const updated: StoredTaskRecord = {
        ...current,
        messageId,
        updatedAt: new Date().toISOString(),
      }
      await this.table.put(id, updated)
      return { ok: true as const, task: updated }
    })
  }

  /**
   * Attach a report to a row without changing its status.
   *
   * Used twice: the normal report on the way to `completed` goes through
   * {@link transition} instead; this path serves the cancel-summary, which a
   * worker attaches to a `canceled` task whose state must not move.
   *
   * @param id - the row to attach to.
   * @param report - the report text.
   * @returns the updated row, or a refusal.
   */
  async attachReport(id: TaskId, report: string): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        return { ok: false as const, message: `no such task "${id}"` }
      }
      const updated: StoredTaskRecord = {
        ...current,
        report,
        updatedAt: new Date().toISOString(),
      }
      await this.table.put(id, updated)
      return { ok: true as const, task: updated }
    })
  }

  /**
   * Settle a completed task with the reviewer's verdict.
   *
   * Success records the verdict on the row and leaves it `completed` —
   * terminal. Failure sends the row BACK to `submitted` for rework on the
   * SAME task id: the feedback becomes the rework instruction, `retries`
   * increments, and the previous attempt's report and turn are cleared so the
   * next claim starts fresh. One task id carries its whole life across
   * attempts; there is no new-task redo chain.
   *
   * @param id - the completed row to settle.
   * @param outcome - the verdict.
   * @param feedback - reviewer note; on failure this is the rework instruction.
   * @returns the updated row, or a refusal.
   */
  async settle(
    id: TaskId,
    outcome: TaskOutcome,
    feedback: string | undefined,
  ): Promise<LedgerResult> {
    return this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        return { ok: false as const, message: `no such task "${id}"` }
      }
      if (current.status !== 'completed') {
        return {
          ok: false as const,
          message: `task "${id}" is ${current.status}; only a completed task can be settled`,
        }
      }
      if (outcome === 'success') {
        const updated: StoredTaskRecord = {
          ...current,
          outcome,
          updatedAt: new Date().toISOString(),
          ...(feedback !== undefined ? { feedback } : {}),
        }
        await this.table.put(id, updated)
        return { ok: true as const, task: updated }
      }
      const updated: StoredTaskRecord = {
        ...current,
        status: 'submitted',
        outcome,
        updatedAt: new Date().toISOString(),
        retries: current.retries + 1,
        report: undefined,
        turn: undefined,
        ...(feedback !== undefined ? { feedback } : {}),
      }
      await this.table.put(id, updated)
      return { ok: true as const, task: updated }
    })
  }

  /**
   * Read one row.
   *
   * @param id - the row to read.
   * @returns the row, or `undefined` when unknown.
   */
  get(id: TaskId): TaskRecord | undefined {
    return this.table.get(id)
  }

  /**
   * List rows addressed to one session, in creation order.
   *
   * @param sessionId - the recipient to filter by.
   * @returns matching rows.
   */
  listFor(sessionId: SessionId): TaskRecord[] {
    return this.listAll().filter(row => row.assignedTo === sessionId)
  }

  /**
   * List rows dispatched by one session, in creation order.
   *
   * @param sessionId - the dispatcher to filter by.
   * @returns matching rows.
   */
  listBy(sessionId: SessionId): TaskRecord[] {
    return this.listAll().filter(row => row.assignedBy === sessionId)
  }

  /**
   * List every row in creation order.
   *
   * Order comes from the global `taskIds` account rather than table iteration,
   * which the domain form does not promise to order.
   *
   * @returns every row the ledger holds.
   */
  listAll(): TaskRecord[] {
    const rows: TaskRecord[] = []
    for (const id of this.global.get().taskIds) {
      const row = this.table.get(id)
      if (row !== undefined) rows.push(row)
    }
    return rows
  }

  /**
   * Find the row a delivered message belongs to.
   *
   * Used by inbox lifecycle listeners, which know the `MessageId` but not the
   * ledger id.
   *
   * @param messageId - the harness message identity.
   * @returns the owning row, or `undefined` when the message is not ours.
   */
  findByMessage(messageId: string): TaskRecord | undefined {
    return this.listAll().find(row => row.messageId === messageId)
  }

  /**
   * Write one peer's card, replacing the previous one wholesale.
   *
   * @param sessionId - the card owner.
   * @param card - the validated card content.
   */
  async putCard(sessionId: SessionId, card: PeerCard): Promise<void> {
    await this.enqueue(async () => {
      await this.peers.put(sessionId, {
        description: card.description,
        capabilities: card.capabilities.map(cap => ({ id: cap.id, label: cap.label })),
        updatedAt: card.updatedAt,
      })
    })
  }

  /**
   * Read one peer's card.
   *
   * @param sessionId - the card owner.
   * @returns the card, or `undefined` when the peer never wrote one.
   */
  getCard(sessionId: SessionId): PeerCard | undefined {
    return this.peers.get(sessionId)
  }
}
