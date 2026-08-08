import { useLang } from './i18n'

/**
 * In-page media preview overlay. `<video>` for video files, `<audio>` for
 * audio-only results, a hint for non-previewable types. `src` is always a
 * `/api/files/...` URL; the backend sets the right Content-Type.
 */
export function PreviewModal({ src, mime, poster, onClose }: {
  src: string
  mime: string | null
  poster?: string | null
  onClose: () => void
}) {
  const { t } = useLang()
  const isVideo = mime?.startsWith('video/')
    || (!mime && /\.(mp4|webm|mkv|mov)$/i.test(src))
  const isAudio = mime?.startsWith('audio/')
    || (!mime && /\.(mp3|m4a|ogg|opus)$/i.test(src))
  const isImage = mime?.startsWith('image/')
    || (!mime && /\.(jpe?g|png|gif|webp)$/i.test(src))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('preview')}</h2>
          <button className="link" onClick={onClose}>{t('close')}</button>
        </div>
        {isVideo && (
          <video
            src={src}
            poster={poster || undefined}
            controls
            autoPlay
            className="preview-media"
          />
        )}
        {isAudio && <audio src={src} controls autoPlay className="preview-media" />}
        {isImage && <img src={src} alt="" className="preview-media preview-img" />}
        {!isVideo && !isAudio && !isImage && <p className="hint">{t('previewNotSupported')}</p>}
      </div>
    </div>
  )
}
