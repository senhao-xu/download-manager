import { useState } from 'react'
import { useLang } from './i18n'
import type { JobStatus } from './types'
import { PreviewModal } from './PreviewModal'

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

/** Whether a URL points to a media file previewable in-page (image/video/audio). */
export function isPreviewable(url: string): boolean {
  const m = mimeFromUrl(url)
  return m?.startsWith('image/') === true
    || m?.startsWith('video/') === true
    || m?.startsWith('audio/') === true
}

export function JobView({ job }: { job: JobStatus }) {
  const { t } = useLang()
  const [showPreview, setShowPreview] = useState(false)
  const pct = Math.max(0, Math.min(100, job.progress))
  const isBatch = job.total != null && job.total > 1
  const urls = job.download_urls?.length ? job.download_urls : (job.download_url ? [job.download_url] : [])
  const previewUrl = urls[0]
  const canPreview = job.status === 'done' && !!previewUrl && isPreviewable(previewUrl)

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
          {canPreview && (
            <button className="primary play-btn" onClick={() => setShowPreview(true)}>
              ▶ {t('preview')}
            </button>
          )}
          {urls.length > 1
            ? <button className="primary download-link" onClick={() => downloadAll(urls)}>{t('downloadAll', { n: urls.length })}</button>
            : <a className="primary download-link" href={urls[0]}>{t('downloadFile')}</a>}
        </div>
      )}
      {showPreview && previewUrl && (
        <PreviewModal
          src={previewUrl}
          mime={mimeFromUrl(previewUrl)}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  )
}
