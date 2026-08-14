import { useLang, useTheme, useTab } from './i18n'
import { YouTubeTab } from './YouTubeTab'
import { HttpTab } from './HttpTab'
import { BtTab } from './BtTab'
import { useActiveJob } from './useActiveJob'
import type { JobStatus } from './types'

export default function App() {
  const { t, lang, setLang } = useLang()
  const { choice, cycle: cycleTheme } = useTheme()
  const { tab, setTab } = useTab()
  const themeTitle = `${t('themeToggle')} (${t(choice === 'dark' ? 'themeDark' : choice === 'light' ? 'themeLight' : 'themeSystem')})`

  // One active-job store at App level: each tab's job + its SSE stream survive
  // tab component mount/unmount, so switching tabs no longer drops an in-flight
  // download. Tabs run concurrently and independently; each renders only its own
  // job (jobFor). `reset` is bound to the current tab so a tab clearing its own
  // job never clobbers a download running on another tab.
  const active = useActiveJob()
  const tabProps = {
    active: active.jobFor(tab),
    startJob: (starter: () => Promise<string>, initial: JobStatus) => active.start(tab, starter, initial),
    reset: () => active.reset(tab),
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
          className={tab === 'bt' ? 'active' : ''}
          onClick={() => setTab('bt')}
        >
          {t('tabBT')}
        </button>
      </nav>

      <main>
        {tab === 'youtube' ? <YouTubeTab {...tabProps} /> : tab === 'http' ? <HttpTab {...tabProps} /> : <BtTab {...tabProps} />}
      </main>
    </div>
  )
}
