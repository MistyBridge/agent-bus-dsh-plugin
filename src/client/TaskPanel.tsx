/**
 * Read-only v1.1 task panel: capsule → hover preview → click drawer.
 *
 * Styles live in TaskPanel.module.css. This pipeline compiles client sources
 * through tsc then tsdown (no lightningcss CSS-modules plugin), so the sheet
 * is injected as a tagged <style> and class names stay the authored `abP*`
 * locals. Keep the two copies in lockstep.
 *
 * @module dsh-agent-bus/client/TaskPanel
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { IconChevronDownOutline14, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import {
  emptySnapshot,
  formatTokenUsage,
  hasUnreadableTokens,
  callSteps,
  tokensForSession,
  archiveAgents,
  activeTabTasks,
  archiveTabTasks,
  recentActivity,
  relativeTime,
  sessionsOfWorkspace,
  sortSettled,
  sortUnsettled,
  statusLabel,
  statusTone,
  tasksOfSession,
  tasksOfWorkspace,
  truncateCodePoints,
  type PanelSnapshot,
  type TaskView,
  type TokenBuckets,
  type WorkspaceView,
} from './panel-model.ts'

const STATE_PATH = '/plugins/dsh-agent-bus/state'
const STORAGE_KEY = 'dsh-agent-bus.workspace'
const POLL_MS = 2000
const PREVIEW_SHOW_MS = 180
const PREVIEW_HIDE_MS = 2000
const STYLE_ID = 'dsh-agent-bus-panel-styles'

const ROLE_LABEL = {
  initiator: '发起',
  executor: '执行',
  reviewer: '验收',
} as const

/** Optional current-session feed; highlighting is best-effort. */
export interface TaskPanelProps {
  readonly sessionsList?: ObservableSnapshot<SessionListState>
}

function readStoredWorkspace(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredWorkspace(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* private mode */
  }
}

function asSnapshot(value: unknown): PanelSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.workspaces) || !Array.isArray(record.sessions) || !Array.isArray(record.tasks)) {
    return null
  }
  return value as PanelSnapshot
}

function resolveWorkspace(
  workspaces: readonly WorkspaceView[],
  storedId: string | null,
): WorkspaceView | null {
  if (workspaces.length === 0) return null
  const stored = storedId === null ? undefined : workspaces.find(item => item.id === storedId)
  return stored ?? workspaces[0] ?? null
}

function badgeKind(task: TaskView): 'solid' | 'dashed' | 'outline' {
  if (task.status === 'completed' && task.outcome === null) return 'dashed'
  if (task.status === 'canceled') return 'outline'
  return 'solid'
}

function reportZoneLabel(zone: TaskView['reportZone']): string | null {
  if (zone === 'hot') return '报告外置·热'
  if (zone === 'cold') return '报告外置·冷(已归档)'
  if (zone === 'missing') return '报告缺失'
  return null
}

function TokenTriple({ tokens }: { tokens: TokenBuckets | null }): JSX.Element {
  const hint = tokens === null ? undefined : `cache-write ${tokens.cacheWriteTokens}`
  return <div className={css.abPTriple} title={hint}>{formatTokenUsage(tokens)}</div>
}

function taskTouchesSession(task: TaskView, sessionId: string): boolean {
  return task.assignedBy === sessionId
    || task.assignedTo === sessionId
    || task.assignedReviewer === sessionId
}

function ensurePanelStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

function useCurrentSessionId(
  sessionsList: ObservableSnapshot<SessionListState> | undefined,
): string | undefined {
  const subscribe = useCallback((onStoreChange: () => void) => {
    if (sessionsList === undefined) return () => {}
    return sessionsList.subscribe(onStoreChange)
  }, [sessionsList])
  const getSnapshot = useCallback(
    () => sessionsList?.getSnapshot().current,
    [sessionsList],
  )
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined)
}

function usePanelSnapshot(): { snapshot: PanelSnapshot; loading: boolean } {
  const [snapshot, setSnapshot] = useState<PanelSnapshot>(emptySnapshot)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const pull = async (): Promise<void> => {
      try {
        const response = await fetch(STATE_PATH, { cache: 'no-store' })
        if (!response.ok) return
        const parsed = asSnapshot(await response.json())
        if (parsed === null || cancelled) return
        setSnapshot(parsed)
      } catch {
        /* keep the last good snapshot — host restart must not white-screen */
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void pull()
    const timer = window.setInterval(() => { void pull() }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return { snapshot, loading }
}

function StatusDot({ task, className }: { task: TaskView; className: string }): JSX.Element {
  const tone = statusTone(task.status, task.outcome)
  return <span className={className} data-tone={tone} aria-hidden="true" />
}

function StatusBadge({ task }: { task: TaskView }): JSX.Element {
  const tone = statusTone(task.status, task.outcome)
  return (
    <span className={css.abPBadge} data-tone={tone} data-kind={badgeKind(task)}>
      {statusLabel(task.status, task.outcome)}
    </span>
  )
}

function TaskCard({
  task,
  nowMs,
  currentSessionId,
  focused,
  onFocusTask,
}: {
  task: TaskView
  nowMs: number
  currentSessionId: string | undefined
  focused: boolean
  onFocusTask: (el: HTMLButtonElement) => void
}): JSX.Element {
  const current = currentSessionId !== undefined && taskTouchesSession(task, currentSessionId)
  return (
    <button
      type="button"
      className={css.abPTask}
      data-focused={focused || undefined}
      data-current={current || undefined}
      aria-expanded={focused}
      onMouseEnter={event => onFocusTask(event.currentTarget)}
      onFocus={event => onFocusTask(event.currentTarget)}
      onClick={event => onFocusTask(event.currentTarget)}
    >
      <div className={css.abPTaskLine}>
        <StatusBadge task={task} />
        <span className={css.abPTaskPreview}>{task.contentPreview}</span>
      </div>
      <div className={css.abPTaskMeta}>
        {`任务时间 ${relativeTime(task.updatedMs, nowMs)}`}
      </div>
    </button>
  )
}

function placeFloat(anchor: DOMRect): { top: number; left: number; width: number } {
  const drawer = document.querySelector(`.${css.abPDrawer}`)
  const drawerLeft = drawer instanceof HTMLElement
    ? drawer.getBoundingClientRect().left
    : window.innerWidth - 440
  const gap = 12
  const available = Math.max(200, drawerLeft - gap - 12)
  const width = Math.min(380, available)
  const left = Math.max(12, drawerLeft - gap - width)
  const maxHeight = Math.min(window.innerHeight - 24, 560)
  let top = anchor.top
  if (top + maxHeight > window.innerHeight - 12) {
    top = Math.max(12, window.innerHeight - 12 - maxHeight)
  }
  return { top, left, width }
}

function TaskFloat({
  task,
  nowMs,
  anchor,
  onReady,
  onClose,
}: {
  task: TaskView
  nowMs: number
  anchor: DOMRect
  onReady: (el: HTMLElement | null) => void
  onClose: () => void
}): JSX.Element {
  const zone = reportZoneLabel(task.reportZone)
  const box = placeFloat(anchor)
  const steps = callSteps(task)
  return (
    <article
      ref={onReady}
      className={css.abPFloat}
      style={{ top: box.top, left: box.left, width: box.width }}
    >
        <div className={css.abPFloatTop}>
          <StatusDot task={task} className={css.abPDot} />
          <div className={css.abPTaskSummary}>
            <div className={css.abPTaskLine}>
              <StatusBadge task={task} />
              <span className={css.abPFloatTitle}>{task.contentPreview}</span>
            </div>
            <div className={css.abPTaskMeta}>
              {`任务时间 ${relativeTime(task.updatedMs, nowMs)}`}
              {task.retries > 0 ? ` · 重做 ${task.retries}` : ''}
            </div>
          </div>
          <button type="button" className={css.abPClose} aria-label="关闭任务详情" onClick={onClose}>
            <IconCloseOutline16 size={16} />
          </button>
        </div>
        <div className={css.abPStaffHead}>
          本任务合计
          {hasUnreadableTokens(task.staff) ? ' · 部分会话不可读' : ''}
        </div>
        <TokenTriple tokens={task.taskTokensTotal} />
        <div className={css.abPCalls} aria-label="调用过程">
          {steps.map((step, index) => (
            <div key={`${step.from.sessionId}:${step.to.sessionId}:${index}`} className={css.abPCall}>
              <div className={css.abPCallHead}>
                <span className={css.abPCallWho}>{step.from.title}</span>
                <span className={css.abPChainArrow} aria-hidden="true">→</span>
                <span className={css.abPCallWho}>{step.to.title}</span>
                <span className={css.abPCallRoles}>
                  {`${ROLE_LABEL[step.from.role]} · ${ROLE_LABEL[step.to.role]}`}
                </span>
              </div>
              <div className={css.abPCallSummary}>{step.summary}</div>
              <div className={css.abPCallCost}>
                <span className={css.abPCallCostName}>{step.from.title}</span>
                <TokenTriple tokens={tokensForSession(task, step.from.sessionId)} />
              </div>
              <div className={css.abPCallCost}>
                <span className={css.abPCallCostName}>{step.to.title}</span>
                <TokenTriple tokens={tokensForSession(task, step.to.sessionId)} />
              </div>
            </div>
          ))}
        </div>
        {zone !== null && (
          <div className={css.abPZone} data-missing={task.reportZone === 'missing' || undefined}>
            {zone}
          </div>
        )}
      </article>
  )
}

const css = {
  abPRoot: 'abPRoot',
  abPCapsule: 'abPCapsule',
  abPCapsuleCount: 'abPCapsuleCount',
  abPCapsuleMeta: 'abPCapsuleMeta',
  abPCapsuleDot: 'abPCapsuleDot',
  abPPreview: 'abPPreview',
  abPPreviewHead: 'abPPreviewHead',
  abPPreviewWs: 'abPPreviewWs',
  abPPreviewStats: 'abPPreviewStats',
  abPPreviewList: 'abPPreviewList',
  abPPreviewRow: 'abPPreviewRow',
  abPPreviewTo: 'abPPreviewTo',
  abPPreviewText: 'abPPreviewText',
  abPPreviewEmpty: 'abPPreviewEmpty',
  abPDrawer: 'abPDrawer',
  abPTop: 'abPTop',
  abPWs: 'abPWs',
  abPWsBtn: 'abPWsBtn',
  abPWsTitle: 'abPWsTitle',
  abPWsChevron: 'abPWsChevron',
  abPWsMenu: 'abPWsMenu',
  abPWsItem: 'abPWsItem',
  abPWsItemPath: 'abPWsItemPath',
  abPClose: 'abPClose',
  abPBody: 'abPBody',
  abPSessions: 'abPSessions',
  abPAll: 'abPAll',
  abPAllBtn: 'abPAllBtn',
  abPAllToggle: 'abPAllToggle',
  abPGroup: 'abPGroup',
  abPSessionList: 'abPSessionList',
  abPSession: 'abPSession',
  abPSessionText: 'abPSessionText',
  abPSessionTitle: 'abPSessionTitle',
  abPOffline: 'abPOffline',
  abPOfflineToggle: 'abPOfflineToggle',
  abPLive: 'abPLive',
  abPMain: 'abPMain',
  abPEmpty: 'abPEmpty',
  abPEmptyTitle: 'abPEmptyTitle',
  abPEmptyHint: 'abPEmptyHint',
  abPTask: 'abPTask',
  abPTaskSummary: 'abPTaskSummary',
  abPTaskLine: 'abPTaskLine',
  abPTaskPreview: 'abPTaskPreview',
  abPTaskMeta: 'abPTaskMeta',
  abPDot: 'abPDot',
  abPBadge: 'abPBadge',
  abPFloat: 'abPFloat',
  abPFloatTop: 'abPFloatTop',
  abPFloatTitle: 'abPFloatTitle',
  abPChainArrow: 'abPChainArrow',
  abPCalls: 'abPCalls',
  abPCall: 'abPCall',
  abPCallHead: 'abPCallHead',
  abPCallWho: 'abPCallWho',
  abPCallRoles: 'abPCallRoles',
  abPCallSummary: 'abPCallSummary',
  abPCallCost: 'abPCallCost',
  abPCallCostName: 'abPCallCostName',
  abPZone: 'abPZone',
  abPStaffHead: 'abPStaffHead',
  abPTriple: 'abPTriple',
} as const

/**
 * Capsule / preview / drawer shell. Polls the host snapshot every 2s.
 */
export function TaskPanel({ sessionsList }: TaskPanelProps): JSX.Element {
  useLayoutEffect(() => { ensurePanelStyles() }, [])
  const { snapshot, loading } = usePanelSnapshot()
  const currentSessionId = useCurrentSessionId(sessionsList)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState(false)
  const [wsMenu, setWsMenu] = useState(false)
  const [sessionFilter, setSessionFilter] = useState<string | null>(null)
  const [archiveMode, setArchiveMode] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(true)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [offlineOpen, setOfflineOpen] = useState(false)
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null)
  const [floatAnchor, setFloatAnchor] = useState<DOMRect | null>(null)
  const floatRef = useRef<HTMLElement | null>(null)
  const [storedWorkspace, setStoredWorkspace] = useState<string | null>(readStoredWorkspace)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const showTimer = useRef(0)
  const hideTimer = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const workspace = useMemo(
    () => resolveWorkspace(snapshot.workspaces, storedWorkspace),
    [snapshot.workspaces, storedWorkspace],
  )

  const workspaceTasks = useMemo(
    () => tasksOfWorkspace(snapshot.tasks, workspace?.path ?? null),
    [snapshot.tasks, workspace],
  )

  const visibleTasks = useMemo(() => {
    const scoped = tasksOfSession(workspaceTasks, sessionFilter)
    if (archiveMode) return sortSettled(archiveTabTasks(scoped))
    return sortUnsettled(activeTabTasks(scoped), nowMs)
  }, [workspaceTasks, sessionFilter, archiveMode, nowMs])

  const focusedTask = useMemo(
    () => visibleTasks.find(task => task.id === focusedTaskId) ?? null,
    [visibleTasks, focusedTaskId],
  )

  const activeCount = useMemo(() => activeTabTasks(workspaceTasks).length, [workspaceTasks])
  const previewRows = useMemo(() => recentActivity(activeTabTasks(workspaceTasks), 3), [workspaceTasks])
  const workspaceSessions = useMemo(
    () => sessionsOfWorkspace(snapshot.sessions, workspace?.id ?? null),
    [snapshot.sessions, workspace],
  )
  const liveSessions = useMemo(
    () => workspaceSessions.filter(session => session.live),
    [workspaceSessions],
  )
  const offlineSessions = useMemo(
    () => workspaceSessions.filter(session => !session.live),
    [workspaceSessions],
  )
  const historicalAgents = useMemo(
    () => archiveAgents(workspaceTasks, snapshot.sessions),
    [workspaceTasks, snapshot.sessions],
  )

  const workingCount = workspaceTasks.filter(task => task.status === 'working').length
  const reviewCount = workspaceTasks.filter(task => task.status === 'completed' && !task.settled).length

  useEffect(() => {
    if (!open) {
      document.documentElement.removeAttribute('data-agent-bus-panel-open')
      return
    }
    document.documentElement.setAttribute('data-agent-bus-panel-open', '')
    return () => document.documentElement.removeAttribute('data-agent-bus-panel-open')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (focusedTaskId !== null) {
        setFocusedTaskId(null)
        setFloatAnchor(null)
        return
      }
      setOpen(false)
      setWsMenu(false)
    }
    const onPointer = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target)) return
      setOpen(false)
      setWsMenu(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
    }
  }, [open, focusedTaskId])

  useEffect(() => {
    if (focusedTaskId === null) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (floatRef.current?.contains(target)) return
      if (target instanceof Element && target.closest(`.${css.abPTask}`)) return
      setFocusedTaskId(null)
      setFloatAnchor(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [focusedTaskId])

  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [open])

  const clearPreviewTimers = (): void => {
    window.clearTimeout(showTimer.current)
    window.clearTimeout(hideTimer.current)
  }

  const armPreview = (): void => {
    if (open) return
    clearPreviewTimers()
    showTimer.current = window.setTimeout(() => setPreview(true), PREVIEW_SHOW_MS)
  }

  const disarmPreview = (): void => {
    clearPreviewTimers()
    hideTimer.current = window.setTimeout(() => setPreview(false), PREVIEW_HIDE_MS)
  }

  useEffect(() => () => clearPreviewTimers(), [])

  const selectWorkspace = (id: string): void => {
    setStoredWorkspace(id)
    writeStoredWorkspace(id)
    setSessionFilter(null)
    setArchiveMode(false)
    setSessionsOpen(true)
    setArchiveOpen(false)
    setFocusedTaskId(null)
    setWsMenu(false)
  }

  const selectAllSessions = (): void => {
    setArchiveMode(false)
    setSessionFilter(null)
    setSessionsOpen(true)
    setFocusedTaskId(null)
  }

  const toggleSessionList = (): void => {
    if (sessionsOpen) {
      setSessionsOpen(false)
      return
    }
    setSessionsOpen(true)
    setArchiveMode(false)
    setSessionFilter(null)
  }

  const toggleSession = (id: string): void => {
    setArchiveMode(false)
    setSessionFilter(current => !archiveMode && current === id ? null : id)
    setSessionsOpen(true)
  }

  const selectArchive = (): void => {
    setArchiveMode(true)
    setSessionFilter(null)
    setArchiveOpen(true)
    setFocusedTaskId(null)
  }

  const toggleArchiveList = (): void => {
    if (archiveOpen) {
      setArchiveOpen(false)
      return
    }
    setArchiveOpen(true)
    setArchiveMode(true)
    setSessionFilter(null)
  }

  const toggleArchiveAgent = (id: string): void => {
    setArchiveMode(true)
    setSessionFilter(current => archiveMode && current === id ? null : id)
    setArchiveOpen(true)
  }

  const openDrawer = (): void => {
    clearPreviewTimers()
    setPreview(false)
    setOpen(true)
  }

  const wsTitle = workspace?.title ?? '未选择工作区'
  const emptyLabel = archiveMode
    ? (sessionFilter === null ? '暂无归档任务' : '该会话暂无归档任务')
    : (sessionFilter === null ? '暂无活跃任务' : '该会话暂无活跃任务')
  const emptyHint = archiveMode
    ? '此工作区已结算的任务会列在这里'
    : '工作区内未结算的任务会列在这里'

  return (
    <div className={css.abPRoot} ref={rootRef} data-agent-bus-panel>
      <button
        type="button"
        className={css.abPCapsule}
        data-loading={loading || undefined}
        aria-expanded={open}
        aria-label={`任务面板，${activeCount} 个未结算`}
        onClick={openDrawer}
        onMouseEnter={armPreview}
        onMouseLeave={disarmPreview}
        onFocus={armPreview}
        onBlur={disarmPreview}
      >
        {activeCount === 0
          ? <span className={css.abPCapsuleDot} />
          : <span className={css.abPCapsuleCount}>{activeCount}</span>}
        <span className={css.abPCapsuleMeta}>{snapshot.workspaces.length} ws</span>
      </button>

      {preview && !open && (
        <div className={css.abPPreview} role="status">
          <div className={css.abPPreviewHead}>
            <div className={css.abPPreviewWs}>{wsTitle}</div>
            <div className={css.abPPreviewStats}>
              {`进行中 ${workingCount} · 待验收 ${reviewCount}`}
            </div>
          </div>
          {previewRows.length === 0
            ? <div className={css.abPPreviewEmpty}>暂无进行中的任务</div>
            : (
              <div className={css.abPPreviewList}>
                {previewRows.map(task => (
                  <div key={task.id} className={css.abPPreviewRow}>
                    <StatusDot task={task} className={css.abPDot} />
                    <div>
                      <div className={css.abPPreviewTo}>{task.toTitle ?? '—'}</div>
                      <div className={css.abPPreviewText}>
                        {truncateCodePoints(task.contentPreview, 60)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      <aside className={css.abPDrawer} data-open={open || undefined} aria-hidden={!open}>
        <div className={css.abPTop}>
          <div className={css.abPWs}>
            <button
              type="button"
              className={css.abPWsBtn}
              aria-haspopup="listbox"
              aria-expanded={wsMenu}
              onClick={() => setWsMenu(value => !value)}
            >
              <span className={css.abPWsTitle}>{wsTitle}</span>
              <span className={css.abPWsChevron}>
                <IconChevronDownOutline14 size={14} />
              </span>
            </button>
            {wsMenu && snapshot.workspaces.length > 0 && (
              <div className={css.abPWsMenu} role="listbox">
                {snapshot.workspaces.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={css.abPWsItem}
                    role="option"
                    data-active={item.id === workspace?.id || undefined}
                    aria-selected={item.id === workspace?.id}
                    onClick={() => selectWorkspace(item.id)}
                  >
                    <span>{item.title}</span>
                    <span className={css.abPWsItemPath}>{item.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className={css.abPClose}
            aria-label="关闭任务面板"
            onClick={() => { setOpen(false); setWsMenu(false) }}
          >
            <IconCloseOutline16 size={16} />
          </button>
        </div>
        <div className={css.abPBody}>
          <nav className={css.abPSessions} aria-label="会话">
            <div className={css.abPAll}>
              <button
                type="button"
                className={css.abPAllBtn}
                data-active={!archiveMode && sessionFilter === null || undefined}
                onClick={selectAllSessions}
              >
                活跃任务
              </button>
              <button
                type="button"
                className={css.abPAllToggle}
                data-open={sessionsOpen || undefined}
                aria-expanded={sessionsOpen}
                aria-label={sessionsOpen ? '折叠活跃任务列表' : '展开活跃任务'}
                onClick={toggleSessionList}
              >
                <IconChevronDownOutline14 size={14} />
              </button>
            </div>
            {sessionsOpen && (
              <div className={css.abPSessionList}>
                {liveSessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    className={css.abPSession}
                    data-active={!archiveMode && sessionFilter === session.id || undefined}
                    data-current={session.id === currentSessionId || undefined}
                    onClick={() => toggleSession(session.id)}
                  >
                    <span className={css.abPLive} data-on />
                    <span className={css.abPSessionText}>
                      <span className={css.abPSessionTitle}>{session.title}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className={css.abPGroup}>
              <div className={css.abPAll}>
                <button
                  type="button"
                  className={css.abPAllBtn}
                  data-active={archiveMode && sessionFilter === null || undefined}
                  onClick={selectArchive}
                >
                  归档任务
                </button>
                <button
                  type="button"
                  className={css.abPAllToggle}
                  data-open={archiveOpen || undefined}
                  aria-expanded={archiveOpen}
                  aria-label={archiveOpen ? '折叠归档任务列表' : '展开归档任务'}
                  onClick={toggleArchiveList}
                >
                  <IconChevronDownOutline14 size={14} />
                </button>
              </div>
              {archiveOpen && (
                <div className={css.abPSessionList}>
                  {historicalAgents.filter(agent => agent.live).map(agent => (
                    <button
                      key={agent.sessionId}
                      type="button"
                      className={css.abPSession}
                      data-active={archiveMode && sessionFilter === agent.sessionId || undefined}
                      data-current={agent.sessionId === currentSessionId || undefined}
                      onClick={() => toggleArchiveAgent(agent.sessionId)}
                    >
                      <span className={css.abPLive} data-on />
                      <span className={css.abPSessionText}>
                        <span className={css.abPSessionTitle}>{agent.title}</span>
                      </span>
                    </button>
                  ))}
                  {offlineSessions.length > 0 && (
                    <>
                      <button
                        type="button"
                        className={css.abPOfflineToggle}
                        data-open={offlineOpen || undefined}
                        aria-expanded={offlineOpen}
                        onClick={() => {
                          setOfflineOpen(value => !value)
                          setArchiveMode(true)
                          setSessionFilter(null)
                          setFocusedTaskId(null)
                        }}
                      >
                        <span>离线 {offlineSessions.length}</span>
                        <IconChevronDownOutline14 size={14} />
                      </button>
                      {offlineOpen && offlineSessions.map(session => (
                        <button
                          key={session.id}
                          type="button"
                          className={css.abPSession}
                          data-active={archiveMode && sessionFilter === session.id || undefined}
                          data-current={session.id === currentSessionId || undefined}
                          onClick={() => toggleArchiveAgent(session.id)}
                        >
                          <span className={css.abPLive} />
                          <span className={css.abPSessionText}>
                            <span className={css.abPSessionTitle}>{session.title}</span>
                            <span className={css.abPOffline}>离线</span>
                          </span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </nav>
          <div className={css.abPMain}>
            {visibleTasks.length === 0
              ? (
                <div className={css.abPEmpty}>
                  <div className={css.abPEmptyTitle}>{emptyLabel}</div>
                  {sessionFilter === null && (
                    <div className={css.abPEmptyHint}>{emptyHint}</div>
                  )}
                </div>
              )
              : visibleTasks.map(task => (
                <TaskCard
                  key={task.id}
                  task={task}
                  nowMs={nowMs}
                  currentSessionId={currentSessionId}
                  focused={task.id === focusedTaskId}
                  onFocusTask={el => {
                    setFocusedTaskId(task.id)
                    setFloatAnchor(el.getBoundingClientRect())
                  }}
                />
              ))}
          </div>
        </div>
      </aside>
      {focusedTask !== null && floatAnchor !== null && (
        <TaskFloat
          task={focusedTask}
          nowMs={nowMs}
          anchor={floatAnchor}
          onReady={el => { floatRef.current = el }}
          onClose={() => { setFocusedTaskId(null); setFloatAnchor(null) }}
        />
      )}
    </div>
  )
}

/** Fallback sheet used when the CSS-module import is not a raw stylesheet. */
const PANEL_CSS = "/* v1.1 task panel. Class prefix abP* stays clear of the host. Colors are\n   --dsw-alias-* tokens only; motion stays ≤150ms. */\n\n@media (min-width: 900px) {\n  html[data-agent-bus-panel-open] body {\n    padding-right: 440px;\n    box-sizing: border-box;\n  }\n}\n\n.abPRoot {\n  position: contents;\n  font-family: var(--dsw-font-family);\n  color: var(--dsw-alias-label-primary);\n  line-height: 1.45;\n}\n\n.abPCapsule {\n  position: fixed;\n  top: 50%;\n  right: 0;\n  z-index: 40;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  width: 48px;\n  min-height: 84px;\n  padding: 14px 6px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-right: none;\n  border-radius: 12px 0 0 12px;\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 90%, transparent);\n  color: var(--dsw-alias-label-primary);\n  box-shadow: -6px 0 20px var(--dsw-alias-bg-mask-2);\n  backdrop-filter: blur(12px);\n  cursor: pointer;\n  transform: translateY(-50%);\n  transition: transform 150ms var(--ds-ease-in-out, ease);\n}\n\n.abPCapsule:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 2px;\n}\n\nhtml[data-agent-bus-panel-open] .abPCapsule {\n  transform: translate(100%, -50%);\n  pointer-events: none;\n}\n\n.abPCapsuleCount {\n  font-size: 22px;\n  font-weight: 600;\n  line-height: 28px;\n  font-variant-numeric: tabular-nums;\n  letter-spacing: -0.03em;\n}\n\n.abPCapsuleMeta {\n  font-size: 11px;\n  line-height: 14px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPCapsuleDot {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  background: var(--dsw-alias-label-tertiary);\n  opacity: 0.65;\n}\n\n.abPCapsule[data-loading] .abPCapsuleDot,\n.abPCapsule[data-loading] .abPCapsuleCount {\n  animation: abPPulse 1.2s var(--ds-ease-in-out, ease) infinite;\n}\n\n.abPPreview {\n  position: fixed;\n  top: 50%;\n  right: 58px;\n  z-index: 41;\n  width: 280px;\n  padding: 14px 16px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 94%, transparent);\n  box-shadow: -8px 6px 24px var(--dsw-alias-bg-mask-2);\n  backdrop-filter: blur(12px);\n  transform: translateY(-50%);\n  pointer-events: none;\n}\n\nhtml[data-agent-bus-panel-open] .abPPreview {\n  display: none;\n}\n\n.abPPreviewHead {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  margin-bottom: 12px;\n  padding-bottom: 10px;\n  border-bottom: 1px solid var(--dsw-alias-border-l1);\n}\n\n.abPPreviewWs {\n  font-size: 13px;\n  font-weight: 600;\n  line-height: 20px;\n  color: var(--dsw-alias-label-primary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.abPPreviewStats {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPPreviewList {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n}\n\n.abPPreviewRow {\n  display: grid;\n  grid-template-columns: 8px minmax(0, 1fr);\n  gap: 10px;\n  align-items: start;\n}\n\n.abPPreviewTo {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPPreviewText {\n  font-size: 13px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-primary);\n  overflow: hidden;\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n}\n\n.abPPreviewEmpty {\n  font-size: 13px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPDrawer {\n  position: fixed;\n  top: 0;\n  right: 0;\n  z-index: 42;\n  display: flex;\n  flex-direction: column;\n  width: 440px;\n  height: 100vh;\n  border-left: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-layer-1);\n  box-shadow: -12px 0 32px var(--dsw-alias-bg-mask-2);\n  transform: translateX(100%);\n  transition: transform 150ms var(--ds-ease-in-out, ease);\n  pointer-events: none;\n  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);\n  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);\n}\n\n.abPDrawer[data-open] {\n  transform: translateX(0);\n  pointer-events: auto;\n}\n\n.abPTop {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex: none;\n  min-height: 56px;\n  padding: 10px 12px 10px 14px;\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.abPWs {\n  position: relative;\n  min-width: 0;\n  flex: 1;\n}\n\n.abPWsBtn {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  width: 100%;\n  min-height: 36px;\n  padding: 6px 10px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-2);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPWsBtn:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPWsBtn:focus-visible,\n.abPClose:focus-visible,\n.abPSession:focus-visible,\n.abPTask:focus-visible,\n.abPWsItem:focus-visible,\n.abPAllBtn:focus-visible,\n.abPAllToggle:focus-visible,\n.abPOfflineToggle:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n.abPWsTitle {\n  min-width: 0;\n  flex: 1;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 14px;\n  font-weight: 600;\n  line-height: 22px;\n}\n\n.abPWsChevron {\n  flex: none;\n  display: inline-flex;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPWsMenu {\n  position: absolute;\n  top: calc(100% + 6px);\n  left: 0;\n  right: 0;\n  z-index: 3;\n  max-height: 280px;\n  overflow: auto;\n  padding: 6px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-1);\n  box-shadow: 0 10px 24px var(--dsw-alias-bg-mask-2);\n}\n\n.abPWsItem {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  width: 100%;\n  padding: 8px 10px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: inherit;\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPWsItem:hover,\n.abPWsItem[data-active] {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPWsItemPath {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.abPClose {\n  flex: none;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 32px;\n  height: 32px;\n  padding: 0;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n}\n\n.abPClose:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.abPBody {\n  display: flex;\n  min-height: 0;\n  flex: 1;\n}\n\n.abPSessions {\n  display: flex;\n  flex-direction: column;\n  flex: none;\n  width: 148px;\n  padding: 10px 8px;\n  overflow: auto;\n  border-right: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-module-platform));\n}\n\n.abPGroup {\n  display: flex;\n  flex-direction: column;\n  margin-top: 10px;\n  padding-top: 10px;\n  border-top: 1px solid var(--dsw-alias-border-l2);\n}\n\n.abPAll {\n  display: flex;\n  align-items: stretch;\n  gap: 2px;\n  margin-bottom: 6px;\n}\n\n.abPAllBtn {\n  display: flex;\n  align-items: center;\n  min-width: 0;\n  flex: 1;\n  min-height: 34px;\n  padding: 6px 8px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 13px;\n  font-weight: 600;\n  line-height: 20px;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPAllBtn:hover,\n.abPAllToggle:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPAllBtn[data-active],\n.abPSession[data-active] {\n  background: var(--dsw-alias-button-ghost-active-fill);\n}\n\n.abPAllToggle {\n  flex: none;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  cursor: pointer;\n}\n\n.abPAllToggle[data-open] {\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPAllToggle[data-open] svg {\n  transform: rotate(180deg);\n}\n\n.abPAllToggle svg {\n  transition: transform 150ms var(--ds-ease-in-out, ease);\n}\n\n.abPSessionList {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.abPSession {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  width: 100%;\n  min-height: 34px;\n  padding: 6px 8px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 13px;\n  line-height: 20px;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPSession:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPSession[data-current] .abPSessionTitle {\n  font-weight: 600;\n}\n\n.abPSessionText {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  min-width: 0;\n  flex: 1;\n}\n\n.abPSessionTitle {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.abPOffline {\n  font-size: 11px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPOfflineToggle {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 6px;\n  width: 100%;\n  min-height: 30px;\n  margin-top: 4px;\n  padding: 4px 8px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  font: inherit;\n  font-size: 12px;\n  line-height: 18px;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPOfflineToggle:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPOfflineToggle svg {\n  flex: none;\n  transition: transform 150ms var(--ds-ease-in-out, ease);\n}\n\n.abPOfflineToggle[data-open] svg {\n  transform: rotate(180deg);\n}\n\n.abPLive {\n  flex: none;\n  width: 7px;\n  height: 7px;\n  margin-top: 6px;\n  border-radius: 50%;\n  background: var(--dsw-alias-label-tertiary);\n}\n\n.abPLive[data-on] {\n  background: var(--dsw-alias-state-success-primary);\n}\n\n.abPMain {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  min-width: 0;\n  flex: 1;\n  padding: 12px;\n  overflow: auto;\n}\n\n.abPEmpty {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  min-height: 160px;\n  padding: 24px 16px;\n  text-align: center;\n}\n\n.abPEmptyTitle {\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPEmptyHint {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPTask {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  width: 100%;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-2);\n  color: inherit;\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPTask:hover,\n.abPTask[data-focused] {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPTask[data-focused],\n.abPTask[data-current] {\n  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-border-l2));\n}\n\n.abPTaskSummary {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  min-width: 0;\n}\n\n.abPTaskLine {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n.abPTaskPreview {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 14px;\n  line-height: 22px;\n}\n\n.abPTaskMeta {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.abPDot {\n  width: 8px;\n  height: 8px;\n  margin-top: 7px;\n  border-radius: 50%;\n  background: var(--dsw-alias-label-tertiary);\n}\n\n.abPDot[data-tone='business'] { background: var(--dsw-alias-state-business-primary); }\n.abPDot[data-tone='warning'] { background: var(--dsw-alias-state-warn-primary); }\n.abPDot[data-tone='success'] { background: var(--dsw-alias-state-success-primary); }\n.abPDot[data-tone='danger'] { background: var(--dsw-alias-state-error-primary); }\n.abPDot[data-tone='tertiary'] { background: var(--dsw-alias-label-tertiary); }\n\n.abPBadge {\n  flex: none;\n  padding: 0 7px;\n  border: 1px solid transparent;\n  border-radius: 5px;\n  font-size: 12px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPBadge[data-tone='business'] {\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.abPBadge[data-tone='warning'] {\n  color: var(--dsw-alias-state-warn-label);\n  background: var(--dsw-alias-state-warn-tertiary);\n}\n\n.abPBadge[data-tone='success'] {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.abPBadge[data-tone='danger'] {\n  color: var(--dsw-alias-state-error-primary);\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n}\n\n.abPBadge[data-kind='dashed'] {\n  border-color: var(--dsw-alias-state-warn-primary);\n  border-style: dashed;\n  background: transparent;\n}\n\n.abPBadge[data-kind='outline'] {\n  border-color: var(--dsw-alias-border-l3);\n  background: transparent;\n}\n\n.abPFloat {\n  position: fixed;\n  z-index: 50;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  max-height: min(72vh, 560px);\n  overflow: auto;\n  padding: 14px 16px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 14px;\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent);\n  box-shadow: 0 18px 40px var(--dsw-alias-bg-mask-2);\n  backdrop-filter: blur(14px);\n  pointer-events: auto;\n}\n\n.abPFloatTop {\n  display: grid;\n  grid-template-columns: 8px minmax(0, 1fr) auto;\n  gap: 10px;\n  align-items: start;\n}\n\n.abPFloatTitle {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 14px;\n  line-height: 22px;\n}\n\n.abPChainArrow {\n  margin: 0 6px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPCalls {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n}\n\n.abPCall {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-2);\n}\n\n.abPCallHead {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: baseline;\n  gap: 2px 0;\n}\n\n.abPCallWho {\n  font-size: 14px;\n  font-weight: 600;\n  line-height: 22px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.abPCallRoles {\n  margin-left: 8px;\n  font-size: 11px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPCallSummary {\n  font-size: 13px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-secondary);\n  overflow-wrap: anywhere;\n}\n\n.abPCallCost {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.abPCallCostName {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.abPNote {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  padding: 10px 12px;\n  border-radius: 8px;\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPNoteLabel {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPNoteText {\n  font-size: 13px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-primary);\n  overflow-wrap: anywhere;\n}\n\n.abPContent {\n  max-height: 240px;\n  margin: 0;\n  padding: 10px 12px;\n  overflow: auto;\n  border-radius: 8px;\n  background: var(--dsw-alias-markdown-code-block);\n  color: var(--dsw-alias-label-secondary);\n  font-family: var(--ds-font-family-code);\n  font-size: 12px;\n  line-height: 20px;\n  white-space: pre-wrap;\n  word-break: break-word;\n}\n\n.abPZone {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPZone[data-missing] {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.abPStaff {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding-top: 8px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n.abPStaffHead {\n  font-size: 13px;\n  font-weight: 600;\n  line-height: 20px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPStaffRow {\n  display: grid;\n  grid-template-columns: 2em minmax(3em, 1fr);\n  gap: 4px 10px;\n  align-items: baseline;\n  padding: 8px 0 0;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n  font-size: 13px;\n  line-height: 20px;\n}\n\n.abPRole {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPStaffTitle {\n  min-width: 2em;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  color: var(--dsw-alias-label-primary);\n}\n\n.abPTriple {\n  grid-column: 1 / -1;\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px 14px;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n  font-variant-numeric: tabular-nums;\n}\n\n@keyframes abPPulse {\n  50% { opacity: 0.4; }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .abPCapsule,\n  .abPDrawer,\n  .abPAllToggle svg,\n  .abPOfflineToggle svg,\n  .abPCapsule[data-loading] .abPCapsuleDot,\n  .abPCapsule[data-loading] .abPCapsuleCount {\n    transition: none;\n    animation: none;\n  }\n}\n"
