import { useEffect, useRef } from 'react'
import type { JobStatus } from './types'
import { triggerDownload } from './JobView'

/**
 * Shared EventSource subscription for download jobs.
 *
 * Both the YouTube and HTTP tabs subscribe to `/api/jobs/{id}/events` (SSE),
 * push each message into local `job` state, auto-trigger a single-file download
 * once on `done`, and close the stream on a terminal status. This hook owns the
 * `esRef`/`triggeredRef` refs + unmount cleanup so tabs don't duplicate them.
 *
 * @param onJob  receives each JobStatus snapshot from the stream.
 * @param opts   `{ autoDownload?: boolean }` - default true. When true and the
 *                job finishes with exactly one download URL, that file is
 *                auto-downloaded once (user-gesture from the Start click).
 */
export function useJobSubscription(
  onJob: (j: JobStatus) => void,
  opts: { autoDownload?: boolean } = {},
): { subscribe: (jobId: string) => void; reset: () => void } {
  const { autoDownload = true } = opts
  const esRef = useRef<EventSource | null>(null)
  const triggeredRef = useRef<string | null>(null)

  useEffect(() => () => esRef.current?.close(), [])

  function subscribe(jobId: string) {
    esRef.current?.close()
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    esRef.current = es
    es.onmessage = (ev) => {
      const j = JSON.parse(ev.data) as JobStatus
      onJob(j)
      if (autoDownload && j.status === 'done' && triggeredRef.current !== jobId) {
        triggeredRef.current = jobId
        const urls = j.download_urls?.length ? j.download_urls : (j.download_url ? [j.download_url] : [])
        // Auto-trigger only a single file; multiple are left to the
        // "Download all" button because browsers block auto multi-downloads.
        if (urls.length === 1) triggerDownload(urls[0])
      }
      if (j.status === 'done' || j.status === 'error') es.close()
    }
    es.onerror = () => es.close()
  }

  function reset() {
    esRef.current?.close()
    esRef.current = null
    triggeredRef.current = null
  }

  return { subscribe, reset }
}
