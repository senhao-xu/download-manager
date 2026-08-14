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
  const themeIcon = choice === 'dark' ? '🌙' : choice === 'light' ? '☀' : '💻'
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

  return (
    <div className="app">
      <header className="header">
        <div className="header-row">
          <div>
            <h1>▶ {t('appTitle')}</h1>
            <p className="subtitle">{t('subtitle')}</p>
          </div>
          <div className="toolbar">
            <button className="icon-btn" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} title={t('switchLang')}>
              {lang === 'zh' ? 'EN' : '中'}
            </button>
            <button className="icon-btn" onClick={cycleTheme} title={themeTitle}>
              {themeIcon}
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
