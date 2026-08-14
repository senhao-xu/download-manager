// Mirrors backend/app/schemas.py
export type OwnerTab = 'youtube' | 'http' | 'bt'

export interface TabJobProps {
  /** Active (queued/running/just-finished) jobs of this tab's kind, newest first. */
  activeJobs: JobStatus[]
  /** Start a job: run `starter` (API call -> job_id). `initial.kind` must be set. */
  startJob: (starter: () => Promise<string>, initial: JobStatus) => Promise<void>
  /** Bumped (via the shared store) when any job goes terminal, so history refetches. */
  refreshKey: number
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

export type JobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'done' | 'error'

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
  kind: string | null
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
