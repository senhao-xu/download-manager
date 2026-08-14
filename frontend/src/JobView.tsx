import { useLang } from './i18n'
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
        <span>{job.status === 'done' ? t('done') : job.status === 'error' ? t('failed') : `${pct.toFixed(0)}%`}</span>
        <span className="job-phase">{job.phase}</span>
      </div>
      {job.status === 'error' && job.error && <div className="error">{job.error}</div>}
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
