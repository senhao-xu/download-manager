import { useState } from 'react'
import { useLang } from './i18n'
import { Icon } from './Icon'

export function VideoCover({ src, candidates = [], title }: { src: string | null; candidates?: string[]; title: string | null }) {
  const { t } = useLang()
  const [failedSources, setFailedSources] = useState<Set<string>>(() => new Set())
  const sources = [...new Set([src, ...candidates].filter((url): url is string => !!url))]
  const source = sources.find((url) => !failedSources.has(url))
  if (!source) {
    return <div className="thumb thumb-placeholder" role="img" aria-label={t('coverUnavailable')}><Icon name="youtube" size={25} /><span>{t('coverUnavailable')}</span></div>
  }
  return <img key={source} src={source} alt={t('videoCover', { title: title || '' })} className="thumb" referrerPolicy="no-referrer" onError={() => setFailedSources((previous) => new Set(previous).add(source))} />
}
