import { useEffect, useRef, useState } from 'react'
import type { JobStatus, OwnerTab } from './types'
import { getJob, listActiveJobs } from './api'
import { triggerDownload } from './JobView'

/**
 * Multi-job store, instantiated ONCE at the App level.
 *
 * Every job the frontend knows about - whether started this session or restored
 * from the server after a reload - lives in a single `Map<id, JobStatus>`. Each
 * in-flight job owns one EventSource for live progress. Jobs are global (not
 * per-tab); a tab renders the subset whose `kind` matches.
 *
 * Key behaviors:
 *  - `start()` is called on a user gesture; the started job_id is recorded in
 *    `gestureRef` so its single-file result auto-downloads exactly once.
 *    Restored jobs are NOT in `gestureRef`, so they never auto-download (no
 *    gesture -> the browser would block it anyway).
 *  - `restore()` runs on mount: fetches all in-flight jobs and re-subscribes,
 *    so closing/reopening the page brings live progress back.
 *  - The per-job SSE reconnect/reconcile logic (with generation guard + backoff)
 *    survives a stream drop without stranding an in-flight download.
 *  - When a job goes terminal we bump `historyRefreshTick` (so HistoryList
 *    refetches and the completed item appears), then auto-dismiss the active row
 *    after a short delay once history has caught up.
 */

const MAX_RECONNECT_ATTEMPTS = 6

export function useJobs() {
  const [jobs, setJobs] = useState<Map<string, JobStatus>>(new Map())
  const [historyRefreshTick, setHistoryRefreshTick] = useState(0)

  const esRef = useRef<Map<string, EventSource>>(new Map())
  // job ids already auto-downloaded (one-shot, prevents re-trigger)
  const autoTriggeredRef = useRef<Set<string>>(new Set())
  // job ids started via a user gesture THIS session -> eligible for auto-download
  const gestureRef = useRef<Set<string>>(new Set())
  // per-job generation: bumped on (re)subscribe/dismiss so stale reconnects bail
  const genRef = useRef<Map<string, number>>(new Map())
  // StrictMode-safe restore guard
  const restoredRef = useRef(false)
  // pending auto-dismiss timers (jobId -> timeout)
  const dismissTimers = useRef<Map<string, number>>(new Map())
  // job ids that have already gone terminal this session (idempotent onTerminal)
  const terminalRef = useRef<Set<string>>(new Set())

  // Close every stream when App unmounts (in practice: never, while the page lives).
  useEffect(
    () => () => {
      esRef.current.forEach((es) => es.close())
      esRef.current.clear()
      dismissTimers.current.forEach((id) => clearTimeout(id))
      dismissTimers.current.clear()
    },
    [],
  )

  function setJob(j: JobStatus) {
    setJobs((prev) => {
      const next = new Map(prev)
      next.set(j.id, j)
      return next
    })
  }

  function removeJob(jobId: string) {
    setJobs((prev) => {
      if (!prev.has(jobId)) return prev
      const next = new Map(prev)
      next.delete(jobId)
      return next
    })
  }

  /** Apply a snapshot, including the one-shot auto-download for gesture jobs. */
  function applyJob(j: JobStatus) {
    setJob(j)
    if (
      j.status === 'done' &&
      !autoTriggeredRef.current.has(j.id) &&
      gestureRef.current.has(j.id)
    ) {
      const urls = j.download_urls?.length ? j.download_urls : (j.download_url ? [j.download_url] : [])
      if (urls.length === 1) {
        autoTriggeredRef.current.add(j.id)
        triggerDownload(urls[0])
      }
    }
  }

  function genOf(jobId: string): number {
    return genRef.current.get(jobId) ?? 0
  }

  /** When the SSE stream drops, reconcile via REST and resubscribe if still running. */
  function reconcile(jobId: string, gen: number, attempt: number) {
    if (genOf(jobId) !== gen) return // superseded
    getJob(jobId)
      .then((j) => {
        if (genOf(jobId) !== gen) return
        if (j.status === 'done' || j.status === 'error') {
          applyJob(j)
          return
        }
        if (attempt < MAX_RECONNECT_ATTEMPTS) {
          const backoff = Math.min(1000 * 2 ** attempt, 16000)
          window.setTimeout(() => {
            if (genOf(jobId) !== gen) return
            subscribe(jobId, gen, attempt + 1)
          }, backoff)
        }
      })
      .catch(() => {
        if (genOf(jobId) !== gen) return
        if (attempt < MAX_RECONNECT_ATTEMPTS) {
          const backoff = Math.min(1000 * 2 ** attempt, 16000)
          window.setTimeout(() => {
            if (genOf(jobId) !== gen) return
            reconcile(jobId, gen, attempt + 1)
          }, backoff)
        }
      })
  }

  function subscribe(jobId: string, gen?: number, reconnectAttempt = 0) {
    const g = gen ?? (genRef.current.get(jobId) ?? 0) + 1
    genRef.current.set(jobId, g)
    esRef.current.get(jobId)?.close()
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    esRef.current.set(jobId, es)
    es.onmessage = (ev) => {
      if (genOf(jobId) !== g) return
      const j = JSON.parse(ev.data) as JobStatus
      applyJob(j)
      if (j.status === 'done' || j.status === 'error') {
        es.close()
        if (!terminalRef.current.has(j.id)) {
          terminalRef.current.add(j.id)
          onTerminal(j.id)
        }
      }
    }
    es.onerror = () => {
      es.close()
      if (genOf(jobId) !== g) return
      reconcile(jobId, g, reconnectAttempt)
    }
  }

  /** On a job going terminal: refresh history now, auto-dismiss the row shortly. */
  function onTerminal(jobId: string) {
    setHistoryRefreshTick((n) => n + 1)
    // Give HistoryList time to refetch and show the completed row, then drop the
    // active row (dedup hides the history copy meanwhile, so no flicker).
    if (dismissTimers.current.has(jobId)) clearTimeout(dismissTimers.current.get(jobId)!)
    const id = window.setTimeout(() => {
      dismissTimers.current.delete(jobId)
      esRef.current.get(jobId)?.close()
      esRef.current.delete(jobId)
      // bump generation so any in-flight reconcile bails, then drop the row
      genRef.current.set(jobId, genOf(jobId) + 1)
      removeJob(jobId)
    }, 2500)
    dismissTimers.current.set(jobId, id)
  }

  /**
   * Called by a tab on a user gesture (Start). `initial.kind` must be set.
   * Awaits the API to get the real job_id, then tracks + subscribes.
   */
  async function start(
    starter: () => Promise<string>,
    initial: JobStatus,
  ): Promise<void> {
    try {
      const jobId = await starter()
      gestureRef.current.add(jobId)
      setJob({ ...initial, id: jobId })
      subscribe(jobId)
    } catch (err) {
      // Leave it to the caller's catch; nothing was added to the map.
      throw err
    }
  }

  /** Restore in-flight jobs on mount. Idempotent (StrictMode-safe). */
  async function restore() {
    if (restoredRef.current) return
    restoredRef.current = true
    try {
      const active = await listActiveJobs()
      for (const j of active) {
        setJob(j)
        subscribe(j.id) // NOT added to gestureRef -> no auto-download on restore
      }
    } catch {
      // Network/down: non-fatal; the user can still start new jobs.
      restoredRef.current = false
    }
  }

  /** Active jobs for `kind`, non-terminal first then by recency. */
  function jobsFor(kind: OwnerTab): JobStatus[] {
    const all = [...jobs.values()].filter((j) => j.kind === kind)
    return all.sort((a, b) => {
      const ta = a.status === 'queued' || a.status === 'running' ? 0 : 1
      const tb = b.status === 'queued' || b.status === 'running' ? 0 : 1
      if (ta !== tb) return ta - tb
      return 0 // preserve insertion (recency) order within the same group
    })
  }

  return { jobsFor, start, restore, historyRefreshTick }
}
