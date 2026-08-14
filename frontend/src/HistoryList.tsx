import { useEffect, useState } from 'react'
import { useLang } from './i18n'
import { getHistory, deleteHistory } from './api'
import type { HistoryEntry, OwnerTab } from './types'
import { triggerDownload } from './JobView'

const PAGE_SIZE = 10

function fmtSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

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
 * `refreshKey` is bumped by the owning tab when its active job reaches `done`,
 * so a freshly completed download appears here without a manual reload.
 */
export function HistoryList({ kind, refreshKey }: { kind: OwnerTab; refreshKey: number }) {
  const { t, lang } = useLang()
  const [items, setItems] = useState<HistoryEntry[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  // id of the row whose delete confirm is open; null = none.
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [busy, setBusy] = useState(false)

  // Re-fetch when the page, kind, or the parent's refreshKey changes. Resetting
  // to page 1 on refreshKey keeps the user on a stable view after a new entry.
  function fetchPage() {
    let cancelled = false
    setError(null)
    getHistory(kind, page, PAGE_SIZE)
      .then((r) => {
        if (cancelled) return
        setItems(r.items)
        setTotal(r.total)
        // If the current page ran past the last page (e.g. after deletions),
        // snap back to the last valid page.
        const lastPage = Math.max(1, Math.ceil(r.total / PAGE_SIZE))
        if (page > lastPage) setPage(lastPage)
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('fetchFailed')) })
    return () => { cancelled = true }
  }

  useEffect(fetchPage, [kind, page, refreshKey, t])

  function kindLabel(k: string): string {
    return k === 'http' ? t('kindHttp') : k === 'bt' ? t('kindBt') : t('kindYoutube')
  }

  async function confirmDelete(id: string) {
    setBusy(true)
    setError(null)
    try {
      await deleteHistory(id, deleteFiles)
      setDeleting(null)
      setDeleteFiles(false)
      // Force a refresh of the current view.
      const lastPage = Math.max(1, Math.ceil(Math.max(0, total - 1) / PAGE_SIZE))
      if (page > lastPage) setPage(lastPage)
      else fetchPage()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('deleteFailed'))
    } finally {
      setBusy(false)
    }
  }

  function cancelDelete() {
    setDeleting(null)
    setDeleteFiles(false)
  }

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="history-inline">
      <h3 className="history-inline-head">{t('historyTitle')} <span className="history-count">({total})</span></h3>

      {error && <div className="error">{error}</div>}

      {items && items.length === 0 && (
        <p className="hint">{t('noHistory')}</p>
      )}

      {items && items.length > 0 && (
        <>
          <ul className="history-list">
            {items.map((it) => {
              const src = `/api/files/${it.id}`
              return (
                <li key={it.id} className={`history-row${it.available ? '' : ' expired'}`}>
                  <div className="history-main">
                    <div className="history-title">
                      {it.title || it.filename || it.id}
                    </div>
                    <div className="history-meta">
                      <span className="badge">{kindLabel(it.kind)}</span>
                      {!it.available && <span className="badge err">{t('expired')}</span>}
                      <span className="history-time">{fmtRelative(it.created, lang)}</span>
                      {it.size != null && <span className="history-size">{fmtSize(it.size)}</span>}
                      {it.source && <span className="history-source" title={it.source}>{it.source}</span>}
                    </div>
                    {deleting === it.id && (
                      <div className="history-delete-confirm">
                        <label className="zip-check">
                          <input
                            type="checkbox"
                            checked={deleteFiles}
                            onChange={(e) => setDeleteFiles(e.target.checked)}
                            disabled={busy}
                          />
                          {t('deleteFilesToo')}
                        </label>
                        <button className="danger" onClick={() => confirmDelete(it.id)} disabled={busy}>
                          {busy ? t('deleting') : t('confirmDelete')}
                        </button>
                        <button className="link" onClick={cancelDelete} disabled={busy}>
                          {t('cancel')}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="history-actions">
                    <button
                      onClick={() => triggerDownload(src)}
                      disabled={!it.available}
                    >
                      ⬇ {t('reDownload')}
                    </button>
                    {deleting !== it.id && (
                      <button
                        className="danger"
                        onClick={() => { setDeleting(it.id); setDeleteFiles(false) }}
                        disabled={busy}
                      >
                        ✕ {t('delete')}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>

          {lastPage > 1 && (
            <div className="history-pager">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                {'←'} {t('prevPage')}
              </button>
              <span className="pager-info">{t('page', { n: page, total: lastPage })}</span>
              <button onClick={() => setPage((p) => Math.min(lastPage, p + 1))} disabled={page >= lastPage}>
                {t('nextPage')} {'→'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
