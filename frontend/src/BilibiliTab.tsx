import { useState } from 'react'
import type { InfoResponse, JobStatus, TabJobProps } from './types'
import { fetchInfo, startBilibiliDownload, startBilibiliBatch } from './api'
import { useLang } from './i18n'
import { BilibiliSettings } from './BilibiliSettings'
import { HistoryList } from './HistoryList'

function fmtDuration(s: number | null): string {
  if (s == null) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

export function BilibiliTab({ activeJobs, startJob, refreshKey }: TabJobProps) {
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
        () => startBilibiliDownload(url.trim(), quality),
        { id: '', kind: 'bilibili', status: 'queued', progress: 0, current: null, total: null, phase: 'queued', title: info.title, error: null, download_url: null, download_urls: [] } satisfies JobStatus,
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
        () => startBilibiliBatch(urls, quality, zip, info.title || undefined),
        { id: '', kind: 'bilibili', status: 'queued', progress: 0, current: 0, total: urls.length, phase: 'queued', title: info.title, error: null, download_url: null, download_urls: [] } satisfies JobStatus,
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

  const qualityOptions = ['best', ...(info?.qualities || [])]
  const QualityPicker = ({ disabled }: { disabled: boolean }) => (
    <label>
      {t('quality')}
      <select value={quality} onChange={(e) => setQuality(e.target.value)} disabled={disabled}>
        {qualityOptions.map((q) => (
          <option key={q} value={q}>{q === 'best' ? t('best') : `${q}p`}</option>
        ))}
      </select>
    </label>
  )

  return (
    <>
      <BilibiliSettings />

      <form className="url-form" onSubmit={onGetInfo}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('bilibiliUrlPlaceholder')}
          autoFocus
        />
        <button type="submit" disabled={loading || !url.trim()}>
          {loading ? t('loading') : t('getInfo')}
        </button>
      </form>

      <p className="hint">{t('bilibiliHint')}</p>

      {error && <div className="error">{error}</div>}

      {info && !info.is_playlist && (
        <div className="card single">
          <div className="single-head">
            {info.thumbnail && <img src={info.thumbnail} alt="" className="thumb" />}
            <div>
              <h2>{info.title}</h2>
              <div className="meta">{fmtDuration(info.duration)} · {t('formatsCount', { n: info.formats.length })}</div>
            </div>
          </div>
          <div className="actions">
            <QualityPicker disabled={false} />
            <button className="primary" onClick={onDownloadSingle}>
              {t('download')}
            </button>
          </div>
        </div>
      )}

      {info && info.is_playlist && (
        <div className="card playlist">
          <div className="playlist-head">
            <div>
              <h2>{info.title}</h2>
              <div className="meta">{t('videos', { n: info.entries.length })}</div>
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
          <div className="actions">
            <QualityPicker disabled={false} />
            <label className="zip-check">
              <input type="checkbox" checked={zip} onChange={(e) => setZip(e.target.checked)} />
              {t('zipLabel')}
            </label>
            <button className="primary" onClick={onDownloadBatch}>
              {selected.size > 0 ? t('downloadN', { n: selected.size }) : t('download')}
            </button>
          </div>
        </div>
      )}

      <HistoryList kind="bilibili" activeJobs={activeJobs} refreshKey={refreshKey} />
    </>
  )
}
