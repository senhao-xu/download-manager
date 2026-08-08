import { useState } from 'react'
import { useLang } from './i18n'
import { JobView } from './JobView'
import { useJobSubscription } from './useJobSubscription'
import { startHttpDownload } from './api'
import type { JobStatus } from './types'

export function HttpTab() {
  const { t } = useLang()
  const [text, setText] = useState('')
  const [job, setJob] = useState<JobStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { subscribe, reset } = useJobSubscription(setJob)

  async function onStart(e: React.FormEvent) {
    e.preventDefault()
    const urls = text.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!urls.length) {
      setError(t('noUrls'))
      return
    }
    reset()
    setJob(null)
    setError(null)
    try {
      const id = await startHttpDownload(urls)
      setJob({
        id,
        status: 'queued',
        progress: 0,
        current: 0,
        total: urls.length,
        phase: 'queued',
        title: null,
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

  return (
    <>
      <form className="url-form http-form" onSubmit={onStart}>
        <textarea
          className="url-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('httpPlaceholder')}
          rows={5}
          autoFocus
        />
        <button type="submit" className="primary" disabled={running}>
          {t('downloadHttp')}
        </button>
      </form>
      <p className="hint">{t('httpHint')}</p>
      {error && <div className="error">{error}</div>}
      {job && <JobView job={job} />}
    </>
  )
}
