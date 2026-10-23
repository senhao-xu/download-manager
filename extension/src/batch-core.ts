import { videoTarget, defaultChoice, coverURL } from './core';
import type { BatchEntry, BatchQuality, Choice, CollectionSource, VideoInfo } from './types';

export const QUEUE_LIMIT = 1000;
export function collectionSource(input: string): CollectionSource {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('请输入有效的 HTTPS 列表链接。');
  if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    const list = url.searchParams.get('list');
    if (['/playlist', '/watch'].includes(url.pathname) && list && /^[\w-]{2,150}$/.test(list)) {
      return { site: 'youtube', kind: 'playlist', id: list, url: `https://www.youtube.com/playlist?list=${list}` };
    }
    const channel = url.pathname.match(/^\/(channel\/[\w-]+|@[\w.\p{L}\p{N}%-]+|(?:c|user)\/[\w.%-]+)(?:\/(videos|shorts|streams|featured))?\/?$/u);
    if (channel) return { site: 'youtube', kind: 'channel', id: channel[1], url: `https://www.youtube.com/${channel[1]}/${channel[2] === 'shorts' ? 'shorts' : 'videos'}` };
  }
  if (url.hostname === 'space.bilibili.com') {
    const uploader = url.pathname.match(/^\/([1-9]\d*)(?:\/(?:upload\/video|video))?\/?$/);
    if (uploader) return { site: 'bilibili', kind: 'channel', id: uploader[1], owner: uploader[1], url: `https://space.bilibili.com/${uploader[1]}/upload/video` };
    const match = url.pathname.match(/^\/([1-9]\d*)\/(?:lists\/([1-9]\d*)|channel\/(collectiondetail|seriesdetail))\/?$/);
    const id = match?.[2] || url.searchParams.get('sid');
    if (match && id && /^[1-9]\d*$/.test(id)) {
      const kind = match[3] === 'seriesdetail' || url.searchParams.get('type') === 'series' ? 'series' : 'season';
      return { site: 'bilibili', kind, id, owner: match[1], url: `https://space.bilibili.com/${match[1]}/lists/${id}?type=${kind}` };
    }
  }
  const target = videoTarget(input);
  if (target.site === 'bilibili') return { site: 'bilibili', kind: 'video', id: target.identity, url: target.url };
  throw new Error('支持 YouTube 播放列表、频道 Videos/Shorts，以及 Bilibili UP 主页、投稿、合集或视频链接。');
}

export function batchEntries(value: unknown): BatchEntry[] {
  if (!Array.isArray(value) || !value.length || value.length > QUEUE_LIMIT) throw new Error(`请选择 1–${QUEUE_LIMIT} 个视频。`);
  const unique = new Map<string, BatchEntry>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.url !== 'string' || typeof item.title !== 'string') throw new Error('视频列表无效。');
    const target = videoTarget(item.url);
    if (item.videoId !== target.videoId) throw new Error('视频标识与链接不匹配。');
    unique.set(target.videoId, { videoId: target.videoId, title: item.title.slice(0, 500) || target.identity, url: target.url, thumbnail: coverURL(item.thumbnail, target.site, target.videoId) });
  }
  return [...unique.values()];
}
export function batchQuality(value: unknown): BatchQuality {
  if (value !== 'best' && value !== '1080' && value !== '720' && value !== 'audio') throw new Error('批量画质设置无效。');
  return value;
}
export function qualityChoice(info: VideoInfo, quality: BatchQuality): Choice {
  const videos = info.choices.filter(choice => choice.videoItag !== undefined);
  const choice = quality === 'audio' ? info.choices.find(value => value.videoItag === undefined)
    : quality === 'best' ? defaultChoice({ ...info, choices: videos })
    : videos.find(value => (value.height || parseInt(value.label, 10)) <= Number(quality));
  if (!choice) throw new Error(quality === 'audio' ? '此视频没有可导出的音频。' : '此视频没有符合所选画质上限的视频格式。');
  return choice;
}
