import { useEffect } from 'react'
import { useLang, useTheme, useTab } from './i18n'
import { YouTubeTab } from './YouTubeTab'
import { HttpTab } from './HttpTab'
import { BtTab } from './BtTab'
import { BilibiliTab } from './BilibiliTab'
import { useJobs } from './useActiveJob'
import type { JobStatus } from './types'

export default function App() {
  const { t, lang, setLang } = useLang()
  const { choice, cycle: cycleTheme } = useTheme()
  const { tab, setTab } = useTab()
  const themeTitle = `${t('themeToggle')} (${t(choice === 'dark' ? 'themeDark' : choice === 'light' ? 'themeLight' : 'themeSystem')})`

  // One multi-job store at App level: every in-flight job (started this session
  // OR restored from the server after a reload) lives here, each with its own
  // SSE stream. Switching/closing tabs never drops a download. On mount we
  // restore any jobs still running server-side so live progress survives a
  // page reload.
  const jobs = useJobs()
  useEffect(() => { void jobs.restore() }, [jobs])
  const tabProps = {
    activeJobs: jobs.jobsFor(tab),
    startJob: (starter: () => Promise<string>, initial: JobStatus) => jobs.start(starter, initial),
    refreshKey: jobs.historyRefreshTick,
  }

  const ThemeIcon = () => {
    if (choice === 'dark') {
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )
    }
    if (choice === 'light') {
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )
    }
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-row">
          <div>
            <h1>
              <span className="logo" aria-hidden="true">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 4v10" />
                  <path d="m7 11 5 5 5-5" />
                  <path d="M5 20h14" />
                </svg>
              </span>
              {t('appTitle')}
            </h1>
            <p className="subtitle">{t('subtitle')}</p>
          </div>
          <div className="toolbar">
            <button className="icon-btn" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} title={t('switchLang')}>
              {lang === 'zh' ? 'EN' : '中'}
            </button>
            <button className="icon-btn" onClick={cycleTheme} title={themeTitle}>
              <ThemeIcon />
            </button>
          </div>
        </div>
      </header>

      <nav className="tabs">
        <button
          className={tab === 'http' ? 'active' : ''}
          onClick={() => setTab('http')}
        >
          {t('tabHTTP')}
        </button>
        <button
          className={tab === 'youtube' ? 'active' : ''}
          onClick={() => setTab('youtube')}
        >
          {t('tabYouTube')}
        </button>
        <button
          className={tab === 'bilibili' ? 'active' : ''}
          onClick={() => setTab('bilibili')}
        >
          {t('tabBilibili')}
        </button>
        <button
          className={tab === 'bt' ? 'active' : ''}
          onClick={() => setTab('bt')}
        >
          {t('tabBT')}
        </button>
      </nav>

      <main>
        {tab === 'youtube' ? <YouTubeTab {...tabProps} /> : tab === 'bilibili' ? <BilibiliTab {...tabProps} /> : tab === 'http' ? <HttpTab {...tabProps} /> : <BtTab {...tabProps} />}
      </main>

      <footer className="footer">
        <a
          className="footer-link"
          href="https://github.com/senhao-xu/download-manager"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.3-1.7-1.3-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.4-1.27.73-1.56-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.2-3.1-.12-.3-.52-1.48.1-3.08 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.5 3.17-1.18 3.17-1.18.63 1.6.23 2.78.11 3.08.75.81 1.2 1.84 1.2 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z" />
          </svg>
          {t('githubLink')}
        </a>
      </footer>
    </div>
  )
}
