import { useState } from 'react'
import type { InfoResponse, JobStatus, TabJobProps } from './types'
import { fetchInfo, startDownload, startBatch } from './api'
import { useLang } from './i18n'
import { YouTubeSettings } from './YouTubeSettings'
import { HistoryList } from './HistoryList'
import { DownloadPanel } from './DownloadPanel'
import { Icon } from './Icon'
import { VideoCover } from './VideoCover'
import { VideoDownloadActions } from './VideoDownloadActions'

function fmtDuration(s: number | null): string {
  if (s == null) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

export function YouTubeTab({ activeJobs, startJob, refreshKey }: TabJobProps) {
  const { t } = useLang()
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [info, setInfo] = useState<InfoResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [quality, setQuality] = useState('best')
  const [zip, setZip] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  async function onGetInfo(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) return
    setInfo(null)
    setError(null)
    setLoading(true)
    try {
      const r = await fetchInfo(url.trim())
      setInfo(r)
      setQuality('best')
      setSelected(new Set(r.entries.map((_, i) => i)))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('fetchFailed'))
    } finally {
      setLoading(false)
    }
  }

  async function onDownloadSingle() {
    if (!info || info.is_playlist) return
    setError(null)
    try {
      await startJob(
        () => startDownload(url.trim(), quality),
        { id: '', kind: 'youtube', status: 'queued', progress: 0, current: null, total: null, phase: 'queued', title: info.title, error: null, download_url: null, download_urls: [] } satisfies JobStatus,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t('startFailed'))
    }
  }

  async function onDownloadBatch() {
    if (!info || !info.is_playlist) return
    const urls = info.entries
      .filter((_, i) => selected.has(i))
      .map((en) => en.url || '')
      .filter(Boolean)
    if (urls.length === 0) {
      setError(t('selectAtLeastOne'))
      return
    }
    setError(null)
    try {
      await startJob(
        () => startBatch(urls, quality, zip, info.title || undefined),
        { id: '', kind: 'youtube', status: 'queued', progress: 0, current: 0, total: urls.length, phase: 'queued', title: info.title, error: null, download_url: null, download_urls: [] } satisfies JobStatus,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t('startFailed'))
    }
  }

  function toggleEntry(i: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => {
      if (info && prev.size === info.entries.length) return new Set()
      return new Set((info?.entries || []).map((_, i) => i))
    })
  }


  return (
    <>
      <DownloadPanel source="youtube">
        <YouTubeSettings />

        <label className="input-label" htmlFor="youtube-url">{t('videoLink')}</label>
        <form className="url-form" onSubmit={onGetInfo}>
          <input
            id="youtube-url"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('urlPlaceholder')}
            autoFocus
          />
          <button type="submit" className="primary" disabled={loading || !url.trim()}>
            {loading ? t('loading') : t('getInfo')}
            <Icon name="arrow" size={16} />
          </button>
        </form>

        {error && <div className="error">{error}</div>}

        {info && !info.is_playlist && (
          <div className="card single">
            <div className="single-head">
              <VideoCover src={info.thumbnail} candidates={info.thumbnail_candidates} title={info.title} />
              <div>
                <h2>{info.title}</h2>
                <div className="meta">{fmtDuration(info.duration)} · {t('formatsCount', { n: info.formats.length })}</div>
              </div>
            </div>
            <VideoDownloadActions
              quality={quality}
              qualities={info.qualities}
              onQualityChange={setQuality}
              onDownload={onDownloadSingle}
            />
          </div>
        )}

        {info && info.is_playlist && (
          <div className="card playlist">
            <div className="playlist-head">
              <div className="playlist-summary">
                <VideoCover src={info.thumbnail} candidates={info.thumbnail_candidates} title={info.title} />
                <div>
                  <h2>{info.title}</h2>
                  <div className="meta">{t('videos', { n: info.entries.length })}</div>
                </div>
              </div>
              <button className="link" onClick={toggleAll}>
                {selected.size === info.entries.length ? t('clearAll') : t('selectAll')}
              </button>
            </div>
            <ul className="entries">
              {info.entries.map((en, i) => (
                <li key={i}>
                  <label>
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggleEntry(i)} />
                    <span className="entry-title">{en.title || en.id || t('videoN', { n: i + 1 })}</span>
                    <span className="entry-dur">{fmtDuration(en.duration)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <VideoDownloadActions
              quality={quality}
              qualities={info.qualities}
              onQualityChange={setQuality}
              onDownload={onDownloadBatch}
              selectedCount={selected.size}
              totalCount={info.entries.length}
              zip={zip}
              onZipChange={setZip}
            />
          </div>
        )}

      </DownloadPanel>
      <HistoryList kind="youtube" activeJobs={activeJobs} refreshKey={refreshKey} />
    </>
  )
}
