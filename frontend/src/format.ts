export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : index >= 3 ? 2 : 1)} ${units[index]}`
}

export function formatVideoDetails(resolution?: string | null, fps?: number | null): string {
  if (!resolution) return ''
  const rate = fps != null && Number.isFinite(fps) && fps > 0 ? `${Number(fps.toFixed(2))} fps` : ''
  return [resolution.replace('x', '×'), rate].filter(Boolean).join(' · ')
}
