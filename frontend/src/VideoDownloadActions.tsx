import { useId, useRef, useState } from 'react'
import { useLang } from './i18n'
import { Icon } from './Icon'
import type { VideoFormat } from './types'

type Props = {
  quality: string
  qualities: number[]
  formats?: VideoFormat[]
  onQualityChange: (quality: string) => void
  onDownload: () => Promise<void>
  selectedCount?: number
  totalCount?: number
  zip?: boolean
  onZipChange?: (zip: boolean) => void
}

export function VideoDownloadActions({ quality, qualities, formats = [], onQualityChange, onDownload, selectedCount, totalCount, zip, onZipChange }: Props) {
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
    // Cropped videos can be reported as 2160p while their actual height is 2026.
    // Keep the real height as the selection value, and use the source's tier
    // for display rather than guessing it from the aspect ratio.
    const format = formats.find((item) => item.vcodec && item.vcodec !== 'none'
      && (item.resolution?.endsWith(`x${value}`) || item.resolution === `${value}p`)
      && /^\d+p/i.test(item.format_note ?? ''))
    const nominal = Number(format?.format_note?.match(/^(\d+)p/i)?.[1]) || value
    const badge = nominal >= 4320 ? '8K' : nominal >= 2160 ? '4K' : nominal >= 1440 ? '2K' : nominal >= 1080 ? 'Full HD' : nominal >= 720 ? 'HD' : ''
    const label = badge ? `${nominal}p · ${badge}` : `${nominal}p`
    return nominal !== value && format?.resolution
      ? `${label} (${format.resolution.replace('x', '×')})`
      : label
  }

  return (
    <div className="video-download-actions">
      <div className="video-action-heading">
        <span>{t('downloadOptions')}</span>
        {isBatch && <span className="selection-count" role="status">{totalCount == null ? t('selectedVideos', { n: selectedCount }) : t('selectedCount', { n: selectedCount, total: totalCount })}</span>}
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
