import type { PageSnapshot, RawFormat } from './types';

// Serialized into the current tab's MAIN world by chrome.scripting. Keep all
// runtime helpers inside this function so requests use the normal page session.
export async function readBilibili(identity: string, part: number): Promise<PageSnapshot> {
  interface Track {
    id: number; codecid?: number; codecs?: string; mimeType?: string; mime_type?: string;
    baseUrl?: string; base_url?: string; backupUrl?: string[]; backup_url?: string[];
    bandwidth?: number; width?: number; height?: number; frameRate?: string; frame_rate?: string; size?: number;
  }
  interface Video {
    bvid: string; aid: number; title: string; pic?: string; rights?: { is_stein_gate?: number };
    pages: { cid: number; page: number; part: string; duration: number }[];
  }
  interface Playback {
    timelength?: number; is_preview?: number;
    support_formats?: { quality: number; new_description?: string; display_desc?: string }[];
    dash?: { video?: Track[]; audio?: Track[] };
  }
  try {
    function current() {
      const url = new URL(location.href);
      return ['www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(url.hostname)
        && url.pathname.replace(/\/$/, '') === `/video/${identity}` && Number(url.searchParams.get('p') || '1') === part;
    }
    if (!current()) throw new Error('视频或分 P 已切换，请重新读取清晰度。');
    async function request<T>(path: string, query: Record<string, string>): Promise<T> {
      const response = await fetch(`https://api.bilibili.com${path}?${new URLSearchParams(query)}`, { credentials: 'include', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Bilibili 暂时无法读取视频（${response.status}），请稍后重试。`);
      const value = await response.json() as { code: number; message?: string; data?: T };
      if (value.code !== 0 || !value.data) throw new Error(`Bilibili 无法读取视频：${value.message || '视频不可用'}。请在视频页面确认可播放、登录或完成验证后重试。`);
      return value.data;
    }
    const video = await request<Video>('/x/web-interface/view', identity.startsWith('BV') ? { bvid: identity } : { aid: identity.slice(2) });
    if (identity.startsWith('BV') ? video.bvid !== identity : String(video.aid) !== identity.slice(2)) throw new Error('视频信息不匹配，请刷新页面后重试。');
    if (video.rights?.is_stein_gate) throw new Error('暂不支持互动视频，请使用普通投稿视频。');
    const page = video.pages?.find(value => value.page === part);
    if (!page || !Number.isSafeInteger(page.cid) || page.cid <= 0) throw new Error('此分 P 不存在，请打开有效的视频分 P 后重试。');
    const playback = await request<Playback>('/x/player/playurl', { bvid: video.bvid, cid: String(page.cid), fnval: '4048', qn: '127', fourk: '1' });
    if (!current()) throw new Error('视频或分 P 已切换，请重新读取清晰度。');
    if (playback.is_preview) throw new Error('当前账号仅能试看此视频，请在 Bilibili 页面确认完整播放权限。');
    const formats: RawFormat[] = [];
    for (const [tracks, audio] of [[playback.dash?.video, false], [playback.dash?.audio, true]] as const) {
      for (const track of tracks || []) {
        const mime = track.mimeType || track.mime_type || '';
        if (!mime.startsWith(audio ? 'audio/mp4' : 'video/mp4') || !Number.isSafeInteger(track.id) || track.id <= 0) continue;
        const urls = [track.baseUrl || track.base_url, ...(track.backupUrl || track.backup_url || [])].filter((value): value is string => !!value);
        // Prefer the ordinary CDN over optional peer-assisted MCDN endpoints.
        const url = urls.find(value => { try { return new URL(value).hostname.endsWith('.bilivideo.com'); } catch { return false; } }) || urls[0];
        if (!url) continue;
        const rate = String(track.frameRate || track.frame_rate || '').split('/').map(Number);
        const fps = rate[0] / (rate[1] || 1);
        const label = playback.support_formats?.find(value => value.quality === track.id);
        formats.push({
          itag: track.id * 1000 + (track.codecid || 0), mimeType: `${mime}${track.codecs ? `; codecs="${track.codecs}"` : ''}`,
          url, bitrate: Number(track.bandwidth) || 0,
          ...(track.size && track.size > 0 ? { contentLength: String(track.size) } : {}),
          ...(audio ? { audioQuality: 'available' } : { width: track.width, height: track.height, fps: Number.isFinite(fps) && fps > 0 ? fps : undefined, qualityLabel: label?.new_description || label?.display_desc }),
        });
      }
    }
    return {
      site: 'bilibili', videoId: `bilibili:${identity}:p${part}`, title: video.pages.length > 1 ? `${video.title} - P${part} ${page.part}` : video.title,
      thumbnail: video.pic,
      duration: page.duration || Number(playback.timelength || 0) / 1000,
      status: 'OK', live: false, formats, client: {},
    };
  } catch (error) {
    // Chrome serializes a rejected MAIN-world script as an empty result.
    // Return the error as ordinary data so the existing choices() boundary
    // can surface the original login/network/part error in the extension UI.
    return { site: 'bilibili', videoId: `bilibili:${identity}:p${part}`, title: identity, duration: 0,
      status: 'UNAVAILABLE', reason: error instanceof Error ? error.message : String(error), live: false, formats: [], client: {} };
  }
}
