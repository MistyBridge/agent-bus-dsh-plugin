/**
 * Per-sender sliding-window rate limit on task dispatch.
 *
 * A dispatch loop is the failure mode this guards: two peers each told to
 * "send a task on failure" can double the queue every round. The ledger depth
 * ceiling bounds the queue size, but only after delivery; this ceiling bounds
 * the dispatch rate itself.
 *
 * The window is in-process and clears on restart, which is the documented
 * ceiling, not a durability promise.
 *
 * @module dsh-agent-bus/rate-limit
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Sliding-window dispatch limiter keyed by sender.
 */
export class DispatchRateLimiter {
  private readonly sends = new Map<SessionId, number[]>()

  /**
   * @param maxPerWindow - allowed dispatches per sender per window.
   * @param windowMs - window length in milliseconds.
   */
  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Record one dispatch and report whether it stayed within the ceiling.
   *
   * @param sender - the dispatching session.
   * @param now - current epoch milliseconds.
   * @returns `true` when the dispatch is admitted, `false` when refused.
   */
  admit(sender: SessionId, now: number): boolean {
    const cutoff = now - this.windowMs
    const window = (this.sends.get(sender) ?? []).filter(time => time > cutoff)
    if (window.length >= this.maxPerWindow) {
      this.sends.set(sender, window)
      return false
    }
    window.push(now)
    this.sends.set(sender, window)
    return true
  }
}
