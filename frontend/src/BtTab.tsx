import { useEffect, useRef, useState } from 'react'
import { useLang } from './i18n'
import { JobView } from './JobView'
import { HistoryList } from './HistoryList'
import { startBtMagnet, startBtTorrentFile } from './api'
import type { ActiveJobProps, JobStatus } from './types'

export function BtTab({ active, startJob, reset }: ActiveJobProps) {
  const { t } = useLang()
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const doneId = active?.status === 'done' ? active.id : null
  useEffect(() => {
    if (doneId) setHistoryRefresh((n) => n + 1)
  }, [doneId])

  async function onStart(e: React.FormEvent) {
    e.preventDefault()
    const magnet = text.trim()
    reset()
    setError(null)
    try {
      let starter: () => Promise<string>
      let title: string | null
      if (magnet) {
        starter = () => startBtMagnet(magnet)
        title = null
      } else if (file) {
        const f = file
        starter = () => startBtTorrentFile(f)
        title = f.name
      } else {
        setError(t('noBtSource'))
        return
      }
      await startJob(
        starter,
        {
          id: '',
          status: 'queued',
          progress: 0,
          current: 0,
          total: 1,
          phase: 'queued',
          title,
          error: null,
          download_url: null,
          download_urls: [],
        } satisfies JobStatus,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t('startFailed'))
    }
  }

  const running = !!active && active.status === 'running'

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
      {active && <JobView job={active} />}
      <HistoryList kind="bt" refreshKey={historyRefresh} />
    </>
  )
}
