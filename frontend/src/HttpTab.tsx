import { useEffect, useState } from 'react'
import { useLang } from './i18n'
import { JobView } from './JobView'
import { HistoryList } from './HistoryList'
import { startHttpDownload } from './api'
import type { ActiveJobProps, JobStatus } from './types'

export function HttpTab({ active, startJob, reset }: ActiveJobProps) {
  const { t } = useLang()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const doneId = active?.status === 'done' ? active.id : null
  useEffect(() => {
    if (doneId) setHistoryRefresh((n) => n + 1)
  }, [doneId])

  async function onStart(e: React.FormEvent) {
    e.preventDefault()
    const urls = text.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!urls.length) {
      setError(t('noUrls'))
      return
    }
    reset()
    setError(null)
    try {
      await startJob(
        () => startHttpDownload(urls),
        {
          id: '',
          status: 'queued',
          progress: 0,
          current: 0,
          total: urls.length,
          phase: 'queued',
          title: null,
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
      {active && <JobView job={active} />}
      <HistoryList kind="http" refreshKey={historyRefresh} />
    </>
  )
}
