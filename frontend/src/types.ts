// Mirrors backend/app/schemas.py
export type OwnerTab = 'youtube' | 'http' | 'bt' | 'bilibili'

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
  format_note?: string | null
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
  thumbnail?: string | null
  thumbnail_candidates?: string[]
  downloaded?: boolean
}

export interface InfoResponse {
  is_playlist: boolean
  title: string | null
  thumbnail: string | null
  thumbnail_candidates?: string[]
  duration: number | null
  qualities: number[]
  formats: VideoFormat[]
  entries: Entry[]
  is_channel?: boolean
  page?: number
  page_size?: number
  has_more?: boolean
}

export type JobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'done' | 'error'

export interface JobStatus {
  id: string
  status: JobState
  progress: number
  // Optional while a job is optimistically queued or using an older server.
  downloaded_bytes?: number
  total_bytes?: number | null
  total_bytes_estimated?: boolean
  speed?: number | null
  eta?: number | null
  current: number | null
  total: number | null
  phase: string | null
  title: string | null
  thumbnail?: string | null
  thumbnail_candidates?: string[]
  resolution?: string | null
  fps?: number | null
  error: string | null
  download_url: string | null
  download_urls: string[]
  kind: string | null
  source?: string | null
}

export interface VideoQueueResponse {
  jobs: JobStatus[]
  skipped_downloaded: number
  skipped_active: number
}

export interface SettingsState {
  proxy: string
  js_runtimes: string
  cookies_configured: boolean
  cookiefile_env: boolean
  bilibili_cookies_configured: boolean
  bilibili_cookiefile_env: boolean
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
  key: string
  download_url: string | null
  kind: string // "youtube" | "http" | "bt" | "bilibili"
  title: string | null
  thumbnail?: string | null
  thumbnail_candidates?: string[]
  resolution?: string | null
  fps?: number | null
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

export interface HistoryBatchDeleteResult {
  removed: string[]
  missing: string[]
  failed: { key: string; reason: 'active_job' | 'shared_file' | 'invalid_path' | 'delete_failed' }[]
}
