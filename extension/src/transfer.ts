import { mediaURL } from './core';
import type { Site } from './types';

export const RANGE_BYTES = 4 * 1024 * 1024;
export const DOWNLOAD_CONNECTIONS = 4;
export interface TransferSource {
  site?: Site;
  url: string;
  length?: number;
  write(data: Uint8Array<ArrayBuffer>, position: number): Promise<void>;
}

// All tracks share one pool. Random-position writes are serialized per file,
// so a later range can finish first without corrupting the output or buffering
// the entire video. Unknown-length sources use one streaming request each.
export async function downloadParts(sources: TransferSource[], cancel: AbortSignal, onBytes: (count: number) => void): Promise<void> {
  const abort = new AbortController();
  const signal = AbortSignal.any([cancel, abort.signal]);
  const tracks = sources.map(source => ({ ...source, url: mediaURL(source.url, source.site), offset: 0, claimed: false, ranged: true, writes: Promise.resolve(),
    length: Number.isSafeInteger(source.length) && source.length! > 0 ? source.length : undefined }));
  let cursor = 0;
  function next() {
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[cursor++ % tracks.length];
      if (track.length && track.ranged ? track.offset >= track.length : track.claimed) continue;
      const start = track.offset;
      const end = track.length && track.ranged ? Math.min(track.length - 1, start + RANGE_BYTES - 1) : undefined;
      track.offset = end === undefined ? 0 : end + 1; track.claimed = true;
      return { track, start, end };
    }
  }
  async function request(url: URL, range?: string) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      if (attempt) await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 250 * 2 ** (attempt - 1));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      let response: Response;
      // Chromium can serialize HTTP Range reads behind its cache entry for a
      // shared URL. Bypass that cache so the four Bilibili ranges can overlap.
      try { response = await fetch(url, { signal, redirect: 'error', credentials: 'omit', ...(range ? { headers: { Range: range }, cache: 'no-store' as const } : {}) }); }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof TypeError) || attempt >= 2) throw error;
        continue;
      }
      if (response.ok) return response;
      await response.body?.cancel().catch(() => {});
      if (attempt < 2 && [429, 500, 502, 503, 504].includes(response.status)) continue;
      throw new Error(response.status === 403 ? '播放地址已失效或会话验证失败，请刷新视频、播放几秒后重试。' : `视频下载失败（${response.status}）。`);
    }
  }
  // Bilibili's playback API omits track sizes. Probe one byte before splitting
  // into ranges; a CDN that ignores Range falls back to one streamed request.
  const probes = await Promise.allSettled(tracks.filter(track => track.site === 'bilibili' && !track.length).map(async track => {
    try {
      const response = await request(new URL(track.url), 'bytes=0-0');
      try {
        if (response.status === 206) {
          const match = response.headers.get('Content-Range')?.match(/^bytes 0-0\/([1-9]\d*)$/);
          const size = Number(match?.[1]);
          if (!Number.isSafeInteger(size) || size <= 0) throw new Error('视频服务器返回的分片位置不匹配，请重新下载。');
          track.length = size;
        } else {
          track.ranged = false;
          const size = Number(response.headers.get('Content-Length'));
          track.length = Number.isSafeInteger(size) && size > 0 ? size : undefined;
        }
      } finally { await response.body?.cancel().catch(() => {}); }
    } catch (error) { if (!signal.aborted) abort.abort(error); throw error; }
  }));
  if (probes.some(result => result.status === 'rejected')) throw signal.reason;
  async function worker() {
    while (true) {
      signal.throwIfAborted();
      const job = next(); if (!job) return;
      const { track, start, end } = job;
      const url = new URL(track.url);
      const httpRange = track.site === 'bilibili';
      if (!httpRange) {
        if (end !== undefined) url.searchParams.set('range', `${start}-${end}`); else url.searchParams.delete('range');
      }
      const response = await request(url, httpRange && end !== undefined ? `bytes=${start}-${end}` : undefined);
      const range = response.headers.get('Content-Range');
      if (end !== undefined && (httpRange && response.status !== 206 || response.status === 206 && !range || range && range !== `bytes ${start}-${end}/${track.length}`)) {
        await response.body?.cancel().catch(() => {});
        throw new Error('视频服务器返回的分片位置不匹配，请重新下载。');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('视频服务器未返回有效数据。');
      const buffer = end === undefined ? undefined : new Uint8Array(end - start + 1);
      let count = 0;
      const write = async (data: Uint8Array<ArrayBuffer>, position: number) => {
        track.writes = track.writes.then(async () => { signal.throwIfAborted(); await track.write(data, position); onBytes(data.byteLength); });
        await track.writes;
      };
      try {
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          if (buffer) {
            if (count + value.byteLength > buffer.byteLength) throw new Error('视频服务器未按要求返回分片，已停止以避免生成损坏文件。');
            buffer.set(value, count);
          } else await write(value, count);
          count += value.byteLength;
        }
        if (!count || buffer && count !== buffer.byteLength || !buffer && track.length && count !== track.length) throw new Error('视频服务器返回了不完整的数据，请重试。');
        if (buffer) await write(buffer, start);
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    }
  }
  const results = await Promise.allSettled(Array.from({ length: DOWNLOAD_CONNECTIONS }, async () => {
    try { await worker(); }
    catch (error) { if (!signal.aborted) abort.abort(error); throw error; }
  }));
  if (results.some(result => result.status === 'rejected')) throw signal.reason;
}
