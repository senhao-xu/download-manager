import { useEffect, useRef, useState } from 'react'
import type { InfoResponse, JobStatus } from './types'
import { fetchInfo, startDownload, startBatch } from './api'
import { SettingsModal } from './SettingsModal'
import { useLang, useTheme } from './i18n'

function fmtDuration(s: number | null): string {
  if (s == null) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

function triggerDownload(url: string) {
  const a = document.createElement('a')
  a.href = url
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function downloadAll(urls: string[]) {
  // stagger so browsers don't drop concurrent downloads
  urls.forEach((u, i) => setTimeout(() => triggerDownload(u), i * 400))
}

export default function App() {
  const { t, lang, setLang } = useLang()
  const { theme, toggle: toggleTheme } = useTheme()
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [info, setInfo] = useState<InfoResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [quality, setQuality] = useState('best')
  const [zip, setZip] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [job, setJob] = useState<JobStatus | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const esRef = useRef<EventSource | null>(null)
  const triggeredRef = useRef<string | null>(null)

  useEffect(() => () => esRef.current?.close(), [])

  function resetJob() {
    esRef.current?.close()
    esRef.current = null
    triggeredRef.current = null
    setJob(null)
  }

  async function onGetInfo(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) return
    resetJob()
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

  function subscribe(jobId: string) {
    esRef.current?.close()
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    esRef.current = es
    es.onmessage = (ev) => {
      const j: JobStatus = JSON.parse(ev.data)
      setJob(j)
      if (j.status === 'done' && triggeredRef.current !== jobId) {
        triggeredRef.current = jobId
        const urls = j.download_urls?.length ? j.download_urls : (j.download_url ? [j.download_url] : [])
        // auto-trigger only a single file; multiple are left to the "Download all"
        // button because browsers often block multiple auto-downloads.
        if (urls.length === 1) triggerDownload(urls[0])
      }
      if (j.status === 'done' || j.status === 'error') es.close()
    }
    es.onerror = () => es.close()
  }

  async function onDownloadSingle() {
    if (!info || info.is_playlist) return
    resetJob()
    setError(null)
    try {
      const jobId = await startDownload(url.trim(), quality)
      setJob({ id: jobId, status: 'queued', progress: 0, current: null, total: null, phase: 'queued', title: info.title, error: null, download_url: null, download_urls: [] })
      subscribe(jobId)
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
    resetJob()
    setError(null)
    try {
      const jobId = await startBatch(urls, quality, zip)
      setJob({ id: jobId, status: 'queued', progress: 0, current: 0, total: urls.length, phase: 'queued', title: info.title, error: null, download_url: null, download_urls: [] })
      subscribe(jobId)
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
    <div className="app">
      <header className="header">
        <div className="header-row">
          <div>
            <h1>▶ {t('appTitle')}</h1>
            <p className="subtitle">{t('subtitle')}</p>
          </div>
          <div className="toolbar">
            <button className="icon-btn" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} title={t('switchLang')}>
              {lang === 'zh' ? 'EN' : '中'}
            </button>
            <button className="icon-btn" onClick={toggleTheme} title={t('themeToggle')}>
              {theme === 'dark' ? '☀' : '🌙'}
            </button>
            <button className="icon-btn" onClick={() => setShowSettings(true)} title={t('settings')}>
              ⚙
            </button>
          </div>
        </div>
      </header>

      <form className="url-form" onSubmit={onGetInfo}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('urlPlaceholder')}
          autoFocus
        />
        <button type="submit" disabled={loading || !url.trim()}>
          {loading ? t('loading') : t('getInfo')}
        </button>
      </form>

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
            <QualityPicker disabled={!!job && job.status === 'running'} />
            <button className="primary" onClick={onDownloadSingle} disabled={!!job && job.status === 'running'}>
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
            <QualityPicker disabled={!!job && job.status === 'running'} />
            <label className="zip-check">
              <input type="checkbox" checked={zip} onChange={(e) => setZip(e.target.checked)} disabled={!!job && job.status === 'running'} />
              {t('zipLabel')}
            </label>
            <button className="primary" onClick={onDownloadBatch} disabled={!!job && job.status === 'running'}>
              {selected.size > 0 ? t('downloadN', { n: selected.size }) : t('download')}
            </button>
          </div>
        </div>
      )}

      {job && <JobView job={job} />}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function JobView({ job }: { job: JobStatus }) {
  const { t } = useLang()
  const pct = Math.max(0, Math.min(100, job.progress))
  const isBatch = job.total != null && job.total > 1
  const urls = job.download_urls?.length ? job.download_urls : (job.download_url ? [job.download_url] : [])
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
        urls.length > 1
          ? <button className="primary download-link" onClick={() => downloadAll(urls)}>{t('downloadAll', { n: urls.length })}</button>
          : <a className="primary download-link" href={urls[0]}>{t('downloadFile')}</a>
      )}
    </div>
  )
}
