import { useEffect, useState } from 'react'
import { useLang } from './i18n'
import { getHistory } from './api'
import type { HistoryEntry } from './types'
import { triggerDownload, mimeFromUrl, isPreviewable } from './JobView'
import { PreviewModal } from './PreviewModal'

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

export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const { t, lang } = useLang()
  const [items, setItems] = useState<HistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ src: string; mime: string | null } | null>(null)

  useEffect(() => {
    getHistory()
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : t('fetchFailed')))
  }, [t])

  function kindLabel(kind: string): string {
    return kind === 'http' ? t('kindHttp') : kind === 'bt' ? t('kindBt') : t('kindYoutube')
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('history')}</h2>
          <button className="link" onClick={onClose}>{t('close')}</button>
        </div>

        {error && <div className="error">{error}</div>}

        {items && items.length === 0 && (
          <p className="hint">{t('noHistory')}</p>
        )}

        {items && items.length > 0 && (
          <ul className="history-list">
            {items.map((it) => {
              const src = `/api/files/${it.id}`
              // Prefer the backend mime, but a generic/octet-stream value means
              // "unknown"; fall back to client-side derivation from the filename
              // so preview still works for older records or exotic extensions.
              const backendMime = it.mime && it.mime !== 'application/octet-stream'
                ? it.mime
                : null
              const mime = backendMime || mimeFromUrl(it.filename || src)
              const playable = it.available && !!mime && isPreviewable(it.filename || src)
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
                  </div>
                  <div className="history-actions">
                    <button
                      onClick={() => setPreview({ src, mime })}
                      disabled={!playable}
                    >
                      ▶ {t('preview')}
                    </button>
                    <button
                      onClick={() => triggerDownload(src)}
                      disabled={!it.available}
                    >
                      ⬇ {t('reDownload')}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {preview && (
          <PreviewModal
            src={preview.src}
            mime={preview.mime}
            onClose={() => setPreview(null)}
          />
        )}
      </div>
    </div>
  )
}
