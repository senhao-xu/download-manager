import { useEffect, useRef, useState } from 'react'
import type { CookieCheckResult, SettingsState, TestResult } from './types'
import {
  getSettings,
  uploadCookies,
  clearCookies,
  testConnection,
  checkCookies,
} from './api'
import { useLang } from './i18n'

// The canonical "first YouTube video" - a stable, public URL used purely as a
// reachability probe for cookie-availability checks.
const DEFAULT_TEST_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'

/**
 * Inline YouTube settings block. All downloader settings (cookies, proxy, JS
 * runtime, test connection) only serve YouTube access, so they live here inside
 * the YouTube tab rather than a global modal.
 *
 * Cookie availability is checked AUTOMATICALLY:
 *  - on mount, when cookies are already configured
 *  - right after the user saves (or clears) cookies
 * A manual "Re-check" button remains for retrying on demand. `checkingRef`
 * guards against two triggers firing overlapping requests.
 */
export function YouTubeSettings() {
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
        // On entering the YouTube tab: if cookies are already configured, run
        // the availability check automatically.
        if (s.cookies_configured) runCookieCheck()
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
      setCookieCheck(await checkCookies(DEFAULT_TEST_URL))
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
      await uploadCookies(cookiesText)
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
      await clearCookies()
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
      case 'working': return { ok: true, text: t('cookieWorking') }
      case 'no_cookies': return { ok: false, text: t('cookieNoCookies') }
      case 'blocked': return { ok: false, text: t('cookieBlocked') }
      case 'network_error': return { ok: false, text: t('cookieNetworkError') }
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
          <p className="hint">{t('cookiesHint')}</p>
          <div className="status-row">
            {t('status')}{' '}
            <span className={state?.cookies_configured ? 'badge ok' : 'badge'}>
              {state?.cookies_configured ? t('configured') : t('notConfigured')}
            </span>
            {state?.cookiefile_env && !state?.cookies_configured && (
              <span className="hint"> {t('cookiefileEnvHint')}</span>
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
            <button onClick={removeCookies} disabled={!state?.cookies_configured || saving === 'clear'}>
              {saving === 'clear' ? t('clearing') : t('clearCookies')}
            </button>
            <button onClick={runCookieCheck} disabled={checking || !state?.cookies_configured}>
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
            <input type="text" value={testUrl} onChange={(e) => setTestUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" />
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
