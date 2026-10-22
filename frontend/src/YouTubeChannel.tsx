import { useEffect, useState } from 'react'
import { fetchInfo, queueVideos } from './api'
import { useLang } from './i18n'
import type { Entry, InfoResponse, JobStatus, TabJobProps } from './types'
import { VideoCover } from './VideoCover'
import { VideoDownloadActions } from './VideoDownloadActions'

const MAX_SELECTED = 100

function videoId(source?: string | null): string | null {
  if (!source) return null
  try {
    const url = new URL(source)
    return url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).pop() || null
  } catch { return null }
}

function duration(seconds: number | null): string {
  if (seconds == null) return ''
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  const tail = `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
  return hours ? `${hours}:${tail.padStart(5, '0')}` : tail
}

export function YouTubeChannel({ url, initial, activeJobs, startJob }: {
  url: string
  initial: InfoResponse
  activeJobs: JobStatus[]
  startJob: TabJobProps['startJob']
}) {
  const { t } = useLang()
  const [info, setInfo] = useState(initial)
  const [selected, setSelected] = useState<Map<string, Entry>>(new Map())
  const [quality, setQuality] = useState('best')
  const [skipDownloaded, setSkipDownloaded] = useState(true)
  const [completed, setCompleted] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const page = info.page ?? 1
  const activeIds = new Set(activeJobs
    .filter(job => ['queued', 'running', 'paused'].includes(job.status))
    .map(job => videoId(job.source)))
  const downloaded = (entry: Entry) => !!entry.downloaded || completed.has(entry.id || '')
  const selectable = (entry: Entry) => !!entry.id && !!entry.url
    && !activeIds.has(entry.id) && !(skipDownloaded && downloaded(entry))
  const pageEntries = info.entries.filter(selectable)
  const allOnPage = pageEntries.length > 0 && pageEntries.every(entry => selected.has(entry.id!))

  useEffect(() => {
    const ids = activeJobs.filter(job => job.status === 'done').map(job => videoId(job.source)).filter((id): id is string => !!id)
    if (!ids.length) return
    setCompleted(previous => {
      const next = new Set([...previous, ...ids])
      return next.size === previous.size ? previous : next
    })
  }, [activeJobs])

  async function loadPage(next: number) {
    if (loading || adding) return
    setLoading(true)
    setError(null)
    try {
      const result = await fetchInfo(url, next, info.page_size ?? 20)
      if (!result.is_channel) throw new Error(t('channelLoadFailed'))
      setInfo(result)
    } catch (error) {
      setError(error instanceof Error ? error.message : t('fetchFailed'))
    } finally { setLoading(false) }
  }

  function toggle(entry: Entry) {
    if (!entry.id || !selectable(entry) || loading || adding) return
    const next = new Map(selected)
    if (next.has(entry.id)) next.delete(entry.id)
    else if (next.size < MAX_SELECTED) next.set(entry.id, entry)
    else { setError(t('channelSelectionLimit', { n: MAX_SELECTED })); return }
    setSelected(next)
  }

  function togglePage() {
    const next = new Map(selected)
    for (const entry of pageEntries) {
      if (allOnPage) next.delete(entry.id!)
      else if (next.size < MAX_SELECTED) next.set(entry.id!, entry)
    }
    setSelected(next)
  }

  async function downloadSelected() {
    if (loading || adding || !selected.size) return
    setAdding(true)
    setError(null)
    setMessage(null)
    try {
      const result = await queueVideos([...selected.values()].map(entry => ({ url: entry.url!, title: entry.title })), quality, skipDownloaded)
      await Promise.all(result.jobs.map(job => startJob(() => Promise.resolve(job.id), job)))
      setSelected(new Map())
      setMessage(t('channelQueued', { n: result.jobs.length, downloaded: result.skipped_downloaded, active: result.skipped_active }))
    } catch (error) {
      setError(error instanceof Error ? error.message : t('startFailed'))
    } finally { setAdding(false) }
  }

  return (
    <div className="card playlist channel">
      <div className="playlist-head">
        <div className="playlist-summary">
          <VideoCover src={info.thumbnail} candidates={info.thumbnail_candidates} title={info.title} />
          <div><h2>{info.title}</h2><div className="meta">{t('channelPage', { n: page, count: info.entries.length })}</div></div>
        </div>
      </div>
      <p className="channel-hint">{t('channelSelectionHint', { n: MAX_SELECTED })}</p>
      <div className="channel-toolbar">
        <label className="zip-check">
          <input type="checkbox" checked={skipDownloaded} disabled={loading || adding} onChange={event => {
            setSkipDownloaded(event.target.checked)
            if (event.target.checked) setSelected(new Map([...selected].filter(([, entry]) => !downloaded(entry))))
          }} />
          {t('skipDownloaded')}
        </label>
        <button type="button" className="link" disabled={loading || adding || !pageEntries.length} onClick={togglePage}>{t(allOnPage ? 'clearPage' : 'selectPage')}</button>
        {selected.size > 0 && <button type="button" className="link" disabled={loading || adding} onClick={() => setSelected(new Map())}>{t('clearSelection')}</button>}
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {message && <p className="channel-notice" role="status">{message}</p>}
      <ul className="entries channel-entries" aria-busy={loading}>
        {info.entries.map(entry => (
          <li key={entry.id}>
            <label>
              <input type="checkbox" checked={selected.has(entry.id!)} disabled={loading || adding || !selectable(entry)} onChange={() => toggle(entry)} />
              <VideoCover src={entry.thumbnail ?? null} candidates={entry.thumbnail_candidates} title={entry.title} />
              <div className="channel-entry-main">
                <span className="entry-title" title={entry.title || undefined}>{entry.title || entry.id}</span>
                <div className="channel-entry-meta">
                  <span>{duration(entry.duration)}</span>
                  {downloaded(entry) && <span className="badge ok">{t('alreadyDownloaded')}</span>}
                  {activeIds.has(entry.id) && <span className="badge">{t('alreadyQueued')}</span>}
                </div>
              </div>
            </label>
          </li>
        ))}
      </ul>
      {!info.entries.length && <p className="channel-hint">{t('channelEmpty')}</p>}
      <nav className="history-pager channel-pager" aria-label={t('channelPagination')}>
        <button type="button" disabled={loading || adding || page <= 1} onClick={() => void loadPage(page - 1)}>{t('prevPage')}</button>
        <span className="pager-info" role="status">{loading ? t('loading') : t('channelPageNumber', { n: page })}</span>
        <button type="button" disabled={loading || adding || !info.has_more} onClick={() => void loadPage(page + 1)}>{t('nextPage')}</button>
      </nav>
      <p className="channel-hint">{t('channelQualityHint')}</p>
      <VideoDownloadActions quality={quality} qualities={info.qualities} onQualityChange={setQuality} onDownload={downloadSelected} selectedCount={loading || adding ? 0 : selected.size} />
    </div>
  )
}
