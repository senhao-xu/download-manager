import { useEffect, useRef, useState } from 'react'
import { useLang } from './i18n'
import { getHistory, deleteHistoryBatch } from './api'
import type { HistoryEntry, JobStatus, OwnerTab } from './types'
import { downloadAll, JobView, triggerDownload } from './JobView'
import { Icon } from './Icon'
import { formatBytes, formatVideoDetails } from './format'
import { VideoCover } from './VideoCover'

const PAGE_SIZE = 10

const DownloadIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v10" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 20h14" />
  </svg>
)

const TrashIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
)

const ArrowLeft = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 12H5" />
    <path d="m12 19-7-7 7-7" />
  </svg>
)

const ArrowRight = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
)

function fmtRelative(ts: number, lang: string): string {
  const now = Date.now() / 1000
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60)
  const hr = Math.floor(min / 60)
  const day = Math.floor(hr / 24)
  const rel = day > 0 ? `${day}d` : hr > 0 ? `${hr}h` : min > 0 ? `${min}m` : 'just now'
  const abs = new Date(ts * 1000).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')
  return `${rel} · ${abs}`
}

/**
 * Inline, paginated download history for a single tab, filtered by `kind`.
 *
 * Active (in-flight) jobs of this tab's kind render as live-progress rows ABOVE
 * the history list; completed downloads render below. `refreshKey` (bumped by
 * the shared store when a job goes terminal) triggers a history refetch so a
 * freshly completed download appears. While an active job is still shown (even
 * briefly after it finishes), its history copy is hidden by id-dedupe so there
 * is never a duplicate row.
 */
export function HistoryList({ kind, activeJobs, refreshKey }: {
  kind: OwnerTab
  activeJobs: JobStatus[]
  refreshKey: number
}) {
  return <HistoryForKind key={kind} kind={kind} activeJobs={activeJobs} refreshKey={refreshKey} />
}

function HistoryForKind({ kind, activeJobs, refreshKey }: {
  kind: OwnerTab
  activeJobs: JobStatus[]
  refreshKey: number
}) {
  const { t, lang } = useLang()
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [data, setData] = useState<{ view: string; items: HistoryEntry[]; total: number } | null>(null)
  const [failedView, setFailedView] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Snapshot the precise records when confirmation opens.
  const [deleting, setDeleting] = useState<HistoryEntry[] | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const mounted = useRef(true)
  const view = `${page}:${refreshKey}:${reload}`
  const current = data?.view === view
  const loading = !current && failedView !== view
  const total = data?.total ?? 0

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    getHistory(kind, page, PAGE_SIZE)
      .then((r) => {
        if (cancelled) return
        const lastPage = Math.max(1, Math.ceil(r.total / PAGE_SIZE))
        if (page > lastPage) {
          setSelected(new Set())
          setDeleting(null)
          setPage(lastPage)
          return
        }
        setData({ view, items: r.items, total: r.total })
        setFailedView(null)
        const keys = new Set(r.items.map(item => item.key))
        setSelected(previous => new Set([...previous].filter(key => keys.has(key))))
      })
      .catch(() => { if (!cancelled) setFailedView(view) })
    return () => { cancelled = true }
  }, [kind, page, view])

  // Hide history rows whose job is still shown as an active row (covers the
  // brief window where a finished job is still pinned on top before dismiss).
  const activeIds = new Set(activeJobs.map((j) => j.id))
  const historyItems = (current ? data.items : []).filter((it) => !activeIds.has(it.id))
  const selectedItems = historyItems.filter(item => selected.has(item.key))
  const downloadUrls = selectedItems.flatMap(item => item.available && item.download_url ? [item.download_url] : [])
  const allSelected = historyItems.length > 0 && selectedItems.length === historyItems.length
  const locked = busy || deleting !== null || !current

  // Live-job deduplication and refreshes must not leave hidden selections.
  const visibleKeys = historyItems.map(item => item.key).join(',')
  useEffect(() => {
    if (!current) return
    const keys = new Set(visibleKeys.split(','))
    setSelected(previous => {
      const next = new Set([...previous].filter(key => keys.has(key)))
      return next.size === previous.size ? previous : next
    })
    setDeleting(previous => previous?.some(item => !keys.has(item.key)) ? null : previous)
  }, [current, visibleKeys])

  function kindLabel(k: string): string {
    return k === 'http' ? t('kindHttp') : k === 'bt' ? t('kindBt') : k === 'bilibili' ? t('kindBilibili') : t('kindYoutube')
  }

  async function confirmDelete() {
    if (!deleting || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await deleteHistoryBatch(deleting.map(item => item.key), deleteFiles)
      if (!mounted.current) return
      const finished = new Set([...result.removed, ...result.missing])
      setSelected(previous => new Set([...previous].filter(key => !finished.has(key))))
      if (result.failed.length) {
        const names = new Map(deleting.map(item => [item.key, item.title || item.filename || item.id]))
        setSelected(new Set(result.failed.map(item => item.key)))
        setError(`${t('historyDeletePartial', { n: result.failed.length })} ${result.failed.map(item =>
          `${names.get(item.key) ?? item.key}: ${t(`historyDelete_${item.reason}`)}`).join('; ')}`)
      }
      if (finished.size) setMessage(t('historyDeleted', { n: finished.size }))
      setDeleting(null)
      setDeleteFiles(false)
      setReload(value => value + 1)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : t('deleteFailed'))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function openDelete(records: HistoryEntry[]) {
    if (locked || !records.length) return
    setDeleting(records)
    setDeleteFiles(false)
    setError(null)
    setMessage(null)
  }

  function cancelDelete() {
    setDeleting(null)
    setDeleteFiles(false)
  }

  function changePage(next: number) {
    setSelected(new Set())
    cancelDelete()
    setError(null)
    setMessage(null)
    setPage(next)
  }

  function toggle(key: string) {
    setSelected(previous => {
      const next = new Set(previous)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasActive = activeJobs.length > 0

  return (
    <div className="history-inline">
      <h3 className="history-inline-head">
        <Icon name="history" size={19} />
        {t('historyTitle')} <span className="history-count">{total}</span>
        {hasActive && <span className="active-count">{t('activeCount', { n: activeJobs.length })}</span>}
      </h3>

      {hasActive && (
        <ul className="active-jobs-list">
          {activeJobs.map((job) => (
            <li key={job.id} className="active-job-row">
              <JobView job={job} />
            </li>
          ))}
        </ul>
      )}

      {error && <div className="error" role="alert">{error}</div>}
      {message && <p className="history-notice" role="status">{message}</p>}
      {failedView === view && (
        <div className="error" role="alert">
          {t('fetchFailed')} <button onClick={() => setReload(value => value + 1)}>{t('historyRetry')}</button>
        </div>
      )}

      {loading && <p className="history-loading" role="status">{t('loading')}</p>}

      {current && !hasActive && historyItems.length === 0 && (
        <div className="history-empty">
          <span className="empty-icon"><Icon name="download" size={27} /></span>
          <h4>{t('noHistory')}</h4>
          <p>{t('noHistoryHint')}</p>
        </div>
      )}

      {historyItems.length > 0 && (
        <>
          <div className="history-batch-toolbar" role="group" aria-label={t('historyBatchActions')}>
            <label className="history-check">
              <input type="checkbox" checked={allSelected} disabled={locked}
                ref={node => { if (node) node.indeterminate = selectedItems.length > 0 && !allSelected }}
                onChange={() => setSelected(allSelected ? new Set() : new Set(historyItems.map(item => item.key)))} />
              {t('selectPage')}
            </label>
            <span className="history-selection-count" role="status">{t('selectedCount', { n: selectedItems.length, total: historyItems.length })}</span>
            {selectedItems.length > 0 && <button className="link" disabled={locked} onClick={() => setSelected(new Set())}>{t('clearSelection')}</button>}
            <div className="history-batch-actions">
              <button disabled={locked || !downloadUrls.length} onClick={() => {
                downloadAll(downloadUrls)
                setMessage(t('historyDownloading', { n: downloadUrls.length, skipped: selectedItems.length - downloadUrls.length }))
              }}>{DownloadIcon} {t('downloadSelected')}</button>
              <button className="danger" disabled={locked || !selectedItems.length} onClick={() => openDelete(selectedItems)}>
                {TrashIcon} {t('historyDeleteSelected')}
              </button>
            </div>
          </div>
          {deleting && (
            <div className="history-delete-confirm" role="group" aria-label={t('historyDeleteConfirm', { n: deleting.length })}>
              <p>{t('historyDeleteConfirm', { n: deleting.length })}</p>
              <label className="zip-check">
                <input type="checkbox" checked={deleteFiles} onChange={event => setDeleteFiles(event.target.checked)} disabled={busy} />
                {t('deleteFilesToo')}
              </label>
              <button className="danger" onClick={() => void confirmDelete()} disabled={busy || !current}>
                {busy ? t('deleting') : t('confirmDelete')}
              </button>
              <button className="link" onClick={cancelDelete} disabled={busy}>{t('cancel')}</button>
            </div>
          )}
          <ul className="history-list">
            {historyItems.map((it) => {
              const hasCover = !!(it.thumbnail || it.thumbnail_candidates?.length)
              const videoDetails = formatVideoDetails(it.resolution, it.fps)
              return (
                <li key={it.key} className={`history-row${hasCover ? ' has-cover' : ''}${it.available ? '' : ' expired'}${selected.has(it.key) ? ' selected' : ''}`}>
                  <label className="history-check history-row-check">
                    <input type="checkbox" checked={selected.has(it.key)} disabled={locked}
                      aria-label={t('historySelectRecord', { title: it.title || it.filename || it.id })}
                      onChange={() => toggle(it.key)} />
                  </label>
                  {hasCover
                    ? <VideoCover src={it.thumbnail ?? null} candidates={it.thumbnail_candidates} title={it.title} />
                    : <span className="history-file-icon"><Icon name="file" size={21} /></span>}
                  <div className="history-main">
                    <div className="history-title" title={it.title || it.filename || it.id}>
                      {it.title || it.filename || it.id}
                    </div>
                    <div className="history-meta">
                      <span className="badge">{kindLabel(it.kind)}</span>
                      {videoDetails && <span className="history-resolution" title={t('videoResolution')}>{videoDetails}</span>}
                      {!it.available && <span className="badge err">{t('expired')}</span>}
                      <span className="history-time">{fmtRelative(it.created, lang)}</span>
                      {it.size != null && <span className="history-size">{formatBytes(it.size)}</span>}
                      {it.source && <span className="history-source" title={it.source}>{it.source}</span>}
                    </div>
                  </div>
                  <div className="history-actions">
                    <button
                      onClick={() => { if (it.download_url) triggerDownload(it.download_url) }}
                      disabled={locked || !it.available || !it.download_url}
                    >
                      {DownloadIcon} {t('reDownload')}
                    </button>
                    <button
                      className="danger"
                      onClick={() => openDelete([it])}
                      disabled={locked}
                    >
                      {TrashIcon} {t('delete')}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {current && lastPage > 1 && (
        <nav className="history-pager" aria-label={t('historyPagination')}>
          <button onClick={() => changePage(Math.max(1, page - 1))} disabled={locked || page <= 1}>
            {ArrowLeft} {t('prevPage')}
          </button>
          <span className="pager-info">{t('page', { n: page, total: lastPage })}</span>
          <button onClick={() => changePage(Math.min(lastPage, page + 1))} disabled={locked || page >= lastPage}>
            {t('nextPage')} {ArrowRight}
          </button>
        </nav>
      )}
    </div>
  )
}
