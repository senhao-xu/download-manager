import { useState } from 'react'
import { useLang } from './i18n'
import { cancelJob, pauseJob, resumeJob } from './api'
import type { JobStatus } from './types'
import { formatBytes, formatVideoDetails } from './format'
import { VideoCover } from './VideoCover'

function formatEta(seconds: number): string {
  const value = Math.max(0, Math.ceil(seconds))
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor(value / 60) % 60
  const secs = String(value % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`
}

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
  const videoDetails = formatVideoDetails(job.resolution, job.fps)
  const itemTotal = job.total ?? 1
  const isBatch = itemTotal > 1
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

  const phases: Record<string, string> = {
    queued: 'queued', starting: 'phaseStarting', downloading: 'phaseDownloading',
    'processing (merging)': 'phaseMerging', 'packaging zip': 'phasePackaging',
    'connecting to swarm': 'phaseConnecting', finishing: 'phaseFinishing',
    done: 'done', error: 'failed', paused: 'paused', cancelled: 'cancelled',
  }
  const phase = job.phase || job.status
  const phaseLabel = t(phases[phase] || (/^downloading \d+\/\d+$/.test(phase) ? 'phaseDownloading' : phase))
  const indeterminate = !isBatch && job.status === 'running' && job.total_bytes == null && pct === 0
  const currentItem = isBatch && job.status !== 'done'
  const downloading = job.status === 'running' && phase.startsWith('downloading')
  const speed = downloading && job.speed != null ? `${formatBytes(job.speed)}/s` : '—'
  const eta = downloading && job.eta != null && Number.isFinite(job.eta) ? formatEta(job.eta) : '—'

  return (
    <div className={`card job ${job.status}`}>
      <div className="job-head">
        <div className="job-title-group">
          {(job.thumbnail || job.thumbnail_candidates?.length) ? <VideoCover src={job.thumbnail ?? null} candidates={job.thumbnail_candidates} title={job.title} /> : null}
          <div className="job-heading">
            <span className="job-title" title={job.title || undefined}>{job.title || (isBatch ? t('playlistDownload') : t('jobDownload'))}</span>
            {videoDetails && <span className="job-video-details" title={t('videoResolution')}>{videoDetails}</span>}
          </div>
        </div>
        <strong className="job-percent">{indeterminate ? '—' : `${pct.toFixed(1).replace(/\.0$/, '')}%`}</strong>
      </div>
      <div className="job-status-row">
        <span>{phaseLabel}</span>
        {isBatch && job.current != null && <span className="job-count">{t(job.status === 'done' ? 'batchComplete' : 'currentFile', { n: Math.min(job.current + 1, itemTotal), total: itemTotal })}</span>}
      </div>
      <div className={`progress-track${indeterminate ? ' indeterminate' : ''}`} role="progressbar" aria-label={t(isBatch ? 'overallProgress' : 'downloadProgress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : pct}>
        <div className="progress-fill" style={{ width: indeterminate ? '35%' : `${pct}%` }} />
      </div>
      <dl className="job-metrics">
        <div><dt>{t(currentItem ? 'currentDownloaded' : 'downloadedSize')}</dt><dd>{formatBytes(job.downloaded_bytes ?? 0)}</dd></div>
        <div><dt>{t(currentItem ? 'currentTotalSize' : 'totalSize')}</dt><dd>{job.total_bytes == null ? t('unknownSize') : `${job.total_bytes_estimated ? t('approximately') : ''}${formatBytes(job.total_bytes)}`}</dd></div>
        <div><dt>{t('downloadSpeed')}</dt><dd>{speed}</dd></div>
        <div><dt>{t(currentItem ? 'currentEta' : 'remainingTime')}</dt><dd>{eta}</dd></div>
      </dl>
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
