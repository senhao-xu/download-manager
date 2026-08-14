import { useState } from 'react'
import { useLang } from './i18n'
import { HistoryList } from './HistoryList'
import { startHttpDownload } from './api'
import type { JobStatus, TabJobProps } from './types'

export function HttpTab({ activeJobs, startJob, refreshKey }: TabJobProps) {
  const { t } = useLang()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function onStart(e: React.FormEvent) {
    e.preventDefault()
    const urls = text.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!urls.length) {
      setError(t('noUrls'))
      return
    }
    setError(null)
    try {
      await startJob(
        () => startHttpDownload(urls),
        {
          id: '',
          kind: 'http',
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
        <button type="submit" className="primary">
          {t('downloadHttp')}
        </button>
      </form>
      <p className="hint">{t('httpHint')}</p>
      {error && <div className="error">{error}</div>}
      <HistoryList kind="http" activeJobs={activeJobs} refreshKey={refreshKey} />
    </>
  )
}
