import { useEffect, useRef, useState } from 'react'
import type { JobStatus } from './types'
import { triggerDownload } from './JobView'

/**
 * Shared active-job store, instantiated ONCE at the App level so the job and its
 * SSE subscription survive tab component mount/unmount.
 *
 * Previously each tab owned its own `useState<JobStatus>` + `useJobSubscription`,
 * which were destroyed on unmount - switching tabs made an in-flight download
 * vanish from the UI (the backend kept running it). Lifting the state to App
 * means the `EventSource` (in a ref) and the `job` snapshot persist across tab
 * switches.
 *
 * There is a single active job at a time; `ownerTab` records which tab started it
 * so a tab only renders the job it owns.
 */

export type OwnerTab = 'youtube' | 'http' | 'bt'

export function useActiveJob() {
  const [job, setJob] = useState<JobStatus | null>(null)
  const [ownerTab, setOwnerTab] = useState<OwnerTab | null>(null)
  const esRef = useRef<EventSource | null>(null)
  // job_id we have already auto-downloaded, so a restored `done` job does not
  // trigger a second (non-gesture) browser download.
  const autoTriggeredRef = useRef<string | null>(null)

  // Close the stream when App unmounts (in practice: never, while the page lives).
  useEffect(() => () => esRef.current?.close(), [])

  function subscribe(jobId: string) {
    esRef.current?.close()
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    esRef.current = es
    es.onmessage = (ev) => {
      const j = JSON.parse(ev.data) as JobStatus
      setJob(j)
      // Auto-download only a single-file job, once, on the original Start
      // gesture's tick. Guarded by autoTriggeredRef so a job restored after it
      // finished (stream already closed) never re-triggers.
      if (j.status === 'done' && autoTriggeredRef.current !== jobId) {
        const urls = j.download_urls?.length ? j.download_urls : (j.download_url ? [j.download_url] : [])
        if (urls.length === 1) {
          autoTriggeredRef.current = jobId
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
    esRef.current?.close()
    autoTriggeredRef.current = null
    setOwnerTab(owner)
    setJob(initial)
    try {
      const jobId = await starter()
      setJob({ ...initial, id: jobId })
      subscribe(jobId)
    } catch (err) {
      // Leave it to the caller's catch; clear our partial job.
      setJob(null)
      setOwnerTab(null)
      throw err
    }
  }

  function reset() {
    esRef.current?.close()
    esRef.current = null
    autoTriggeredRef.current = null
    setJob(null)
    setOwnerTab(null)
  }

  /** The active job iff it was started by `tab`; otherwise null. */
  function jobFor(tab: OwnerTab): JobStatus | null {
    return ownerTab === tab ? job : null
  }

  return { jobFor, start, reset }
}
