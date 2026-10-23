import type { Choice, PageSnapshot, RawFormat, VideoInfo, PlaybackSession, Task } from './types';

export function playbackMatches(snapshot: PageSnapshot, session?: PlaybackSession): session is PlaybackSession {
  if (!session || session.videoId !== snapshot.videoId || Date.now() - session.capturedAt > 15 * 60_000 || Date.now() < session.capturedAt) return false;
  const source = snapshot.sabrUrl && new URL(mediaURL(snapshot.sabrUrl)).searchParams.get('id');
  const captured = new URL(mediaURL(session.url)).searchParams.get('id');
  // YouTube updates ustreamer settings while playing; compare the signed media identity.
  if (source && captured) return source === captured;
  const normalize = (value?: string) => value?.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  return !!snapshot.ustreamerConfig && normalize(snapshot.ustreamerConfig) === normalize(session.ustreamerConfig);
}

export function videoId(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('请输入有效的 YouTube HTTPS 视频链接。');
  let id: string | null = null;
  if (url.hostname === 'youtu.be') id = url.pathname.match(/^\/([\w-]{11})\/?$/)?.[1] || null;
  else if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/)?.[1] || null;
  }
  if (!id || !/^[\w-]{11}$/.test(id)) throw new Error('只支持 YouTube 单视频和 Shorts 链接，暂不支持播放列表或频道。');
  return id;
}

export function mediaURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com') || url.username || url.password || url.port || url.pathname !== '/videoplayback') {
    throw new Error('视频服务器地址无效。请刷新视频页面后重试。');
  }
  return url.href;
}

export function filename(title: string, container: string): string {
  const base = title.normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 140) || 'YouTube';
  return `${/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? '_' : ''}${base}.${container}`;
}

export function mediaMime(choice: Pick<Choice, 'container' | 'videoItag'>): string {
  if (choice.container === 'm4a') return 'audio/mp4';
  return `${choice.videoItag !== undefined ? 'video' : 'audio'}/${choice.container}`;
}

export function matchesSavedName(actual: string, title: string, container: Choice['container']): boolean {
  const expected = filename(title, container).normalize('NFC').toLowerCase();
  const name = actual.normalize('NFC').toLowerCase();
  if (!name.endsWith(`.${container}`)) return false;
  const base = name.slice(0, -container.length - 1);
  const expectedBase = expected.slice(0, -container.length - 1);
  return base === expectedBase || base.replace(/ \(\d+\)$/, '') === expectedBase;
}

export function progressPercent(task: Pick<Task, 'state' | 'received' | 'total'>): number | undefined {
  if (task.state === 'completed') return 100;
  if (task.state !== 'downloading' || !task.total || task.total <= 0 || !Number.isFinite(task.total) || !Number.isFinite(task.received)) return undefined;
  // Total size can be estimated. File completion is confirmed by Chrome later.
  return Math.max(0, Math.min(99, Math.floor(task.received / task.total * 100)));
}

export function choices(snapshot: PageSnapshot): VideoInfo {
  if (snapshot.status !== 'OK') throw new Error(snapshot.reason || 'YouTube 暂时无法播放此视频，请在页面登录或完成验证后重试。');
  if (snapshot.live) throw new Error('暂不支持正在进行的直播。');
  const available = snapshot.formats.filter(format => !format.drmFamilies?.length && !format.drmTrackType && format.type !== 'FORMAT_STREAM_TYPE_OTF' && (format.url || format.signatureCipher || format.cipher || snapshot.sabrUrl));
  const audio = available.filter(format => format.mimeType.startsWith('audio/'));
  const list: Choice[] = [];
  function size(format: RawFormat) {
    const exact = Number(format.contentLength);
    return exact > 0 ? exact : format.bitrate && snapshot.duration > 0 ? Math.round(format.bitrate * snapshot.duration / 8) : undefined;
  }
  const bestAudio = (webm: boolean) => audio.filter(format => format.mimeType.includes(webm ? 'webm' : 'mp4') && format.audioTrack?.audioIsDefault !== false)
    .sort((a, b) => b.bitrate - a.bitrate)[0];
  for (const format of available.filter(format => format.mimeType.startsWith('video/') && Number(format.height) > 0).sort((a, b) => (b.height! - a.height!) || (b.fps || 0) - (a.fps || 0) || Number(b.mimeType.includes('mp4')) - Number(a.mimeType.includes('mp4')) || b.bitrate - a.bitrate)) {
    const webm = format.mimeType.includes('webm');
    const paired = format.audioQuality || format.audioChannels ? undefined : bestAudio(webm);
    if (!format.audioQuality && !format.audioChannels && !paired) continue;
    const container = webm ? 'webm' : 'mp4';
    const id = `${format.itag}:${paired?.itag || 0}`;
    const bytes = size(format); const audioBytes = paired && size(paired);
    // Keep one compatible codec pair per resolution, frame rate and container.
    if (list.some(choice => choice.label === `${format.height}p` && choice.fps === format.fps && choice.container === container)) continue;
    list.push({ id, videoItag: format.itag, audioItag: paired?.itag, label: `${format.height}p`, fps: format.fps, container, estimatedBytes: bytes && (!paired || audioBytes) ? bytes + (audioBytes || 0) : undefined });
  }
  for (const webm of [false, true]) {
    const format = bestAudio(webm);
    if (format) list.push({ id: `audio:${format.itag}`, audioItag: format.itag, label: '仅音频', container: webm ? 'webm' : 'm4a', estimatedBytes: size(format) });
  }
  if (!list.length) throw new Error('未获得可下载格式。请先播放几秒视频，再刷新列表；登录或验证提示需在 YouTube 页面完成。');
  return { videoId: snapshot.videoId, title: snapshot.title, duration: snapshot.duration, choices: list };
}

export function bytes(value?: number): string {
  if (!value) return '大小未知';
  return value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB` : `${(value / 1e6).toFixed(1)} MB`;
}

// choices() orders video formats by resolution, frame rate, then MP4 preference.
export function defaultChoice(info: VideoInfo): Choice | undefined {
  return info.choices.find(choice => choice.videoItag !== undefined) || info.choices[0];
}
