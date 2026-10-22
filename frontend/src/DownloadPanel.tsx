import type { ReactNode } from 'react'
import { useLang, type Tab } from './i18n'
import { Icon } from './Icon'

export function DownloadPanel({ source, children }: { source: Tab; children: ReactNode }) {
  const { t } = useLang()
  return (
    <section className="download-panel" aria-labelledby={`${source}-heading`}>
      <div className="panel-heading">
        <div className={`source-icon source-${source}`}><Icon name={source} size={22} /></div>
        <div>
          <h3 id={`${source}-heading`}>{t(`${source}PanelTitle`)}</h3>
          <p>{t(`${source}PanelHint`)}</p>
        </div>
      </div>
      {children}
    </section>
  )
}
