import { Player, Platform, Log } from 'youtubei.js/web';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import { SabrStream } from 'googlevideo/sabr-stream';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { Logger, LogLevel } from 'googlevideo/utils';
import type { SabrFormat } from 'googlevideo/shared-types';
import { mediaURL, choices, playbackMatches } from './core';
import { mergeTracks } from './media';
import { downloadParts } from './transfer';
import { messageError } from './types';
import type { Choice, PageSnapshot, PlaybackSession } from './types';

Log.setLevel(Log.Level.NONE);
Logger.getInstance().setLogLevels(LogLevel.NONE);
const control = new AbortController();
let sabr: SabrStream | undefined;
let refreshSession: ((session: PlaybackSession) => void) | undefined;
let received = 0;
let lastUpdate = 0;
function update(state: string, total?: number) {
  const now = Date.now();
  if (now - lastUpdate > 200 || state !== 'downloading') {
    lastUpdate = now; self.postMessage({ type: 'progress', state, received, total });
  }
}
async function decipher(snapshot: PageSnapshot) {
  const quickjs = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmLocation: new URL('quickjs.wasm', self.location.href).href }));
  Platform.shim.eval = async data => {
    const vm = quickjs.newContext();
    const deadline = Date.now() + 3000;
    vm.runtime.setMemoryLimit(64 * 1024 * 1024); vm.runtime.setMaxStackSize(1024 * 1024);
    vm.runtime.setInterruptHandler(() => control.signal.aborted || Date.now() > deadline);
    try {
      const value = vm.unwrapResult(vm.evalCode(`(function(){${data.output}\n})()`));
      try { return vm.dump(value); } finally { value.dispose(); }
    } finally { vm.dispose(); }
  };
  return Player.create(undefined, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://www.youtube.com');
    if (url.origin !== 'https://www.youtube.com' || !/^\/(?:iframe_api|s\/player\/)/.test(url.pathname)) throw new Error('播放器地址无效。');
    return fetch(url, { ...init, signal: control.signal, credentials: 'omit', redirect: 'error' });
  }, undefined, snapshot.playerUrl?.match(/\/s\/player\/([^/]+)\//)?.[1]);
}

async function run(snapshot: PageSnapshot, selected: Choice, session: PlaybackSession | undefined, taskId: string) {
  const choice = choices(snapshot).choices.find(item => item.id === selected.id);
  if (!choice) throw new Error('该清晰度已经失效，请重新获取视频格式。');
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(`yt-${taskId}`, { create: true });
  const signal = control.signal;
  async function pair(video: Promise<File> | undefined, audio: Promise<File> | undefined) {
    const settled = await Promise.allSettled([video, audio].map(value => value?.catch(error => { control.abort(error); sabr?.abort(); throw error; })));
    const failure = settled.find((value): value is PromiseRejectedResult => value.status === 'rejected');
    if (failure) throw signal.aborted ? signal.reason : failure.reason;
    return settled.map(value => value.status === 'fulfilled' ? value.value : undefined);
  }
  async function store(stream: ReadableStream<Uint8Array>, name: string) {
    const handle = await directory.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    const reader = stream.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        await writer.write(value as Uint8Array<ArrayBuffer>); received += value.byteLength;
        update('downloading', choice!.estimatedBytes);
      }
      signal.throwIfAborted(); await writer.close();
      return handle.getFile();
    } catch (error) {
      await writer.abort().catch(() => {});
      await reader.cancel().catch(() => {});
      throw error;
    } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  }
  try {
    update('resolving');
    const vf = snapshot.formats.find(format => format.itag === choice.videoItag);
    const af = snapshot.formats.find(format => format.itag === choice.audioItag);
    let video: File | undefined; let audio: File | undefined;
    // Reuse the browser's already transformed SABR URL and content-bound session.
    if (snapshot.sabrUrl && playbackMatches(snapshot, session)) {
      let activeSession: PlaybackSession = session;
      refreshSession = incoming => {
        if (!playbackMatches(snapshot, incoming)) return;
        activeSession = incoming;
        if (incoming.poToken) sabr?.setPoToken(incoming.poToken);
      };
      sabr = new SabrStream({
        serverAbrStreamingUrl: mediaURL(session.url), videoPlaybackUstreamerConfig: session.ustreamerConfig || snapshot.ustreamerConfig,
        poToken: session.poToken, clientInfo: session.clientInfo,
        durationMs: snapshot.duration * 1000,
        formats: snapshot.formats.map(format => ({ ...format, lastModified: format.lastModified || '0', approxDurationMs: Number(format.approxDurationMs || snapshot.duration * 1000), contentLength: Number(format.contentLength) || undefined })) as SabrFormat[],
        fetch: async (input, init) => {
          let body = init?.body;
          if (body instanceof Uint8Array) {
            const request = VideoPlaybackAbrRequest.decode(body);
            if (request.streamerContext) {
              const contexts = request.streamerContext.sabrContexts;
              for (const context of activeSession.contexts || []) if (!contexts.some(item => item.type === context.type)) contexts.push({ type: context.type, value: Uint8Array.from(atob(context.value), character => character.charCodeAt(0)) });
              if (activeSession.poToken) request.streamerContext.poToken = Uint8Array.from(atob(activeSession.poToken), character => character.charCodeAt(0));
              body = VideoPlaybackAbrRequest.encode(request).finish() as Uint8Array<ArrayBuffer>;
            }
          }
          return fetch(mediaURL(input instanceof Request ? input.url : String(input)), { ...init, body, signal, credentials: 'omit', redirect: 'error' });
        },
      });
      sabr.on('streamProtectionStatusUpdate', status => {
        if (status.status === 3) {
          control.abort(new Error('YouTube 要求重新验证播放会话。请在视频页面完成验证并播放几秒，然后重试。'));
          sabr?.abort();
        }
      });
      const streams = await sabr.start({ videoFormat: choice.videoItag, audioFormat: choice.audioItag, enabledTrackTypes: vf ? 0 : 1, maxRetries: 2, stallDetectionMs: 15000 });
      update('downloading', choice.estimatedBytes);
      [video, audio] = await pair(vf ? store(streams.videoStream, 'video') : undefined, store(streams.audioStream, 'audio'));
    } else {
      if (!vf?.url && !vf?.signatureCipher && !af?.url && !af?.signatureCipher) {
        throw new Error('请先播放几秒视频后重试，以获取当前播放会话。切换视频后需重新播放。');
      }
      const needsPlayer = [vf, af].some(format => format && (format.signatureCipher || format.cipher || (format.url && new URL(format.url).searchParams.has('n'))));
      const player = needsPlayer ? await decipher(snapshot) : undefined;
      const tracks: { kind: string; handle: FileSystemFileHandle; writer: FileSystemWritableFileStream; url: string; length: number }[] = [];
      try {
        for (const [format, kind] of [[vf, 'video'], [af, 'audio']] as const) {
          if (!format) continue;
          const value = player ? await player.decipher(format.url, format.signatureCipher, format.cipher) : format.url!;
          const url = mediaURL(value);
          const handle = await directory.getFileHandle(kind, { create: true });
          tracks.push({ kind, handle, writer: await handle.createWritable(), url, length: Number(format.contentLength) });
        }
        await downloadParts(tracks.map(track => ({ url: track.url, length: track.length,
          write: (data, position) => track.writer.write({ type: 'write', position, data }) })), signal, count => {
          received += count; update('downloading', choice.estimatedBytes);
        });
        for (const track of tracks) await track.writer.close();
        video = await tracks.find(track => track.kind === 'video')?.handle.getFile();
        audio = await tracks.find(track => track.kind === 'audio')?.handle.getFile();
      } catch (error) { await Promise.allSettled(tracks.map(track => track.writer.abort())); throw error; }
    }
    signal.throwIfAborted(); update('merging');
    const output = await directory.getFileHandle('output', { create: true });
    const writable = await output.createWritable();
    await mergeTracks(video, audio, choice.container, writable, signal, snapshot.duration);
    signal.throwIfAborted();
    self.postMessage({ type: 'ready', taskId });
  } catch (error) {
    control.abort(); sabr?.abort();
    await root.removeEntry(`yt-${taskId}`, { recursive: true }).catch(() => {});
    throw error;
  }
}
self.onmessage = (event: MessageEvent<{ type: string; snapshot: PageSnapshot; choice: Choice; session?: PlaybackSession; taskId: string }>) => {
  if (event.data.type === 'cancel') { control.abort(); sabr?.abort(); return; }
  if (event.data.type === 'session' && event.data.session) { refreshSession?.(event.data.session); return; }
  if (event.data.type !== 'run') return;
  const { snapshot, choice, session, taskId } = event.data;
  void run(snapshot, choice, session, taskId).catch(error => self.postMessage({ type: 'failed', error: messageError(error), cancelled: control.signal.aborted && (error instanceof DOMException && error.name === 'AbortError') }));
};
