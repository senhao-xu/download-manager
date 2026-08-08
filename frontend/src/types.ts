// Mirrors backend/app/schemas.py
export interface VideoFormat {
  format_id: string | null
  ext: string | null
  resolution: string | null
  fps: number | null
  vcodec: string | null
  acodec: string | null
  filesize: number | null
}

export interface Entry {
  id: string | null
  url: string | null
  title: string | null
  duration: number | null
}

export interface InfoResponse {
  is_playlist: boolean
  title: string | null
  thumbnail: string | null
  duration: number | null
  qualities: number[]
  formats: VideoFormat[]
  entries: Entry[]
}

export type JobState = 'queued' | 'running' | 'done' | 'error'

export interface JobStatus {
  id: string
  status: JobState
  progress: number
  current: number | null
  total: number | null
  phase: string | null
  title: string | null
  error: string | null
  download_url: string | null
  download_urls: string[]
}

export interface SettingsState {
  proxy: string
  js_runtimes: string
  cookies_configured: boolean
  cookiefile_env: boolean
}

export interface TestResult {
  ok: boolean
  title: string | null
  error: string | null
}

export interface CookieCheckResult {
  // working | blocked | no_cookies | network_error | error
  state: string
  title: string | null
  detail: string | null
}
