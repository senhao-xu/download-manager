import { useState } from 'react'
import { useLang } from './i18n'
import { cancelJob, pauseJob, resumeJob } from './api'
import type { JobStatus } from './types'

export function triggerDownload(url: string) {
  const a = document.createElement('a')
  a.href = url
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function downloadAll(urls: string[]) {
  // stagger so browsers don't drop concurrent downloads
  urls.forEach((u, i) => setTimeout(() => triggerDownload(u), i * 400))
}

/** Derive a MIME type from a file URL's extension (client-side, no new field). */
export function mimeFromUrl(url: string): string | null {
  const p = url.split('?')[0].split('#')[0].toLowerCase()
  if (p.endsWith('.mp4')) return 'video/mp4'
  if (p.endsWith('.webm')) return 'video/webm'
  if (p.endsWith('.mkv')) return 'video/x-matroska'
  if (p.endsWith('.mov')) return 'video/quicktime'
  if (p.endsWith('.mp3')) return 'audio/mpeg'
  if (p.endsWith('.m4a')) return 'audio/mp4'
  if (p.endsWith('.ogg')) return 'audio/ogg'
  if (p.endsWith('.opus')) return 'audio/opus'
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
  if (p.endsWith('.png')) return 'image/png'
  if (p.endsWith('.gif')) return 'image/gif'
  if (p.endsWith('.webp')) return 'image/webp'
  return null
}

export function JobView({ job }: { job: JobStatus }) {
  const { t } = useLang()
  const [busy, setBusy] = useState<string | null>(null)
  const pct = Math.max(0, Math.min(100, job.progress))
  const isBatch = job.total != null && job.total > 1
  const urls = job.download_urls?.length ? job.download_urls : (job.download_url ? [job.download_url] : [])

  const DownloadIcon = (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v10" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  )

  // In-progress control buttons. Cancel applies to every kind; pause/resume is
  // BT-only (libtorrent native pause holds peers and resumes from the partial
  // state). The API signals the worker; the next SSE snapshot carries the real
  // status transition back, so we just disable the clicked button until then.
  const isBt = job.kind === 'bt'
  const showPause = job.status === 'running' && isBt
  const showResume = job.status === 'paused'
  const showCancel = job.status === 'queued' || job.status === 'running' || job.status === 'paused'

  async function control(name: string, fn: () => Promise<void>) {
    if (busy) return
    setBusy(name)
    try {
      await fn()
    } catch {
      // Non-fatal: the SSE snapshot still reflects the real status. A stale
      // signal on an already-terminal job is harmless (request_* is idempotent).
    } finally {
      setBusy(null)
    }
  }

  const PauseIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  )
  const ResumeIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 5l12 7-12 7z" />
    </svg>
  )
  const XIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )

  const statusText =
    job.status === 'done' ? t('done')
    : job.status === 'error' ? t('failed')
    : job.status === 'paused' ? t('paused')
    : job.status === 'cancelled' ? t('cancelled')
    : `${pct.toFixed(0)}%`

  return (
    <div className={`card job ${job.status}`}>
      <div className="job-head">
        <span className="job-title">{job.title || (isBatch ? t('playlistDownload') : t('jobDownload'))}</span>
        {isBatch && job.current != null && <span className="job-count">{job.current + 1}/{job.total}</span>}
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="job-status-row">
        <span>{statusText}</span>
        <span className="job-phase">{job.phase}</span>
      </div>
      {job.status === 'error' && job.error && <div className="error">{job.error}</div>}
      {showCancel && (
        <div className="job-actions">
          {showResume && (
            <button onClick={() => control('resume', () => resumeJob(job.id))} disabled={!!busy}>
              {ResumeIcon}{t('resume')}
            </button>
          )}
          {showPause && (
            <button onClick={() => control('pause', () => pauseJob(job.id))} disabled={!!busy}>
              {PauseIcon}{t('pause')}
            </button>
          )}
          <button className="danger" onClick={() => control('cancel', () => cancelJob(job.id))} disabled={!!busy}>
            {XIcon}{t('cancelDownload')}
          </button>
        </div>
      )}
      {job.status === 'done' && urls.length > 0 && (
        <div className="job-actions">
          {urls.length > 1
            ? <button className="primary download-link" onClick={() => downloadAll(urls)}>{DownloadIcon}{t('downloadAll', { n: urls.length })}</button>
            : <a className="primary download-link" href={urls[0]}>{DownloadIcon}{t('downloadFile')}</a>}
        </div>
      )}
    </div>
  )
}
