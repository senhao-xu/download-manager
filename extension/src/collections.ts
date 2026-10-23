import type { CollectionPage, CollectionSource } from './types';
import { collectionSource } from './batch-core';

export function parseYouTubeCollection(input: unknown, title: string, continuation = false): CollectionPage {
  type Obj = Record<string, unknown>;
  const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
  const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
  const text = (v: unknown): string => {
    if (typeof v === 'string') return v;
    const value = obj(v);
    return String(value.simpleText || value.content || array(value.runs).map(run => obj(run).text || '').join(''));
  };
  const data = obj(input);
  const entries = new Map<string, CollectionPage['entries'][number]>();
  let next: string | undefined;
  function walk(input: unknown) {
    if (Array.isArray(input)) { input.forEach(walk); return; }
    const value = obj(input);
    const renderer = obj(value.playlistVideoRenderer || value.videoRenderer || value.reelItemRenderer);
    const shorts = obj(value.shortsLockupViewModel);
    const lockup = obj(value.lockupViewModel);
    let id = renderer.videoId;
    let title = text(renderer.title || renderer.headline);
    if (Object.keys(shorts).length) {
      id = obj(obj(obj(shorts.onTap).innertubeCommand).reelWatchEndpoint).videoId;
      title = text(obj(shorts.overlayMetadata).primaryText) || text(shorts.accessibilityText);
    }
    if (lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      id = lockup.contentId;
      title = text(obj(obj(lockup.metadata).lockupMetadataViewModel).title);
    }
    if (typeof id === 'string' && /^[\w-]{11}$/.test(id) && renderer.isPlayable !== false) {
      entries.set(id, { videoId: id, title: title || id, url: `https://www.youtube.com/watch?v=${id}` });
      return; // Do not ingest menus, recommendations, or ads attached to a video.
    }
    const token = obj(obj(obj(value.continuationItemRenderer).continuationEndpoint).continuationCommand).token;
    if (typeof token === 'string') next = token;
    for (const [key, child] of Object.entries(value)) {
      if (['header', 'menu', 'masthead', 'topbar', 'frameworkUpdates', 'chipBarViewModel', 'secondaryResults'].includes(key)) continue;
      walk(child);
    }
  }
  if (continuation) walk(data.onResponseReceivedActions || data.onResponseReceivedEndpoints || data.continuationContents);
  else {
    const browse = obj(obj(data.contents).twoColumnBrowseResultsRenderer || obj(data.contents).singleColumnBrowseResultsRenderer);
    const tabs = array(browse.tabs);
    const renderers = tabs.map(tab => obj(obj(tab).tabRenderer));
    const selected = renderers.find(tab => tab.selected === true) || renderers[0];
    walk(selected?.content);
  }
  const reason = text(obj(array(data.alerts)[0]).alertRenderer && obj(obj(array(data.alerts)[0]).alertRenderer).text);
  if (!entries.size && !next) throw new Error(reason || '未读取到列表。请确认列表公开或已登录，并等待页面加载后重试。');
  return { title, entries: [...entries.values()], continuation: next };
}

// Read only JSON literals from the page source; never execute fetched scripts.
export function embeddedJSON(html: string, pattern: RegExp): unknown[] {
  const values: unknown[] = [];
  for (const match of html.matchAll(pattern)) {
    const start = match.index! + match[0].length;
    if (html[start] !== '{') continue;
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < html.length; index++) {
      const char = html[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        if (--depth === 0) {
          try { values.push(JSON.parse(html.slice(start, index + 1))); } catch { /* Non-JSON script expressions are ignored. */ }
          break;
        }
      }
    }
  }
  return values;
}

const youtubeContexts = new Map<string, { context?: unknown; title: string; expires: number }>();
export async function readYouTubeCollection(input: string, continuation?: string, browse?: (context: unknown, token: string) => Promise<unknown>): Promise<CollectionPage> {
  const source = collectionSource(input);
  if (source.site !== 'youtube') throw new Error('请选择 YouTube 播放列表或频道链接。');
  if (continuation !== undefined && (!continuation || continuation.length > 20000)) throw new Error('分页标识无效。');
  const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  let session = continuation ? youtubeContexts.get(source.url) : undefined;
  let initial: unknown;
  if (!session || session.expires <= Date.now()) {
    const response = await fetch(source.url, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`YouTube 列表读取失败（${response.status}）。`);
    if (response.url && new URL(response.url).origin !== 'https://www.youtube.com') throw new Error('请先在 YouTube 页面完成登录或验证，再重试读取列表。');
    const html = await response.text();
    [initial] = embeddedJSON(html, /\bytInitialData\s*=\s*|window\s*\[\s*["']ytInitialData["']\s*\]\s*=\s*/g);
    if (!initial) throw new Error('未读取到列表。请先在 YouTube 页面确认列表可访问、完成登录或验证后重试。');
    const configs = embeddedJSON(html, /\bytcfg\.set\s*\(\s*/g);
    const context = configs.map(value => obj(value).INNERTUBE_CONTEXT).find(value => obj(value).client);
    const metadata = obj(obj(initial).metadata);
    const title = obj(metadata.playlistMetadataRenderer).title || obj(metadata.channelMetadataRenderer).title;
    session = { context, title: typeof title === 'string' ? title : source.id, expires: Date.now() + 15 * 60_000 };
    if (youtubeContexts.size >= 10) youtubeContexts.delete(youtubeContexts.keys().next().value!);
    youtubeContexts.set(source.url, session);
  }
  if (!continuation) return parseYouTubeCollection(initial, session.title);
  if (!session.context) throw new Error('无法读取列表的分页信息，请稍后重新读取列表。');
  if (!browse) throw new Error('加载更多需要 YouTube 页面会话，请保持原 YouTube 页面打开后重试。');
  return parseYouTubeCollection(await browse(session.context, continuation), session.title, true);
}

// Serialized into an already open YouTube tab. This fixed endpoint uses the
// normal first-party session without creating a tab or navigating the page.
export async function browseYouTube(context: unknown, continuation: string): Promise<{ data?: unknown; error?: string }> {
  try {
    const response = await fetch('/youtubei/v1/browse?prettyPrint=false', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ context, continuation }),
    });
    if (!response.ok) throw new Error(`YouTube 列表读取失败（${response.status}）。`);
    return { data: await response.json() };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

export async function readBilibiliCollection(source: CollectionSource, page = 1): Promise<CollectionPage> {
  type Obj = Record<string, unknown>;
  const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
  const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
  async function request(path: string, query: Record<string, string>) {
    const response = await fetch(`https://api.bilibili.com${path}?${new URLSearchParams(query)}`, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Bilibili 列表读取失败（${response.status}）。`);
    const result = obj(await response.json());
    if (result.code !== 0) throw new Error(`Bilibili：${String(result.message || '列表不可用')}（${String(result.code)}）。请在 Bilibili 页面确认可访问、登录或完成验证后重试。`);
    return obj(result.data);
  }
  let title = ''; let records: unknown[]; let total = 0;
  if (source.kind === 'video') {
    const data = await request('/x/web-interface/view', source.id.startsWith('BV') ? { bvid: source.id } : { aid: source.id.slice(2) });
    title = String(data.title || source.id);
    const season = obj(data.ugc_season);
    if (season.id) {
      records = array(season.sections).flatMap(section => array(obj(section).episodes));
      total = records.length; records = records.slice((page - 1) * 30, page * 30);
      title = String(season.title || title);
    } else {
      const bvid = String(data.bvid || '');
      const parts = array(data.pages);
      const entries = parts.slice((page - 1) * 30, page * 30).map(item => {
        const part = obj(item); const number = Number(part.page);
        return { videoId: `bilibili:${bvid}:p${number}`, title: `${title} - P${number} ${String(part.part || '')}`, url: `https://www.bilibili.com/video/${bvid}/${number === 1 ? '' : `?p=${number}`}` };
      });
      return { title, entries, continuation: parts.length > page * 30 ? String(page + 1) : undefined };
    }
  } else {
    const season = source.kind === 'season';
    const data = await request(season ? '/x/polymer/web-space/seasons_archives_list' : '/x/series/archives', season
      ? { mid: source.owner!, season_id: source.id, sort_reverse: 'false', page_num: String(page), page_size: '30' }
      : { mid: source.owner!, series_id: source.id, only_normal: 'true', sort: 'desc', pn: String(page), ps: '30' });
    title = String(obj(data.meta).name || `Bilibili ${season ? '合集' : '列表'} ${source.id}`);
    records = array(data.archives); total = Number(obj(data.page).total || 0);
  }
  const entries = records.map(item => {
    const record = obj(item); const bvid = String(record.bvid || obj(record.arc).bvid || '');
    return { videoId: `bilibili:${bvid}:p1`, title: String(record.title || obj(record.arc).title || bvid), url: `https://www.bilibili.com/video/${bvid}/` };
  }).filter(entry => /^bilibili:BV[0-9A-Za-z]{10}:p1$/.test(entry.videoId));
  if (!entries.length) throw new Error('合集暂无可下载视频，或当前账号无权访问。');
  return { title, entries, continuation: total > page * 30 ? String(page + 1) : undefined };
}
