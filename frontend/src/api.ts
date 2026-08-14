import type { CookieCheckResult, HistoryList, InfoResponse, SettingsState, TestResult } from './types'

async function postJSON(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readError(r: Response): Promise<string> {
  try {
    const j = await r.json()
    return j.detail || `Request failed (${r.status})`
  } catch {
    return `Request failed (${r.status})`
  }
}

export async function fetchInfo(url: string): Promise<InfoResponse> {
  const r = await postJSON('/api/info', { url })
  if (!r.ok) throw new Error(await readError(r))
  return r.json()
}

export async function startDownload(url: string, quality: string): Promise<string> {
  const r = await postJSON('/api/download', { url, quality })
  if (!r.ok) throw new Error(await readError(r))
  const j = await r.json()
  return j.job_id as string
}

export async function startBatch(urls: string[], quality: string, zip: boolean = false, title?: string): Promise<string> {
  const r = await postJSON('/api/download-batch', { urls, quality, zip, title })
  if (!r.ok) throw new Error(await readError(r))
  const j = await r.json()
  return j.job_id as string
}

export async function startHttpDownload(urls: string[]): Promise<string> {
  const r = await postJSON('/api/download-http', { urls })
  if (!r.ok) throw new Error(await readError(r))
  const j = await r.json()
  return j.job_id as string
}

export async function startBtMagnet(magnet: string): Promise<string> {
  const r = await postJSON('/api/download-bt', { magnet })
  if (!r.ok) throw new Error(await readError(r))
  const j = await r.json()
  return j.job_id as string
}

export async function startBtTorrentFile(file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const r = await fetch('/api/download-bt/file', { method: 'POST', body: form })
  if (!r.ok) throw new Error(await readError(r))
  const j = await r.json()
  return j.job_id as string
}

// ---- Settings ----

export async function getSettings(): Promise<SettingsState> {
  const r = await fetch('/api/settings')
  if (!r.ok) throw new Error('Failed to load settings')
  return r.json()
}

export async function updateSettings(proxy: string, js_runtimes: string): Promise<SettingsState> {
  const r = await postJSON('/api/settings', { proxy, js_runtimes })
  if (!r.ok) throw new Error(await readError(r))
  return r.json()
}

export async function uploadCookies(content: string): Promise<void> {
  const r = await fetch('/api/settings/cookies', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: content,
  })
  if (!r.ok) throw new Error(await readError(r))
}

export async function clearCookies(): Promise<void> {
  const r = await fetch('/api/settings/cookies', { method: 'DELETE' })
  if (!r.ok) throw new Error(await readError(r))
}

export async function testConnection(url: string): Promise<TestResult> {
  const r = await postJSON('/api/settings/test', { url })
  if (!r.ok) throw new Error(await readError(r))
  return r.json()
}

export async function checkCookies(url: string): Promise<CookieCheckResult> {
  const r = await postJSON('/api/settings/check-cookies', { url })
  if (!r.ok) throw new Error(await readError(r))
  return r.json()
}

// ---- History ----

export async function getHistory(kind?: string, page: number = 1, pageSize: number = 10): Promise<HistoryList> {
  const params = new URLSearchParams()
  if (kind) params.set('kind', kind)
  params.set('page', String(page))
  params.set('page_size', String(pageSize))
  const r = await fetch(`/api/history?${params.toString()}`)
  if (!r.ok) throw new Error('Failed to load history')
  return r.json()
}

export async function deleteHistory(jobId: string, deleteFiles: boolean = false): Promise<void> {
  const params = new URLSearchParams()
  if (deleteFiles) params.set('delete_files', 'true')
  const r = await fetch(`/api/history/${jobId}?${params.toString()}`, { method: 'DELETE' })
  if (!r.ok) {
    try {
      const j = await r.json()
      throw new Error(j.detail || `Request failed (${r.status})`)
    } catch (e) {
      throw e instanceof Error ? e : new Error(`Request failed (${r.status})`)
    }
  }
}
