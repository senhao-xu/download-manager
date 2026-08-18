import { useEffect, useRef, useState } from 'react'
import type { CookieCheckResult, SettingsState, TestResult } from './types'
import {
  getSettings,
  uploadBilibiliCookies,
  clearBilibiliCookies,
  testConnection,
  checkBilibiliCookies,
} from './api'
import { useLang } from './i18n'

// Bilibili's first video (av1) - a stable, public URL used purely as a
// reachability probe for cookie-availability checks.
const DEFAULT_TEST_URL = 'https://www.bilibili.com/video/BV1xx411c7mD'

/**
 * Inline Bilibili settings block. Unlike YouTube there is no separate proxy/JS
 * runtime here: proxy and JS runtime are global yt-dlp settings (shared across
 * all tabs), so only the Bilibili-specific cookies + a connection test live in
 * this panel.
 *
 * Bilibili caps anonymous access at ~720P; 1080P+ / member (大会员) content needs
 * a login (SESSDATA). Cookies are stored in a SEPARATE file from the global
 * YouTube one so the two don't mix.
 */
export function BilibiliSettings() {
  const { t } = useLang()
  const [state, setState] = useState<SettingsState | null>(null)
  const [cookiesText, setCookiesText] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState('')
  const [testUrl, setTestUrl] = useState(DEFAULT_TEST_URL)
  const [test, setTest] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [cookieCheck, setCookieCheck] = useState<CookieCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const checkingRef = useRef(false)

  useEffect(() => {
    getSettings()
      .then((s) => {
        setState(s)
        // On entering the tab: if Bilibili cookies are already configured, run
        // the availability check automatically.
        if (s.bilibili_cookies_configured) runCookieCheck()
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : 'Failed to load settings'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runCookieCheck() {
    if (checkingRef.current) return
    checkingRef.current = true
    setChecking(true)
    setCookieCheck(null)
    try {
      setCookieCheck(await checkBilibiliCookies(DEFAULT_TEST_URL))
    } catch (e) {
      setCookieCheck({ state: 'error', title: null, detail: e instanceof Error ? e.message : 'Failed' })
    } finally {
      setChecking(false)
      checkingRef.current = false
    }
  }

  async function saveCookies() {
    if (!cookiesText.trim()) {
      setMsg(t('pasteCookiesFirst'))
      return
    }
    setSaving('cookies')
    setMsg(null)
    setCookieCheck(null)
    try {
      await uploadBilibiliCookies(cookiesText)
      setCookiesText('')
      const s = await getSettings()
      setState(s)
      setMsg(t('cookiesSaved'))
      // Auto-verify the just-saved cookies.
      runCookieCheck()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving('')
    }
  }

  async function removeCookies() {
    setSaving('clear')
    setMsg(null)
    setCookieCheck(null)
    try {
      await clearBilibiliCookies()
      const s = await getSettings()
      setState(s)
      setMsg(t('cookiesCleared'))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving('')
    }
  }

  async function runTest() {
    setTesting(true)
    setTest(null)
    try {
      setTest(await testConnection(testUrl))
    } catch (e) {
      setTest({ ok: false, title: null, error: e instanceof Error ? e.message : 'Failed' })
    } finally {
      setTesting(false)
    }
  }

  const verdict = (cc: CookieCheckResult) => {
    switch (cc.state) {
      case 'working': return { ok: true, text: t('bilibiliCookieWorking') }
      case 'no_cookies': return { ok: false, text: t('cookieNoCookies') }
      case 'blocked': return { ok: false, text: t('bilibiliCookieBlocked') }
      case 'network_error': return { ok: false, text: t('bilibiliCookieNetworkError') }
      default: return { ok: false, text: t('cookieError', { detail: cc.detail || '' }) }
    }
  }

  return (
    <details className="yt-settings">
      <summary>{t('settingsTitle')}</summary>

      <div className="yt-settings-body">
        {msg && <div className="modal-msg">{msg}</div>}

        <section>
          <h3>{t('cookies')}</h3>
          <p className="hint">{t('bilibiliCookiesHint')}</p>
          <div className="status-row">
            {t('status')}{' '}
            <span className={state?.bilibili_cookies_configured ? 'badge ok' : 'badge'}>
              {state?.bilibili_cookies_configured ? t('configured') : t('notConfigured')}
            </span>
            {state?.bilibili_cookiefile_env && !state?.bilibili_cookies_configured && (
              <span className="hint"> {t('cookiefileEnvHint')}</span>
            )}
            {state?.cookies_configured && !state?.bilibili_cookies_configured && !state?.bilibili_cookiefile_env && (
              <span className="hint"> {t('bilibiliCookiesFallbackHint')}</span>
            )}
          </div>
          <textarea
            placeholder={t('cookiesPlaceholder')}
            value={cookiesText}
            onChange={(e) => setCookiesText(e.target.value)}
            rows={6}
          />
          <div className="btn-row">
            <button className="primary" onClick={saveCookies} disabled={saving === 'cookies'}>
              {saving === 'cookies' ? t('saving') : t('saveCookies')}
            </button>
            <button onClick={removeCookies} disabled={!state?.bilibili_cookies_configured || saving === 'clear'}>
              {saving === 'clear' ? t('clearing') : t('clearCookies')}
            </button>
            <button onClick={runCookieCheck} disabled={checking || !state?.bilibili_cookies_configured}>
              {checking ? t('checking') : t('checkCookies')}
            </button>
          </div>
          {(checking || cookieCheck) && (
            <div className={checking ? 'test-result' : (verdict(cookieCheck!).ok ? 'test-result ok' : 'test-result err')}>
              {checking ? t('checking') : verdict(cookieCheck!).text}
            </div>
          )}
        </section>

        <section>
          <h3>{t('testConnection')}</h3>
          <p className="hint">{t('testHint')}</p>
          <div className="test-row">
            <input type="text" value={testUrl} onChange={(e) => setTestUrl(e.target.value)} placeholder={t('bilibiliTestUrlPlaceholder')} />
            <button className="primary" onClick={runTest} disabled={testing}>
              {testing ? t('testing') : t('test')}
            </button>
          </div>
          {test && (
            <div className={test.ok ? 'test-result ok' : 'test-result err'}>
              {test.ok ? t('testOk', { title: test.title || '' }) : t('testFail', { error: test.error || '' })}
            </div>
          )}
        </section>
      </div>
    </details>
  )
}
