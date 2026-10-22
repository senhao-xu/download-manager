import { useEffect, useId, useRef, useState } from 'react'
import { useLang } from './i18n'
import { Icon } from './Icon'

export function VideoPlayer({ src, title, poster, downloadUrl, onClose }: {
  src: string
  title: string
  poster?: string | null
  downloadUrl: string | null
  onClose: () => void
}) {
  const { t } = useLang()
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current!
    const video = videoRef.current!
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const history = previousFocus?.closest<HTMLElement>('.history-inline')
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    setLoading(true)
    setFailed(false)
    // Set the resource here so StrictMode's cleanup/setup cycle can reload it.
    video.src = src
    dialog.showModal()
    return () => {
      video.pause()
      video.removeAttribute('src')
      video.load()
      dialog.close()
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
      else if (history?.isConnected) history.focus()
    }
  }, [src])

  return (
    <dialog ref={dialogRef} className="video-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); onClose() }}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
      }}>
      <div className="modal-head video-player-head">
        <div><span className="video-player-label">{t('videoPlayer')}</span><h2 id={titleId}>{title}</h2></div>
        <button type="button" className="link" autoFocus onClick={onClose}>{t('close')}</button>
      </div>
      {loading && !failed && <p className="video-player-status" role="status">{t('videoLoading')}</p>}
      <video ref={videoRef} className="video-player-media" aria-label={title} poster={poster || undefined}
        controls autoPlay playsInline preload="metadata" hidden={failed}
        onLoadedData={() => setLoading(false)}
        onError={() => { setLoading(false); setFailed(true) }} />
      {failed && <p className="error" role="alert">{t('videoPlaybackFailed')}</p>}
      {downloadUrl && <div className="video-player-actions">
        <a className="primary download-link" href={downloadUrl}>
          <Icon name="download" size={16} />{t('downloadFile')}
        </a>
      </div>}
    </dialog>
  )
}
