import { useState } from 'react'
import { SettingsModal } from './SettingsModal'
import { HistoryPanel } from './HistoryPanel'
import { useLang, useTheme, useTab } from './i18n'
import { YouTubeTab } from './YouTubeTab'
import { HttpTab } from './HttpTab'

export default function App() {
  const { t, lang, setLang } = useLang()
  const { choice, cycle: cycleTheme } = useTheme()
  const { tab, setTab } = useTab()
  const [showSettings, setShowSettings] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const themeIcon = choice === 'dark' ? '🌙' : choice === 'light' ? '☀' : '💻'
  const themeTitle = `${t('themeToggle')} (${t(choice === 'dark' ? 'themeDark' : choice === 'light' ? 'themeLight' : 'themeSystem')})`

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
            <button className="icon-btn" onClick={() => setShowHistory(true)} title={t('history')}>
              🕓
            </button>
            <button className="icon-btn" onClick={() => setShowSettings(true)} title={t('settings')}>
              ⚙
            </button>
          </div>
        </div>
      </header>

      <nav className="tabs">
        <button
          className={tab === 'youtube' ? 'active' : ''}
          onClick={() => setTab('youtube')}
        >
          {t('tabYouTube')}
        </button>
        <button
          className={tab === 'http' ? 'active' : ''}
          onClick={() => setTab('http')}
        >
          {t('tabHTTP')}
        </button>
      </nav>

      <main>
        {tab === 'youtube' ? <YouTubeTab /> : <HttpTab />}
      </main>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showHistory && <HistoryPanel onClose={() => setShowHistory(false)} />}
    </div>
  )
}
