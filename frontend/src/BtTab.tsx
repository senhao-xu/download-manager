import { useRef, useState } from 'react'
import { useLang } from './i18n'
import { JobView } from './JobView'
import { useJobSubscription } from './useJobSubscription'
import { startBtMagnet, startBtTorrentFile } from './api'
import type { JobStatus } from './types'

export function BtTab() {
  const { t } = useLang()
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [job, setJob] = useState<JobStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { subscribe, reset } = useJobSubscription(setJob)
  const fileInput = useRef<HTMLInputElement>(null)

  async function onStart(e: React.FormEvent) {
    e.preventDefault()
    const magnet = text.trim()
    reset()
    setJob(null)
    setError(null)
    try {
      let id: string
      if (magnet) {
        id = await startBtMagnet(magnet)
      } else if (file) {
        id = await startBtTorrentFile(file)
      } else {
        setError(t('noBtSource'))
        return
      }
      setJob({
        id,
        status: 'queued',
        progress: 0,
        current: 0,
        total: 1,
        phase: 'queued',
        title: file ? file.name : null,
        error: null,
        download_url: null,
        download_urls: [],
      })
      subscribe(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('startFailed'))
    }
  }

  const running = !!job && job.status === 'running'

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    setFile(f ?? null)
    // If the user picks a file, clear any pasted magnet so the file wins.
    if (f) setText('')
  }

  return (
    <>
      <form className="url-form http-form" onSubmit={onStart}>
        <textarea
          className="url-textarea"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // Typing a magnet clears a picked file.
            if (e.target.value.trim() && file) {
              setFile(null)
              if (fileInput.current) fileInput.current.value = ''
            }
          }}
          placeholder={t('btPlaceholder')}
          rows={3}
          autoFocus
        />
        <label className="bt-file-row">
          <span className="hint">{t('btFileLabel')}:</span>
          <input
            ref={fileInput}
            type="file"
            accept=".torrent,application/x-bittorrent"
            onChange={onPick}
          />
          {file && <span className="bt-file-name">{file.name}</span>}
        </label>
        <button type="submit" className="primary" disabled={running}>
          {t('downloadBt')}
        </button>
      </form>
      <p className="hint">{t('btHint')}</p>
      {error && <div className="error">{error}</div>}
      {job && <JobView job={job} />}
    </>
  )
}
