import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Lang = 'zh' | 'en'
export type Theme = 'dark' | 'light'

type Vars = Record<string, string | number>

const translations: Record<Lang, Record<string, string>> = {
  en: {
    appTitle: 'YouTube Downloader',
    subtitle: 'Paste a video or playlist URL · pick quality · download',
    settings: 'Settings',
    urlPlaceholder: 'https://www.youtube.com/watch?v=…  or  …/playlist?list=…',
    getInfo: 'Get info',
    loading: 'Loading…',
    quality: 'Quality',
    best: 'Best (mp4)',
    download: 'Download',
    formatsCount: '{n} formats',
    videos: '{n} videos',
    selectAll: 'Select all',
    clearAll: 'Clear all',
    downloadN: 'Download ({n})',
    downloadAll: 'Download all ({n})',
    zipLabel: 'Package as zip',
    videoN: 'Video {n}',
    jobDownload: 'Download',
    playlistDownload: 'Playlist download',
    done: 'Done',
    failed: 'Failed',
    downloadFile: '⬇ Download file',
    settingsTitle: 'Settings',
    close: '✕ Close',
    cookies: 'Cookies',
    cookiesHint: 'For YouTube, export a cookies.txt from a logged-in browser (use a “Get cookies.txt” extension) and paste it here.',
    status: 'Status:',
    configured: 'configured',
    notConfigured: 'not configured',
    cookiefileEnvHint: '(a cookie file is set via env)',
    cookiesPlaceholder: '# Netscape HTTP Cookie File\n.youtube.com  TRUE  /  FALSE  ...  VISITOR_INFO1  ...',
    saveCookies: 'Save cookies',
    saving: 'Saving…',
    clearCookies: 'Clear cookies',
    clearing: 'Clearing…',
    settingsSaved: 'Settings saved.',
    cookiesSaved: 'Cookies saved.',
    cookiesCleared: 'Cookies cleared.',
    pasteCookiesFirst: 'Paste cookies first.',
    network: 'Network',
    proxyLabel: 'Proxy (HTTP/SOCKS, needed if YouTube is unreachable)',
    jsRuntime: "JS runtime (for YouTube's JS challenge; node is recommended)",
    saveNetwork: 'Save network settings',
    testConnection: 'Test connection',
    testHint: 'Verify a URL extracts with the current settings.',
    test: 'Test',
    testing: 'Testing…',
    testOk: '✓ OK - {title}',
    testFail: '✗ {error}',
    checkCookies: 'Check cookies',
    checking: 'Checking…',
    cookieWorking: '✓ Cookies are working (YouTube accessible)',
    cookieNoCookies: 'No cookies configured.',
    cookieBlocked: '✗ Cookies not working - YouTube still blocked. Cookies may be expired/invalid, or a proxy is needed.',
    cookieNetworkError: '✗ Cannot reach YouTube. Check your proxy.',
    cookieError: '✗ {detail}',
    fetchFailed: 'Failed to fetch info',
    startFailed: 'Failed to start download',
    selectAtLeastOne: 'Select at least one video.',
    jobLost: 'Job lost.',
    themeToggle: 'Toggle theme',
    switchLang: 'Switch language',
  },
  zh: {
    appTitle: 'YouTube 下载器',
    subtitle: '粘贴视频或播放列表链接 · 选画质 · 下载',
    settings: '设置',
    urlPlaceholder: 'https://www.youtube.com/watch?v=… 或 …/playlist?list=…',
    getInfo: '获取信息',
    loading: '加载中…',
    quality: '画质',
    best: '最佳 (mp4)',
    download: '下载',
    formatsCount: '{n} 个格式',
    videos: '{n} 个视频',
    selectAll: '全选',
    clearAll: '清空',
    downloadN: '下载 ({n})',
    downloadAll: '下载全部 ({n})',
    zipLabel: '打包为 ZIP',
    videoN: '视频 {n}',
    jobDownload: '下载',
    playlistDownload: '播放列表下载',
    done: '完成',
    failed: '失败',
    downloadFile: '⬇ 下载文件',
    settingsTitle: '设置',
    close: '✕ 关闭',
    cookies: 'Cookies',
    cookiesHint: 'YouTube 需要从已登录浏览器导出 cookies.txt（用 “Get cookies.txt” 扩展），粘贴到这里。',
    status: '状态：',
    configured: '已配置',
    notConfigured: '未配置',
    cookiefileEnvHint: '（已通过环境变量设置 cookie 文件）',
    cookiesPlaceholder: '# Netscape HTTP Cookie File\n.youtube.com  TRUE  /  FALSE  ...  VISITOR_INFO1  ...',
    saveCookies: '保存 Cookie',
    saving: '保存中…',
    clearCookies: '清除 Cookie',
    clearing: '清除中…',
    settingsSaved: '设置已保存。',
    cookiesSaved: 'Cookie 已保存。',
    cookiesCleared: 'Cookie 已清除。',
    pasteCookiesFirst: '请先粘贴 Cookie。',
    network: '网络',
    proxyLabel: '代理（HTTP/SOCKS，YouTube 不可达时需要）',
    jsRuntime: 'JS 运行时（用于 YouTube JS 挑战，推荐 node）',
    saveNetwork: '保存网络设置',
    testConnection: '测试连接',
    testHint: '用当前设置验证某个链接能否提取。',
    test: '测试',
    testing: '测试中…',
    testOk: '✓ 成功 - {title}',
    testFail: '✗ {error}',
    checkCookies: '验证 Cookie',
    checking: '检测中…',
    cookieWorking: '✓ Cookie 可用（可访问 YouTube）',
    cookieNoCookies: '未配置 Cookie。',
    cookieBlocked: '✗ Cookie 不可用 - YouTube 仍被拦截。Cookie 可能已过期/失效，或需要代理。',
    cookieNetworkError: '✗ 无法访问 YouTube，请检查代理。',
    cookieError: '✗ {detail}',
    fetchFailed: '获取信息失败',
    startFailed: '开始下载失败',
    selectAtLeastOne: '至少选择一个视频。',
    jobLost: '任务丢失。',
    themeToggle: '切换主题',
    switchLang: '切换语言',
  },
}

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: string, vars?: Vars) => string }
const LangContext = createContext<Ctx>({ lang: 'zh', setLang: () => {}, t: (k) => k })

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('lang')) as Lang | null
    return stored === 'en' || stored === 'zh' ? stored : 'zh'
  })
  const setLang = (l: Lang) => {
    localStorage.setItem('lang', l)
    setLangState(l)
  }
  const t = (key: string, vars?: Vars) => {
    let s = translations[lang][key] ?? key
    if (vars) for (const k of Object.keys(vars)) s = s.replace(`{${k}}`, String(vars[k]))
    return s
  }
  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>
}

export function useLang() {
  return useContext(LangContext)
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('theme')) as Theme | null
    if (stored === 'dark' || stored === 'light') return stored
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  })
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])
  const toggle = () => setTheme((p) => (p === 'dark' ? 'light' : 'dark'))
  return { theme, toggle }
}
