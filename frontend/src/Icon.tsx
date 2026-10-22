import type { ReactNode } from 'react'

type IconName = 'http' | 'youtube' | 'bilibili' | 'bt' | 'download' | 'history' | 'file' | 'arrow' | 'info' | 'play'

const paths: Record<IconName, ReactNode> = {
  http: <><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(0 -1)" /></>,
  youtube: <><rect x="3" y="5" width="18" height="14" rx="4" /><path d="m10 9 5 3-5 3z" /></>,
  bilibili: <><rect x="3" y="6" width="18" height="14" rx="3" /><path d="m8 2 4 4 4-4M8 11v3M16 11v3M9 17h6" /></>,
  bt: <><circle cx="12" cy="5" r="3" /><circle cx="5" cy="18" r="3" /><circle cx="19" cy="18" r="3" /><path d="m10.5 8-4 7M13.5 8l4 7M8 18h8" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
  history: <><path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7M12 7v5l3 2" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  play: <path d="m8 4 12 8-12 8z" />,
}

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}
