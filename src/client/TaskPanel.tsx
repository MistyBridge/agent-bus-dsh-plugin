/**
 * Workbench: capsule → 3×3 launcher → sticky-note feature windows.
 * The existing task list is the first feature window.
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
  type PointerEvent as ReactPointerEvent,
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
  relativeTime,
  sessionsOfWorkspace,
  sortActive,
  sortSettled,
  statusLabel,
  statusTone,
  tasksOfSession,
  tasksOfWorkspace,
  flowsOfWorkspace,
  blockedByOf,
  type PanelSnapshot,
  type TaskView,
  type TokenBuckets,
  type WorkspaceView,
} from './panel-model.ts'
import { DagView } from './DagView.tsx'

const STATE_PATH = '/plugins/dsh-agent-bus/state'
const EVENTS_PATH = '/plugins/dsh-agent-bus/events'
const DISPATCH_PATH = '/plugins/dsh-agent-bus/dispatch'
const FLOW_KEY = 'dsh-agent-bus.dag.flow'
const STORAGE_KEY = 'dsh-agent-bus.workspace'
const SIDEBAR_KEY = 'dsh-agent-bus.sidebar-width'
const SIDEBAR_MIN = 128
const SIDEBAR_MAX = 280
const SIDEBAR_DEFAULT = 160
const TASK_NOTE_KEY = 'dsh-agent-bus.note.tasks'
const DAG_NOTE_KEY = 'dsh-agent-bus.note.dag'
const NOTE_MIN_W = 360
const NOTE_MIN_H = 320
const POLL_MS = 2000
const STYLE_ID = 'dsh-agent-bus-panel-styles'

type FeatureId = 'tasks' | 'dag'

const LAUNCHER_TILES: readonly {
  id: FeatureId | `soon-${number}`
  label: string
  mark: string
  ready: boolean
}[] = [
  { id: 'tasks', label: '任务', mark: '任', ready: true },
  { id: 'dag', label: '流程', mark: '流', ready: true },
  { id: 'soon-1', label: '预留', mark: '+', ready: false },
  { id: 'soon-2', label: '预留', mark: '+', ready: false },
  { id: 'soon-3', label: '预留', mark: '+', ready: false },
  { id: 'soon-4', label: '预留', mark: '+', ready: false },
  { id: 'soon-5', label: '预留', mark: '+', ready: false },
  { id: 'soon-6', label: '预留', mark: '+', ready: false },
  { id: 'soon-7', label: '预留', mark: '+', ready: false },
]

interface NoteGeom {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly pinned: boolean
}

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

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)))
}

function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY)
    if (raw === null) return SIDEBAR_DEFAULT
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_DEFAULT
  } catch {
    return SIDEBAR_DEFAULT
  }
}

function writeSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(width))
  } catch {
    /* private mode */
  }
}

function defaultTaskNoteGeom(): NoteGeom {
  const w = 520
  const h = Math.min(620, Math.max(NOTE_MIN_H, window.innerHeight - 96))
  return {
    x: Math.max(16, window.innerWidth - w - 72),
    y: Math.max(24, Math.round((window.innerHeight - h) / 2)),
    w,
    h,
    pinned: false,
  }
}

function defaultDagNoteGeom(): NoteGeom {
  const w = 760
  const h = Math.min(680, Math.max(400, window.innerHeight - 72))
  return {
    x: Math.max(16, window.innerWidth - w - 112),
    y: Math.max(24, Math.round((window.innerHeight - h) / 2) + 32),
    w,
    h,
    pinned: false,
  }
}

function clampNoteGeom(geom: NoteGeom): NoteGeom {
  const w = Math.min(Math.max(NOTE_MIN_W, geom.w), Math.max(NOTE_MIN_W, window.innerWidth - 24))
  const h = Math.min(Math.max(NOTE_MIN_H, geom.h), Math.max(NOTE_MIN_H, window.innerHeight - 24))
  const x = Math.min(Math.max(8, geom.x), Math.max(8, window.innerWidth - 80))
  const y = Math.min(Math.max(8, geom.y), Math.max(8, window.innerHeight - 40))
  return { x, y, w, h, pinned: geom.pinned }
}

function readNoteGeom(key: string, fallback: () => NoteGeom): NoteGeom {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback()
    const parsed = JSON.parse(raw) as Partial<NoteGeom>
    return clampNoteGeom({
      ...fallback(),
      ...parsed,
      pinned: parsed.pinned === true,
    })
  } catch {
    return fallback()
  }
}

function writeNoteGeom(key: string, geom: NoteGeom): void {
  try {
    localStorage.setItem(key, JSON.stringify(geom))
  } catch {
    /* private mode */
  }
}

function useNoteWindow(storageKey: string, fallback: () => NoteGeom) {
  const [open, setOpen] = useState(() => readNoteGeom(storageKey, fallback).pinned)
  const [geom, setGeom] = useState(() => readNoteGeom(storageKey, fallback))
  const geomRef = useRef(geom)
  geomRef.current = geom
  const drag = useRef<{ originX: number; originY: number; startX: number; startY: number } | null>(null)
  const resize = useRef<{ originX: number; originY: number; startW: number; startH: number } | null>(null)

  const persist = (next: NoteGeom): void => {
    const clamped = clampNoteGeom(next)
    geomRef.current = clamped
    setGeom(clamped)
    writeNoteGeom(storageKey, clamped)
  }

  const onDragDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      originX: event.clientX,
      originY: event.clientY,
      startX: geomRef.current.x,
      startY: geomRef.current.y,
    }
  }

  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === null) return
    persist({
      ...geomRef.current,
      x: current.startX + event.clientX - current.originX,
      y: current.startY + event.clientY - current.originY,
    })
  }

  const onDragUp = (): void => {
    drag.current = null
  }

  const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    resize.current = {
      originX: event.clientX,
      originY: event.clientY,
      startW: geomRef.current.w,
      startH: geomRef.current.h,
    }
  }

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = resize.current
    if (current === null) return
    persist({
      ...geomRef.current,
      w: current.startW + event.clientX - current.originX,
      h: current.startH + event.clientY - current.originY,
    })
  }

  const onResizeUp = (): void => {
    resize.current = null
  }

  return { open, setOpen, geom, geomRef, persist, onDragDown, onDragMove, onDragUp, onResizeDown, onResizeMove, onResizeUp }
}

function asSnapshot(value: unknown): PanelSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.workspaces) || !Array.isArray(record.sessions) || !Array.isArray(record.tasks)) {
    return null
  }
  if (!Array.isArray(record.flows)) {
    return { ...(value as PanelSnapshot), flows: [] }
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
  if (task.status === 'queued') return 'dashed'
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

function dispatchReady(tasks: readonly TaskView[], changedId: string | null): void {
  const candidates = changedId === null
    ? tasks.filter(task => task.status === 'queued')
    : tasks.filter(task =>
      task.status === 'queued' && (task.id === changedId || task.dependencies.includes(changedId)))
  for (const task of candidates) {
    if (blockedByOf(task, tasks).length > 0) continue
    void fetch(DISPATCH_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: task.id }),
    })
  }
}

function usePanelSnapshot(): { snapshot: PanelSnapshot; loading: boolean } {
  const [snapshot, setSnapshot] = useState<PanelSnapshot>(emptySnapshot)
  const [loading, setLoading] = useState(true)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  useEffect(() => {
    let cancelled = false
    let pollTimer: number | null = null

    const pull = async (changedId: string | null): Promise<void> => {
      try {
        const response = await fetch(STATE_PATH, { cache: 'no-store' })
        if (!response.ok) return
        const parsed = asSnapshot(await response.json())
        if (parsed === null || cancelled) return
        snapshotRef.current = parsed
        setSnapshot(parsed)
        if (changedId !== null) dispatchReady(parsed.tasks, changedId)
      } catch {
        /* keep the last good snapshot — host restart must not white-screen */
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    const startPoll = (): void => {
      if (pollTimer !== null) return
      pollTimer = window.setInterval(() => { void pull(null) }, POLL_MS)
    }
    const stopPoll = (): void => {
      if (pollTimer === null) return
      window.clearInterval(pollTimer)
      pollTimer = null
    }

    void pull(null).then(() => {
      if (!cancelled) dispatchReady(snapshotRef.current.tasks, null)
    })

    let source: EventSource | null = null
    try {
      source = new EventSource(EVENTS_PATH)
      source.onopen = () => { stopPoll() }
      source.onerror = () => { startPoll() }
      source.onmessage = event => {
        let changedId: string | null = null
        try {
          const payload = JSON.parse(event.data) as { taskId?: unknown }
          if (typeof payload.taskId === 'string') changedId = payload.taskId
        } catch {
          changedId = null
        }
        void pull(changedId)
      }
    } catch {
      startPoll()
    }

    return () => {
      cancelled = true
      stopPoll()
      source?.close()
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
        <div className={css.abPReq}>
          <div className={css.abPStaffHead}>任务要求</div>
          <pre className={css.abPContent}>{task.content}</pre>
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
  abPLauncher: 'abPLauncher',
  abPLaunchTile: 'abPLaunchTile',
  abPLaunchMark: 'abPLaunchMark',
  abPNote: 'abPNote',
  abPNoteBar: 'abPNoteBar',
  abPNoteTitle: 'abPNoteTitle',
  abPNotePin: 'abPNotePin',
  abPNoteBody: 'abPNoteBody',
  abPNoteGrip: 'abPNoteGrip',
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
  abPResize: 'abPResize',
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
  abPContent: 'abPContent',
  abPReq: 'abPReq',
  abPStaffHead: 'abPStaffHead',
  abPTriple: 'abPTriple',
} as const

/**
 * Capsule opens the launcher; 任务 / 流程 each open a sticky-note window.
 */
export function TaskPanel({ sessionsList }: TaskPanelProps): JSX.Element {
  useLayoutEffect(() => { ensurePanelStyles() }, [])
  const { snapshot, loading } = usePanelSnapshot()
  const currentSessionId = useCurrentSessionId(sessionsList)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const taskNote = useNoteWindow(TASK_NOTE_KEY, defaultTaskNoteGeom)
  const dagNote = useNoteWindow(DAG_NOTE_KEY, defaultDagNoteGeom)
  const [front, setFront] = useState<FeatureId>('tasks')
  const [wsMenu, setWsMenu] = useState(false)
  const [dagWsMenu, setDagWsMenu] = useState(false)
  const [sessionFilter, setSessionFilter] = useState<string | null>(null)
  const [storedFlow, setStoredFlow] = useState<string | null>(() => {
    try {
      return localStorage.getItem(FLOW_KEY)
    } catch {
      return null
    }
  })
  const [archiveMode, setArchiveMode] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(true)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [offlineOpen, setOfflineOpen] = useState(false)
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null)
  const [floatAnchor, setFloatAnchor] = useState<DOMRect | null>(null)
  const floatRef = useRef<HTMLElement | null>(null)
  const dagEscRef = useRef<(() => boolean) | null>(null)
  const [storedWorkspace, setStoredWorkspace] = useState<string | null>(readStoredWorkspace)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const sidebarWidthRef = useRef(sidebarWidth)
  sidebarWidthRef.current = sidebarWidth
  const sidebarDrag = useRef<{ origin: number; start: number } | null>(null)

  const onSidebarResizeDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    sidebarDrag.current = { origin: event.clientX, start: sidebarWidthRef.current }
  }

  const onSidebarResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = sidebarDrag.current
    if (drag === null) return
    setSidebarWidth(clampSidebarWidth(drag.start + event.clientX - drag.origin))
  }

  const onSidebarResizeUp = (): void => {
    if (sidebarDrag.current === null) return
    sidebarDrag.current = null
    writeSidebarWidth(sidebarWidthRef.current)
  }

  const workspace = useMemo(
    () => resolveWorkspace(snapshot.workspaces, storedWorkspace),
    [snapshot.workspaces, storedWorkspace],
  )

  const workspaceTasks = useMemo(
    () => tasksOfWorkspace(snapshot.tasks, workspace?.path ?? null),
    [snapshot.tasks, workspace],
  )

  const workspaceFlows = useMemo(
    () => flowsOfWorkspace(snapshot.flows, workspace?.path ?? null),
    [snapshot.flows, workspace],
  )

  const selectedFlowId = useMemo(() => {
    if (workspaceFlows.length === 0) return null
    const stored = storedFlow === null ? undefined : workspaceFlows.find(flow => flow.id === storedFlow)
    return stored?.id ?? workspaceFlows[0]?.id ?? null
  }, [workspaceFlows, storedFlow])

  const visibleTasks = useMemo(() => {
    const scoped = tasksOfSession(workspaceTasks, sessionFilter)
    if (archiveMode) return sortSettled(archiveTabTasks(scoped))
    return sortActive(activeTabTasks(scoped))
  }, [workspaceTasks, sessionFilter, archiveMode, nowMs])

  const focusedTask = useMemo(
    () => visibleTasks.find(task => task.id === focusedTaskId) ?? null,
    [visibleTasks, focusedTaskId],
  )

  const activeCount = useMemo(() => activeTabTasks(workspaceTasks).length, [workspaceTasks])
  const workspaceSessions = useMemo(
    () => sessionsOfWorkspace(snapshot.sessions, workspace?.id ?? null),
    [snapshot.sessions, workspace],
  )
  // Session directory mirrors the harness sidebar exactly: a session is
  // active (workspace sidebar, live or not) or archived (manually archived in
  // the workspace). Attach state (session.live) is a runtime status dot only,
  // never a partition key.
  const activeSessions = useMemo(
    () => workspaceSessions.filter(session => !session.archived),
    [workspaceSessions],
  )
  const archivedSessions = useMemo(
    () => workspaceSessions.filter(session => session.archived),
    [workspaceSessions],
  )
  const historicalAgents = useMemo(
    () => archiveAgents(workspaceTasks, snapshot.sessions),
    [workspaceTasks, snapshot.sessions],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (dagEscRef.current?.()) return
      if (focusedTaskId !== null) {
        setFocusedTaskId(null)
        setFloatAnchor(null)
        return
      }
      if (launcherOpen) {
        setLauncherOpen(false)
        setWsMenu(false)
        setDagWsMenu(false)
        return
      }
      if (front === 'dag' && dagNote.open && !dagNote.geom.pinned) {
        dagNote.setOpen(false)
        setDagWsMenu(false)
        return
      }
      if (taskNote.open && !taskNote.geom.pinned) {
        taskNote.setOpen(false)
        setWsMenu(false)
        setFocusedTaskId(null)
        setFloatAnchor(null)
        return
      }
      if (dagNote.open && !dagNote.geom.pinned) {
        dagNote.setOpen(false)
        setDagWsMenu(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [
    focusedTaskId,
    launcherOpen,
    front,
    taskNote.open,
    taskNote.geom.pinned,
    dagNote.open,
    dagNote.geom.pinned,
    taskNote,
    dagNote,
  ])

  useEffect(() => {
    if (!launcherOpen) return
    const onPointer = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (target instanceof Element && target.closest(`.${css.abPLauncher}`)) return
      if (target instanceof Element && target.closest(`.${css.abPCapsule}`)) return
      setLauncherOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [launcherOpen])

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
    if (!taskNote.open && !dagNote.open) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [taskNote.open, dagNote.open])

  const openFeature = (id: FeatureId): void => {
    if (id === 'tasks') taskNote.setOpen(true)
    else dagNote.setOpen(true)
    setFront(id)
    setLauncherOpen(false)
  }

  const closeTaskNote = (): void => {
    taskNote.setOpen(false)
    setWsMenu(false)
    setFocusedTaskId(null)
    setFloatAnchor(null)
  }

  const closeDagNote = (): void => {
    dagNote.setOpen(false)
    setDagWsMenu(false)
  }

  const selectWorkspace = (id: string): void => {
    setStoredWorkspace(id)
    writeStoredWorkspace(id)
    setSessionFilter(null)
    setArchiveMode(false)
    setSessionsOpen(true)
    setArchiveOpen(false)
    setFocusedTaskId(null)
    setWsMenu(false)
    setDagWsMenu(false)
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

  const wsTitle = workspace?.title ?? '未选择工作区'
  const emptyLabel = archiveMode
    ? (sessionFilter === null ? '暂无归档任务' : '该会话暂无归档任务')
    : (sessionFilter === null ? '暂无活跃任务' : '该会话暂无活跃任务')
  const emptyHint = archiveMode
    ? '已完成超过 24 小时的任务会列在这里'
    : '进行中和已完成的任务会列在这里'

  return (
    <div className={css.abPRoot} ref={rootRef} data-agent-bus-panel>
      <button
        type="button"
        className={css.abPCapsule}
        data-loading={loading || undefined}
        data-open={launcherOpen || undefined}
        aria-expanded={launcherOpen}
        aria-label={`工作台，${activeCount} 个活跃任务`}
        onClick={() => setLauncherOpen(value => !value)}
      >
        {activeCount === 0
          ? <span className={css.abPCapsuleDot} />
          : <span className={css.abPCapsuleCount}>{activeCount}</span>}
        <span className={css.abPCapsuleMeta}>{snapshot.workspaces.length} ws</span>
      </button>

      {launcherOpen && (
        <div className={css.abPLauncher} role="menu" aria-label="工作台">
          {LAUNCHER_TILES.map(tile => (
            <button
              key={tile.id}
              type="button"
              className={css.abPLaunchTile}
              role="menuitem"
              disabled={!tile.ready}
              data-active={
                (tile.id === 'tasks' && taskNote.open)
                || (tile.id === 'dag' && dagNote.open)
                || undefined
              }
              onClick={() => {
                if (tile.id === 'tasks' || tile.id === 'dag') openFeature(tile.id)
              }}
            >
              <span className={css.abPLaunchMark}>{tile.mark}</span>
              {tile.label}
            </button>
          ))}
        </div>
      )}

      {taskNote.open && (
        <div
          className={css.abPNote}
          data-pinned={taskNote.geom.pinned || undefined}
          data-front={front === 'tasks' || undefined}
          style={{ left: taskNote.geom.x, top: taskNote.geom.y, width: taskNote.geom.w, height: taskNote.geom.h }}
          onPointerDown={() => setFront('tasks')}
        >
          <div
            className={css.abPNoteBar}
            onPointerDown={taskNote.onDragDown}
            onPointerMove={taskNote.onDragMove}
            onPointerUp={taskNote.onDragUp}
            onPointerCancel={taskNote.onDragUp}
          >
            <span className={css.abPNoteTitle}>任务</span>
            <button
              type="button"
              className={`${css.abPClose} ${css.abPNotePin}`}
              data-on={taskNote.geom.pinned || undefined}
              aria-pressed={taskNote.geom.pinned}
              aria-label={taskNote.geom.pinned ? '取消钉选' : '钉选窗口'}
              onClick={() => taskNote.persist({ ...taskNote.geomRef.current, pinned: !taskNote.geomRef.current.pinned })}
            >
              钉
            </button>
            <button
              type="button"
              className={css.abPClose}
              aria-label="关闭任务窗口"
              onClick={closeTaskNote}
            >
              <IconCloseOutline16 size={16} />
            </button>
          </div>
          <div className={css.abPNoteBody}>
      <aside className={css.abPDrawer}>
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
        </div>
        <div className={css.abPBody}>
          <nav
            className={css.abPSessions}
            aria-label="会话"
            style={{ width: sidebarWidth }}
          >
            <div
              className={css.abPResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="调节侧栏宽度"
              onPointerDown={onSidebarResizeDown}
              onPointerMove={onSidebarResizeMove}
              onPointerUp={onSidebarResizeUp}
              onPointerCancel={onSidebarResizeUp}
            />
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
                {activeSessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    className={css.abPSession}
                    data-active={!archiveMode && sessionFilter === session.id || undefined}
                    data-current={session.id === currentSessionId || undefined}
                    onClick={() => toggleSession(session.id)}
                  >
                    <span className={css.abPLive} data-on={session.live || undefined} />
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
                  {archivedSessions.length > 0 && (
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
                        <span>归档 {archivedSessions.length}</span>
                        <IconChevronDownOutline14 size={14} />
                      </button>
                      {offlineOpen && archivedSessions.map(session => (
                        <button
                          key={session.id}
                          type="button"
                          className={css.abPSession}
                          data-active={archiveMode && sessionFilter === session.id || undefined}
                          data-current={session.id === currentSessionId || undefined}
                          onClick={() => toggleArchiveAgent(session.id)}
                        >
                          <span className={css.abPLive} data-on={session.live || undefined} />
                          <span className={css.abPSessionText}>
                            <span className={css.abPSessionTitle}>{session.title}</span>
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
          </div>
          <div
            className={css.abPNoteGrip}
            aria-label="缩放窗口"
            onPointerDown={taskNote.onResizeDown}
            onPointerMove={taskNote.onResizeMove}
            onPointerUp={taskNote.onResizeUp}
            onPointerCancel={taskNote.onResizeUp}
          />
        </div>
      )}
      {dagNote.open && (
        <div
          className={css.abPNote}
          data-pinned={dagNote.geom.pinned || undefined}
          data-front={front === 'dag' || undefined}
          style={{ left: dagNote.geom.x, top: dagNote.geom.y, width: dagNote.geom.w, height: dagNote.geom.h }}
          onPointerDown={() => setFront('dag')}
        >
          <div
            className={css.abPNoteBar}
            onPointerDown={dagNote.onDragDown}
            onPointerMove={dagNote.onDragMove}
            onPointerUp={dagNote.onDragUp}
            onPointerCancel={dagNote.onDragUp}
          >
            <span className={css.abPNoteTitle}>流程</span>
            <button
              type="button"
              className={`${css.abPClose} ${css.abPNotePin}`}
              data-on={dagNote.geom.pinned || undefined}
              aria-pressed={dagNote.geom.pinned}
              aria-label={dagNote.geom.pinned ? '取消钉选' : '钉选窗口'}
              onClick={() => dagNote.persist({ ...dagNote.geomRef.current, pinned: !dagNote.geomRef.current.pinned })}
            >
              钉
            </button>
            <button
              type="button"
              className={css.abPClose}
              aria-label="关闭流程窗口"
              onClick={closeDagNote}
            >
              <IconCloseOutline16 size={16} />
            </button>
          </div>
          <div className={css.abPNoteBody}>
            <aside className={css.abPDrawer}>
              <div className={css.abPTop}>
                <div className={css.abPWs}>
                  <button
                    type="button"
                    className={css.abPWsBtn}
                    aria-haspopup="listbox"
                    aria-expanded={dagWsMenu}
                    onClick={() => setDagWsMenu(value => !value)}
                  >
                    <span className={css.abPWsTitle}>{wsTitle}</span>
                    <span className={css.abPWsChevron}>
                      <IconChevronDownOutline14 size={14} />
                    </span>
                  </button>
                  {dagWsMenu && snapshot.workspaces.length > 0 && (
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
              </div>
              <DagView
                tasks={workspaceTasks}
                flows={workspaceFlows}
                selectedFlowId={selectedFlowId}
                onSelectFlow={id => {
                  setStoredFlow(id)
                  try {
                    localStorage.setItem(FLOW_KEY, id)
                  } catch {
                    /* private mode */
                  }
                }}
                sidebarWidth={sidebarWidth}
                onSidebarResizeDown={onSidebarResizeDown}
                onSidebarResizeMove={onSidebarResizeMove}
                onSidebarResizeUp={onSidebarResizeUp}
                nowMs={nowMs}
                consumeEscRef={dagEscRef}
              />
            </aside>
          </div>
          <div
            className={css.abPNoteGrip}
            aria-label="缩放窗口"
            onPointerDown={dagNote.onResizeDown}
            onPointerMove={dagNote.onResizeMove}
            onPointerUp={dagNote.onResizeUp}
            onPointerCancel={dagNote.onResizeUp}
          />
        </div>
      )}
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
const PANEL_CSS = "/* v1.1 task panel. Class prefix abP* stays clear of the host. Colors are\n   --dsw-alias-* tokens only; motion stays ≤150ms. */\n\n\n\n.abPRoot {\n  position: contents;\n  font-family: var(--dsw-font-family);\n  color: var(--dsw-alias-label-primary);\n  line-height: 1.45;\n}\n\n.abPCapsule {\n  position: fixed;\n  top: 50%;\n  right: 0;\n  z-index: 40;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  width: 48px;\n  min-height: 84px;\n  padding: 14px 6px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-right: none;\n  border-radius: 12px 0 0 12px;\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 90%, transparent);\n  color: var(--dsw-alias-label-primary);\n  box-shadow: -6px 0 20px var(--dsw-alias-bg-mask-2);\n  backdrop-filter: blur(12px);\n  cursor: pointer;\n  transform: translateY(-50%);\n  transition: transform 150ms var(--ds-ease-in-out, ease);\n}\n\n.abPCapsule:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 2px;\n}\n\n.abPCapsule[data-open] {\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n.abPCapsuleCount {\n  font-size: 22px;\n  font-weight: 600;\n  line-height: 28px;\n  font-variant-numeric: tabular-nums;\n  letter-spacing: -0.03em;\n}\n\n.abPCapsuleMeta {\n  font-size: 11px;\n  line-height: 14px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPCapsuleDot {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  background: var(--dsw-alias-label-tertiary);\n  opacity: 0.65;\n}\n\n.abPCapsule[data-loading] .abPCapsuleDot,\n.abPCapsule[data-loading] .abPCapsuleCount {\n  animation: abPPulse 1.2s var(--ds-ease-in-out, ease) infinite;\n}\n\n.abPPreview {\n  position: fixed;\n  top: 50%;\n  right: 58px;\n  z-index: 41;\n  width: 280px;\n  padding: 14px 16px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 94%, transparent);\n  box-shadow: -8px 6px 24px var(--dsw-alias-bg-mask-2);\n  backdrop-filter: blur(12px);\n  transform: translateY(-50%);\n  pointer-events: none;\n}\n\nhtml[data-agent-bus-panel-open] .abPPreview {\n  display: none;\n}\n\n.abPPreviewHead {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  margin-bottom: 12px;\n  padding-bottom: 10px;\n  border-bottom: 1px solid var(--dsw-alias-border-l1);\n}\n\n.abPPreviewWs {\n  font-size: 13px;\n  font-weight: 600;\n  line-height: 20px;\n  color: var(--dsw-alias-label-primary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.abPPreviewStats {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPPreviewList {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n}\n\n.abPPreviewRow {\n  display: grid;\n  grid-template-columns: 8px minmax(0, 1fr);\n  gap: 10px;\n  align-items: start;\n}\n\n.abPPreviewTo {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPPreviewText {\n  font-size: 13px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-primary);\n  overflow: hidden;\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n}\n\n.abPPreviewEmpty {\n  font-size: 13px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPLauncher {\n  position: fixed;\n  right: 60px;\n  top: 50%;\n  z-index: 45;\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 8px;\n  width: 228px;\n  padding: 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 16px;\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent);\n  box-shadow: -8px 8px 28px var(--dsw-alias-bg-mask-2);\n  backdrop-filter: blur(14px);\n  transform: translateY(-50%);\n}\n\n.abPLaunchTile {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 4px;\n  aspect-ratio: 1;\n  padding: 6px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: var(--dsw-alias-bg-layer-2);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  line-height: 16px;\n  cursor: pointer;\n}\n\n.abPLaunchTile:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPLaunchTile[data-active] {\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n.abPLaunchTile:disabled {\n  opacity: 0.38;\n  cursor: default;\n}\n\n.abPLaunchMark {\n  font-size: 16px;\n  font-weight: 600;\n  line-height: 22px;\n  color: var(--dsw-alias-state-business-primary);\n}\n\n.abPNote {\n  position: fixed;\n  z-index: 48;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  min-width: 360px;\n  min-height: 320px;\n  overflow: hidden;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 94%, transparent);\n  box-shadow: 0 16px 40px var(--dsw-alias-bg-mask-2);\n  backdrop-filter: blur(12px);\n  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);\n  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);\n}\n\n.abPNote[data-pinned] {\n  z-index: 49;\n  box-shadow: 0 18px 44px var(--dsw-alias-bg-mask-1);\n}\n\n.abPNote[data-front] {\n  z-index: 50;\n}\n\n.abPNoteBar {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex: none;\n  min-height: 36px;\n  padding: 4px 8px 4px 12px;\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\n  cursor: grab;\n  user-select: none;\n  touch-action: none;\n}\n\n.abPNoteBar:active {\n  cursor: grabbing;\n}\n\n.abPNoteTitle {\n  min-width: 0;\n  flex: 1;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 13px;\n  font-weight: 600;\n  line-height: 20px;\n}\n\n.abPNotePin[data-on] {\n  color: var(--dsw-alias-state-business-primary);\n}\n\n.abPNoteBody {\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  flex: 1;\n}\n\n.abPNoteGrip {\n  position: absolute;\n  right: 2px;\n  bottom: 2px;\n  width: 14px;\n  height: 14px;\n  cursor: nwse-resize;\n  touch-action: none;\n  background:\n    linear-gradient(\n      135deg,\n      transparent 50%,\n      var(--dsw-alias-label-tertiary) 50%,\n      var(--dsw-alias-label-tertiary) 60%,\n      transparent 60%,\n      transparent 75%,\n      var(--dsw-alias-label-tertiary) 75%\n    );\n}\n\n.abPDrawer {\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  flex: 1;\n}\n\n.abPTop {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex: none;\n  min-height: 56px;\n  padding: 10px 12px 10px 14px;\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.abPWs {\n  position: relative;\n  min-width: 0;\n  flex: 1;\n}\n\n.abPWsBtn {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  width: 100%;\n  min-height: 36px;\n  padding: 6px 10px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-2);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPWsBtn:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPWsBtn:focus-visible,\n.abPClose:focus-visible,\n.abPSession:focus-visible,\n.abPTask:focus-visible,\n.abPDagNode:focus-visible,\n.abPDagTool:focus-visible,\n.abPFlow:focus-visible,\n.abPWsItem:focus-visible,\n.abPAllBtn:focus-visible,\n.abPAllToggle:focus-visible,\n.abPOfflineToggle:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 1px;\n}\n\n.abPWsTitle {\n  min-width: 0;\n  flex: 1;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 14px;\n  font-weight: 600;\n  line-height: 22px;\n}\n\n.abPWsChevron {\n  flex: none;\n  display: inline-flex;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPWsMenu {\n  position: absolute;\n  top: calc(100% + 6px);\n  left: 0;\n  right: 0;\n  z-index: 3;\n  max-height: 280px;\n  overflow: auto;\n  padding: 6px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-1);\n  box-shadow: 0 10px 24px var(--dsw-alias-bg-mask-2);\n}\n\n.abPWsItem {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  width: 100%;\n  padding: 8px 10px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: inherit;\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPWsItem:hover,\n.abPWsItem[data-active] {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPWsItemPath {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.abPClose {\n  flex: none;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 32px;\n  height: 32px;\n  padding: 0;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n}\n\n.abPClose:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.abPBody {\n  display: flex;\n  min-height: 0;\n  flex: 1;\n}\n\n.abPSessions {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  flex: none;\n  width: 160px;\n  min-width: 128px;\n  max-width: 280px;\n  padding: 10px 8px;\n  overflow: auto;\n  border-right: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-module-platform));\n}\n\n.abPResize {\n  position: absolute;\n  top: 0;\n  right: -3px;\n  z-index: 3;\n  width: 6px;\n  height: 100%;\n  cursor: col-resize;\n  touch-action: none;\n}\n\n.abPResize:hover,\n.abPResize:active {\n  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent);\n}\n\n.abPGroup {\n  display: flex;\n  flex-direction: column;\n  margin-top: 10px;\n  padding-top: 10px;\n  border-top: 1px solid var(--dsw-alias-border-l2);\n}\n\n.abPAll {\n  display: flex;\n  align-items: stretch;\n  gap: 2px;\n  margin-bottom: 6px;\n}\n\n.abPAllBtn {\n  display: flex;\n  align-items: center;\n  min-width: 0;\n  flex: 1;\n  min-height: 34px;\n  padding: 6px 8px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 13px;\n  font-weight: 600;\n  line-height: 20px;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPAllBtn:hover,\n.abPAllToggle:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPAllBtn[data-active],\n.abPSession[data-active] {\n  background: var(--dsw-alias-button-ghost-active-fill);\n}\n\n.abPAllToggle {\n  flex: none;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  cursor: pointer;\n}\n\n.abPAllToggle[data-open] {\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPAllToggle[data-open] svg {\n  transform: rotate(180deg);\n}\n\n.abPAllToggle svg {\n  transition: transform 150ms var(--ds-ease-in-out, ease);\n}\n\n.abPSessionList {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.abPSession {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  width: 100%;\n  min-height: 34px;\n  padding: 6px 8px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 13px;\n  line-height: 20px;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPSession:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPSession[data-current] .abPSessionTitle {\n  font-weight: 600;\n}\n\n.abPSessionText {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  min-width: 0;\n  flex: 1;\n}\n\n.abPSessionTitle {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.abPOffline {\n  font-size: 11px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPOfflineToggle {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 6px;\n  width: 100%;\n  min-height: 30px;\n  margin-top: 4px;\n  padding: 4px 8px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  font: inherit;\n  font-size: 12px;\n  line-height: 18px;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPOfflineToggle:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPOfflineToggle svg {\n  flex: none;\n  transition: transform 150ms var(--ds-ease-in-out, ease);\n}\n\n.abPOfflineToggle[data-open] svg {\n  transform: rotate(180deg);\n}\n\n.abPLive {\n  flex: none;\n  width: 7px;\n  height: 7px;\n  margin-top: 6px;\n  border-radius: 50%;\n  background: var(--dsw-alias-label-tertiary);\n}\n\n.abPLive[data-on] {\n  background: var(--dsw-alias-state-success-primary);\n}\n\n.abPFlowHead {\n  padding: 2px 8px 6px;\n  font-size: 11px;\n  font-weight: 600;\n  line-height: 16px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPFlowList {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.abPFlowEmpty {\n  padding: 4px 8px 8px;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPFlow {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  width: 100%;\n  min-height: 36px;\n  padding: 6px 8px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: inherit;\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPFlow:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPFlow[data-active] {\n  background: var(--dsw-alias-button-ghost-active-fill);\n}\n\n.abPFlowName {\n  min-width: 0;\n  flex: 1;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 13px;\n  line-height: 20px;\n}\n\n.abPFlow[data-archived] .abPFlowName {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPFlowCount {\n  flex: none;\n  min-width: 20px;\n  padding: 0 6px;\n  border-radius: 999px;\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-secondary);\n  font-size: 11px;\n  line-height: 18px;\n  font-variant-numeric: tabular-nums;\n  text-align: center;\n}\n\n.abPFlow[data-active] .abPFlowCount {\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.abPMain {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  min-width: 0;\n  flex: 1;\n  padding: 12px;\n  overflow: auto;\n}\n\n.abPEmpty {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  min-height: 160px;\n  padding: 24px 16px;\n  text-align: center;\n}\n\n.abPEmptyTitle {\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPEmptyHint {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPTask {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  width: 100%;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-2);\n  color: inherit;\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n}\n\n.abPTask:hover,\n.abPTask[data-focused] {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPTask[data-focused],\n.abPTask[data-current] {\n  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-border-l2));\n}\n\n.abPTaskSummary {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  min-width: 0;\n}\n\n.abPTaskLine {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n.abPTaskPreview {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 14px;\n  line-height: 22px;\n}\n\n.abPTaskMeta {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.abPDot {\n  width: 8px;\n  height: 8px;\n  margin-top: 7px;\n  border-radius: 50%;\n  background: var(--dsw-alias-label-tertiary);\n}\n\n.abPDot[data-tone='business'] { background: var(--dsw-alias-state-business-primary); }\n.abPDot[data-tone='warning'] { background: var(--dsw-alias-state-warn-primary); }\n.abPDot[data-tone='success'] { background: var(--dsw-alias-state-success-primary); }\n.abPDot[data-tone='danger'] { background: var(--dsw-alias-state-error-primary); }\n.abPDot[data-tone='tertiary'] { background: var(--dsw-alias-label-tertiary); }\n\n.abPBadge {\n  flex: none;\n  padding: 0 7px;\n  border: 1px solid transparent;\n  border-radius: 5px;\n  font-size: 12px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPBadge[data-tone='business'] {\n  color: var(--dsw-alias-state-business-primary);\n  background: var(--dsw-alias-state-business-tertiary);\n}\n\n.abPBadge[data-tone='warning'] {\n  color: var(--dsw-alias-state-warn-label);\n  background: var(--dsw-alias-state-warn-tertiary);\n}\n\n.abPBadge[data-tone='success'] {\n  color: var(--dsw-alias-state-success-primary);\n  background: var(--dsw-alias-state-success-tertiary);\n}\n\n.abPBadge[data-tone='danger'] {\n  color: var(--dsw-alias-state-error-primary);\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n}\n\n.abPBadge[data-kind='dashed'] {\n  border-color: var(--dsw-alias-state-warn-primary);\n  border-style: dashed;\n  background: transparent;\n}\n\n.abPBadge[data-kind='outline'] {\n  border-color: var(--dsw-alias-border-l3);\n  background: transparent;\n}\n\n.abPFloat {\n  position: fixed;\n  z-index: 50;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  max-height: min(72vh, 560px);\n  overflow: auto;\n  padding: 14px 16px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 14px;\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent);\n  box-shadow: 0 18px 40px var(--dsw-alias-bg-mask-2);\n  backdrop-filter: blur(14px);\n  pointer-events: auto;\n}\n\n.abPFloatTop {\n  display: grid;\n  grid-template-columns: 8px minmax(0, 1fr) auto;\n  gap: 10px;\n  align-items: start;\n}\n\n.abPFloatTitle {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 14px;\n  line-height: 22px;\n}\n\n.abPChainArrow {\n  margin: 0 6px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPCalls {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n}\n\n.abPCall {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-2);\n}\n\n.abPCallHead {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: baseline;\n  gap: 2px 0;\n}\n\n.abPCallWho {\n  font-size: 14px;\n  font-weight: 600;\n  line-height: 22px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.abPCallRoles {\n  margin-left: 8px;\n  font-size: 11px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPCallSummary {\n  font-size: 13px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-secondary);\n  overflow-wrap: anywhere;\n}\n\n.abPCallCost {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.abPCallCostName {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.abPContent {\n  max-height: 240px;\n  margin: 0;\n  padding: 10px 12px;\n  overflow: auto;\n  border-radius: 8px;\n  background: var(--dsw-alias-markdown-code-block);\n  color: var(--dsw-alias-label-secondary);\n  font-family: var(--ds-font-family-code);\n  font-size: 12px;\n  line-height: 20px;\n  white-space: pre-wrap;\n  word-break: break-word;\n}\n\n.abPZone {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPZone[data-missing] {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.abPStaff {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding-top: 8px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n}\n\n.abPStaffHead {\n  font-size: 13px;\n  font-weight: 600;\n  line-height: 20px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.abPStaffRow {\n  display: grid;\n  grid-template-columns: 2em minmax(3em, 1fr);\n  gap: 4px 10px;\n  align-items: baseline;\n  padding: 8px 0 0;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n  font-size: 13px;\n  line-height: 20px;\n}\n\n.abPRole {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPStaffTitle {\n  min-width: 2em;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  color: var(--dsw-alias-label-primary);\n}\n\n.abPTriple {\n  grid-column: 1 / -1;\n  display: flex;\n  flex-wrap: wrap;\n  gap: 6px 14px;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n  font-variant-numeric: tabular-nums;\n}\n\n@keyframes abPPulse {\n  50% { opacity: 0.4; }\n}\n\n@keyframes abPRelease {\n  0%,\n  100% { box-shadow: 0 0 0 0 transparent; }\n  25%,\n  70% { box-shadow: 0 0 0 2px var(--dsw-alias-state-success-primary); }\n}\n\n.abPDagPane {\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  min-height: 0;\n  flex: 1;\n}\n\n.abPDagCanvas {\n  position: relative;\n  min-width: 0;\n  min-height: 72px;\n  flex: 1 1 42%;\n  overflow: hidden;\n  cursor: grab;\n  touch-action: none;\n  overscroll-behavior: none;\n  user-select: none;\n  background-color: var(--dsw-alias-bg-layer-1);\n  background-image: radial-gradient(circle, var(--dsw-alias-border-l2) 1px, transparent 1.2px);\n}\n\n.abPDagCanvas[data-panning],\n.abPDagCanvas[data-dragging] {\n  cursor: grabbing;\n}\n\n.abPDagWorld {\n  position: absolute;\n  left: 0;\n  top: 0;\n  transform-origin: 0 0;\n  will-change: transform;\n}\n\n.abPDagSvg {\n  position: absolute;\n  display: block;\n  overflow: visible;\n  color: var(--dsw-alias-label-tertiary);\n  pointer-events: none;\n}\n\n.abPDagTools {\n  position: absolute;\n  right: 10px;\n  top: 10px;\n  z-index: 2;\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  padding: 4px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent);\n  backdrop-filter: blur(10px);\n}\n\n.abPDagTool {\n  min-width: 28px;\n  height: 28px;\n  padding: 0 8px;\n  border: none;\n  border-radius: 7px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  line-height: 18px;\n  cursor: pointer;\n}\n\n.abPDagTool:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPDagZoom {\n  min-width: 40px;\n  padding: 0 4px;\n  font-size: 11px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-tertiary);\n  font-variant-numeric: tabular-nums;\n  text-align: center;\n}\n\n.abPDagEdge {\n  fill: none;\n  stroke: var(--dsw-alias-border-l3);\n  stroke-width: 1.5;\n  transition: stroke 150ms var(--ds-ease-in-out, ease), opacity 150ms var(--ds-ease-in-out, ease);\n}\n\n.abPDagEdge[data-tone='ok'] {\n  stroke: var(--dsw-alias-state-success-primary);\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.abPDagEdge[data-tone='wait'] {\n  stroke: var(--dsw-alias-state-warn-primary);\n  color: var(--dsw-alias-state-warn-primary);\n}\n\n.abPDagEdge[data-tone='fail'] {\n  stroke: var(--dsw-alias-state-error-primary);\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.abPDagEdge[data-tone='self'],\n.abPDagEdge[data-tone='down'] {\n  stroke: var(--dsw-alias-state-business-primary);\n  color: var(--dsw-alias-state-business-primary);\n}\n\n.abPDagEdge[data-dim] {\n  opacity: 0.22;\n}\n\n.abPDagNode {\n  position: absolute;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  justify-content: center;\n  gap: 2px;\n  height: 64px;\n  padding: 6px 8px;\n  overflow: hidden;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-2);\n  color: inherit;\n  font: inherit;\n  text-align: left;\n  cursor: grab;\n  touch-action: none;\n  transition:\n    border-color 150ms var(--ds-ease-in-out, ease),\n    box-shadow 150ms var(--ds-ease-in-out, ease),\n    opacity 150ms var(--ds-ease-in-out, ease);\n}\n\n.abPDagNode:hover,\n.abPDagNode[data-chain='self'] {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.abPDagNode[data-ready] {\n  border-style: dashed;\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n.abPDagNode[data-blocked] {\n  border-color: var(--dsw-alias-state-warn-primary);\n}\n\n.abPDagNode[data-fail] {\n  border-color: var(--dsw-alias-state-error-primary);\n}\n\n.abPDagNode[data-ok] {\n  border-color: var(--dsw-alias-state-success-primary);\n}\n\n.abPDagNode[data-chain='self'] {\n  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent);\n}\n\n.abPDagNode[data-flare] {\n  animation: abPRelease 2s var(--ds-ease-in-out, ease);\n}\n\n.abPDagNode[data-dragging] {\n  z-index: 2;\n  cursor: grabbing;\n}\n\n.abPDagNode[data-archived] {\n  opacity: 0.55;\n  cursor: default;\n  pointer-events: none;\n}\n\n.abPDagNode[data-dim] {\n  opacity: 0.4;\n}\n\n.abPDagNode[data-archived][data-dim] {\n  opacity: 0.4;\n}\n\n.abPDagNode[data-current] {\n  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, var(--dsw-alias-border-l2));\n}\n\n.abPDagNodeTop {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  min-width: 0;\n  overflow: hidden;\n}\n\n.abPDagNode .abPDot {\n  margin-top: 0;\n  flex: none;\n}\n\n.abPDagNode .abPBadge {\n  padding: 0 5px;\n  font-size: 11px;\n  line-height: 18px;\n}\n\n.abPDagMark {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 11px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.abPDagNode[data-fail] .abPDagMark {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.abPDagNodeLabel {\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 12px;\n  line-height: 18px;\n}\n\n.abPDagDetail {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  min-height: 0;\n  flex: 1 1 58%;\n  max-height: 70%;\n  overflow: hidden;\n  padding: 10px 12px 12px;\n  border-top: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.abPReq {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  min-height: 6.5em;\n  flex: 1 1 auto;\n  overflow: auto;\n}\n\n.abPReq .abPContent {\n  min-height: 3.5em;\n  max-height: none;\n}\n\n.abPDagMore {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  flex: 0 1 auto;\n  min-height: 0;\n  max-height: 38%;\n  overflow: auto;\n}\n\n.abPDagDetail .abPContent,\n.abPFloat .abPContent {\n  max-height: none;\n}\n\n.abPDagFail {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-state-error-primary);\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .abPCapsule,\n  .abPDrawer,\n  .abPAllToggle svg,\n  .abPOfflineToggle svg,\n  .abPDagEdge,\n  .abPDagNode,\n  .abPCapsule[data-loading] .abPCapsuleDot,\n  .abPCapsule[data-loading] .abPCapsuleCount,\n  .abPDagNode[data-flare] {\n    transition: none;\n    animation: none;\n  }\n}\n"
