import { useEffect, useRef, useState } from 'react'
import type { JobStatus } from './types'
import { triggerDownload } from './JobView'

/**
 * Shared active-job store, instantiated ONCE at the App level so each tab's job
 * and its SSE subscription survive tab component mount/unmount.
 *
 * Each tab owns an independent job + EventSource tracked by tab key, so starting
 * a download in one tab never disturbs a download running in another. The job
 * snapshots live in React state (so they re-render) and the `EventSource`s live
 * in a ref (mutated, not rendered); both are at the App level, so a tab that
 * unmounts while its download runs keeps progressing in the background, and the
 * job is still there when the user switches back.
 *
 * `reset` is tab-scoped: it clears only the calling tab's job/stream, so the
 * "clear my previous job before starting a new one" pattern in each tab no
 * longer clobbers downloads running on other tabs.
 */

export type OwnerTab = 'youtube' | 'http' | 'bt'

type JobMap = Record<OwnerTab, JobStatus | null>
type EsMap = Record<OwnerTab, EventSource | null>
// Per-tab job_id we have already auto-downloaded, so a restored `done` job
// does not trigger a second (non-gesture) browser download.
type AutoTriggeredMap = Record<OwnerTab, string | null>

const EMPTY_JOBS: JobMap = { youtube: null, http: null, bt: null }
const EMPTY_ES: EsMap = { youtube: null, http: null, bt: null }

export function useActiveJob() {
  const [jobs, setJobs] = useState<JobMap>(EMPTY_JOBS)
  const esRef = useRef<EsMap>(EMPTY_ES)
  const autoTriggeredRef = useRef<AutoTriggeredMap>({ youtube: null, http: null, bt: null })

  // Close every stream when App unmounts (in practice: never, while the page lives).
  useEffect(
    () => () => {
      (Object.keys(esRef.current) as OwnerTab[]).forEach((t) => esRef.current[t]?.close())
    },
    [],
  )

  function setJobFor(tab: OwnerTab, j: JobStatus | null) {
    setJobs((prev) => ({ ...prev, [tab]: j }))
  }

  function subscribe(tab: OwnerTab, jobId: string) {
    esRef.current[tab]?.close()
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    esRef.current[tab] = es
    es.onmessage = (ev) => {
      const j = JSON.parse(ev.data) as JobStatus
      setJobFor(tab, j)
      // Auto-download only a single-file job, once, on the original Start
      // gesture's tick. Guarded per-tab by job_id so a job restored after it
      // finished (stream already closed) never re-triggers.
      if (j.status === 'done' && autoTriggeredRef.current[tab] !== jobId) {
        const urls = j.download_urls?.length ? j.download_urls : (j.download_url ? [j.download_url] : [])
        if (urls.length === 1) {
          autoTriggeredRef.current[tab] = jobId
          triggerDownload(urls[0])
        }
      }
      if (j.status === 'done' || j.status === 'error') es.close()
    }
    es.onerror = () => es.close()
  }

  /**
   * Called by a tab when the user clicks Start.
   *
   * `starter` performs the API call and returns a job_id; `initial` is the
   * queued JobStatus to show immediately (its `id` may be empty - `start`
   * patches the real id once the API responds). If `starter` throws, the job
   * is left cleared so the tab can show its own error.
   */
  async function start(
    owner: OwnerTab,
    starter: () => Promise<string>,
    initial: JobStatus,
  ): Promise<void> {
    esRef.current[owner]?.close()
    autoTriggeredRef.current[owner] = null
    setJobFor(owner, initial)
    try {
      const jobId = await starter()
      setJobFor(owner, { ...initial, id: jobId })
      subscribe(owner, jobId)
    } catch (err) {
      // Leave it to the caller's catch; clear our partial job.
      setJobFor(owner, null)
      throw err
    }
  }

  function reset(tab: OwnerTab) {
    esRef.current[tab]?.close()
    esRef.current[tab] = null
    autoTriggeredRef.current[tab] = null
    setJobFor(tab, null)
  }

  /** The active job for `tab`, or null if it has none. */
  function jobFor(tab: OwnerTab): JobStatus | null {
    return jobs[tab]
  }

  return { jobFor, start, reset }
}
