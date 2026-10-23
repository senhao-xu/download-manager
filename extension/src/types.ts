import type { ClientInfo } from 'googlevideo/protos';

export type Site = 'youtube' | 'bilibili';
export type BatchQuality = 'best' | '1080' | '720' | 'audio';
export interface BatchEntry { videoId: string; title: string; url: string; thumbnail?: string }
export interface CollectionSource { site: Site; kind: 'playlist' | 'channel' | 'video' | 'season' | 'series'; url: string; id: string; owner?: string }
export interface CollectionPage { title: string; entries: BatchEntry[]; continuation?: string }
export interface VideoTarget { site: Site; videoId: string; url: string; identity: string; part: number }
export interface RawFormat {
  itag: number; mimeType: string; bitrate: number;
  url?: string; signatureCipher?: string; cipher?: string;
  width?: number; height?: number; fps?: number; qualityLabel?: string;
  contentLength?: string; approxDurationMs?: string; lastModified?: string;
  audioQuality?: string; audioChannels?: number; audioTrack?: { audioIsDefault?: boolean; id?: string };
  drmFamilies?: string[]; drmTrackType?: string; type?: string;
}
export interface PageSnapshot {
  site?: Site;
  thumbnail?: string;
  videoId: string; title: string; duration: number; playerUrl?: string;
  status: string; reason?: string; live: boolean;
  formats: RawFormat[]; sabrUrl?: string; ustreamerConfig?: string;
  client: { clientName?: number; clientVersion?: string };
}
export interface PlaybackSession {
  videoId: string; capturedAt: number; url: string;
  poToken?: string; ustreamerConfig?: string; clientInfo?: ClientInfo;
  contexts?: { type: number; value: string }[];
}
export interface Choice {
  id: string; videoItag?: number; audioItag?: number;
  label: string; width?: number; height?: number; fps?: number; container: 'mp4' | 'webm' | 'm4a'; estimatedBytes?: number;
}
export interface VideoInfo { site?: Site; videoId: string; title: string; thumbnail?: string; duration: number; choices: Choice[] }
export type TaskState = 'queued' | 'resolving' | 'downloading' | 'merging' | 'saving' | 'completed' | 'failed' | 'cancelled';
export interface Task {
  site?: Site;
  thumbnail?: string;
  id: string; videoId: string; title: string; choice: Choice; state: TaskState;
  created: number; received: number; total?: number; error?: string; downloadId?: number; filename?: string; fileSize?: number;
  batch?: { url: string; quality: BatchQuality };
}
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export const terminal = (state: TaskState) => ['completed', 'failed', 'cancelled'].includes(state);
export const messageError = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function call<T>(type: string, data: Record<string, unknown> = {}, target = 'background'): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ target, type, ...data }) as Reply<T> | undefined;
  if (!reply) throw new Error('扩展未响应，请在扩展管理页重新加载后刷新视频页面。');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
