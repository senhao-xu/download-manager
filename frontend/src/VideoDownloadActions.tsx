import { useId, useRef, useState } from 'react'
import { useLang } from './i18n'
import { Icon } from './Icon'

type Props = {
  quality: string
  qualities: number[]
  onQualityChange: (quality: string) => void
  onDownload: () => Promise<void>
  selectedCount?: number
  totalCount?: number
  zip?: boolean
  onZipChange?: (zip: boolean) => void
}

export function VideoDownloadActions({ quality, qualities, onQualityChange, onDownload, selectedCount, totalCount, zip, onZipChange }: Props) {
  const { t } = useLang()
  const qualityId = useId()
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)
  const isBatch = selectedCount != null

  async function submit() {
    if (inFlight.current || selectedCount === 0) return
    inFlight.current = true
    setSubmitting(true)
    try {
      await onDownload()
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  function qualityLabel(value: number) {
    const badge = value >= 4320 ? '8K' : value >= 2160 ? '4K' : value >= 1440 ? '2K' : value >= 1080 ? 'Full HD' : value >= 720 ? 'HD' : ''
    return badge ? `${value}p · ${badge}` : `${value}p`
  }

  return (
    <div className="video-download-actions">
      <div className="video-action-heading">
        <span>{t('downloadOptions')}</span>
        {isBatch && <span className="selection-count" role="status">{t('selectedCount', { n: selectedCount, total: totalCount ?? selectedCount })}</span>}
      </div>
      <div className="video-action-controls">
        <div className="quality-control">
          <label htmlFor={qualityId}>{t('quality')}</label>
          <select id={qualityId} value={quality} onChange={(event) => onQualityChange(event.target.value)} disabled={submitting}>
            <option value="best">{t('autoBestQuality')}</option>
            {[...new Set(qualities)].map((value) => <option key={value} value={value}>{qualityLabel(value)}</option>)}
          </select>
        </div>
        {onZipChange && (
          <label className="video-zip-option">
            <input type="checkbox" checked={zip ?? false} onChange={(event) => onZipChange(event.target.checked)} disabled={submitting} />
            <span>{t('zipLabel')}</span>
          </label>
        )}
        <button type="button" className="primary video-download-button" onClick={() => void submit()} disabled={submitting || selectedCount === 0} aria-busy={submitting}>
          {submitting ? <span className="button-spinner" aria-hidden="true" /> : <Icon name="download" size={19} />}
          <span>{submitting ? t('creatingDownload') : isBatch ? t('downloadSelected') : t('startDownload')}</span>
          {isBatch && !submitting && <span className="download-count">{selectedCount}</span>}
        </button>
      </div>
    </div>
  )
}
