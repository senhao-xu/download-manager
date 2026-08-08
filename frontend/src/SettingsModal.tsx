import { useEffect, useState } from 'react'
import type { CookieCheckResult, SettingsState, TestResult } from './types'
import {
  getSettings,
  updateSettings,
  uploadCookies,
  clearCookies,
  testConnection,
  checkCookies,
} from './api'
import { useLang } from './i18n'

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useLang()
  const [state, setState] = useState<SettingsState | null>(null)
  const [proxy, setProxy] = useState('')
  const [runtime, setRuntime] = useState('node')
  const [cookiesText, setCookiesText] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState('')
  const [testUrl, setTestUrl] = useState('https://www.youtube.com/watch?v=jNQXAC9IVRw')
  const [test, setTest] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [cookieCheck, setCookieCheck] = useState<CookieCheckResult | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    getSettings()
      .then((s) => {
        setState(s)
        setProxy(s.proxy)
        setRuntime(s.js_runtimes)
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : 'Failed to load settings'))
  }, [])

  async function saveSettings() {
    setSaving('settings')
    setMsg(null)
    try {
      const s = await updateSettings(proxy, runtime)
      setState(s)
      setMsg(t('settingsSaved'))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving('')
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

  async function runCookieCheck() {
    setChecking(true)
    setCookieCheck(null)
    try {
      setCookieCheck(await checkCookies(testUrl))
    } catch (e) {
      setCookieCheck({ state: 'error', title: null, detail: e instanceof Error ? e.message : 'Failed' })
    } finally {
      setChecking(false)
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('settingsTitle')}</h2>
          <button className="link" onClick={onClose}>{t('close')}</button>
        </div>

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
            <button onClick={runCookieCheck} disabled={checking}>
              {checking ? t('checking') : t('checkCookies')}
            </button>
          </div>
          {cookieCheck && (
            <div className={verdict(cookieCheck).ok ? 'test-result ok' : 'test-result err'}>
              {verdict(cookieCheck).text}
            </div>
          )}
        </section>

        <section>
          <h3>{t('network')}</h3>
          <label className="field">
            <span>{t('proxyLabel')}</span>
            <input type="text" placeholder="http://127.0.0.1:7890" value={proxy} onChange={(e) => setProxy(e.target.value)} />
          </label>
          <label className="field">
            <span>{t('jsRuntime')}</span>
            <select value={runtime} onChange={(e) => setRuntime(e.target.value)}>
              <option value="node">node</option>
              <option value="deno">deno</option>
              <option value="bun">bun</option>
            </select>
          </label>
          <div className="btn-row">
            <button className="primary" onClick={saveSettings} disabled={saving === 'settings'}>
              {saving === 'settings' ? t('saving') : t('saveNetwork')}
            </button>
          </div>
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
    </div>
  )
}
