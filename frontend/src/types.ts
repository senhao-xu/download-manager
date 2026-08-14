// Mirrors backend/app/schemas.py
export type OwnerTab = 'youtube' | 'http' | 'bt'

export interface ActiveJobProps {
  /** The active job iff it was started by this tab; otherwise null. */
  active: JobStatus | null
  /** Start a job: run `starter` (API call -> job_id), show `initial` immediately. */
  startJob: (starter: () => Promise<string>, initial: JobStatus) => Promise<void>
  /** Clear the active job and close its SSE stream. */
  reset: () => void
}

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

export interface HistoryEntry {
  id: string
  kind: string // "youtube" | "http"
  title: string | null
  source: string | null
  filename: string | null
  size: number | null
  mime: string | null
  created: number
  available: boolean
}

export interface HistoryList {
  items: HistoryEntry[]
  total: number
  page: number
  page_size: number
}
