import { call, messageError } from './types';
import { filename, mediaMime } from './core';
import type { Task, PageSnapshot, PlaybackSession } from './types';

const workers = new Map<string, Worker>();
const videos = new Map<string, string>();
const blobs = new Map<string, string>();
const ownOrigin = location.origin + '/';
const startupCleanup = (async () => {
  const root = await navigator.storage.getDirectory();
  for await (const [name] of root.entries()) {
    if (/^yt-[0-9a-f-]{36}$/.test(name)) await root.removeEntry(name, { recursive: true });
  }
})();
async function cleanup(id: string) {
  workers.get(id)?.terminate(); workers.delete(id); videos.delete(id);
  const url = blobs.get(id); if (url) URL.revokeObjectURL(url); blobs.delete(id);
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(`yt-${id}`, { recursive: true }).catch(() => {});
}
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!message || typeof message !== 'object' || sender.id !== chrome.runtime.id || !sender.url?.startsWith(ownOrigin)) return;
  const data = message as { target: string; type: string; task: Task; snapshot: PageSnapshot; session?: PlaybackSession; id: string };
  if (data.target !== 'offscreen') return;
  const execute = async () => {
    await startupCleanup;
    if (data.type === 'active') return [...workers.keys(), ...blobs.keys()];
    if (data.type === 'session' && data.session) {
      for (const [id, worker] of workers) if (videos.get(id) === data.session.videoId) worker.postMessage({ type: 'session', session: data.session });
      return null;
    }
    if (data.type === 'cleanup') { await cleanup(data.id); return null; }
    if (data.type === 'cancel') { await cleanup(data.id); return null; }
    if (data.type !== 'run') throw new Error('未知任务指令。');
    const { task } = data;
    const worker = new Worker(new URL('engine.js', location.href), { type: 'module' });
    workers.set(task.id, worker);
    videos.set(task.id, task.videoId);
    let updates = Promise.resolve();
    worker.onmessage = event => {
      updates = updates.then(async () => {
        const value = event.data;
        if (!workers.has(task.id)) return;
        if (value.type === 'progress') {
          await call('progress', { id: task.id, state: value.state, received: value.received, total: value.total });
        } else if (value.type === 'ready') {
          const root = await navigator.storage.getDirectory();
          const directory = await root.getDirectoryHandle(`yt-${task.id}`);
          const file = await (await directory.getFileHandle('output')).getFile();
          if (!workers.has(task.id)) return;
          // OPFS files have no MIME type. An untyped blob is treated as text by
          // Chrome downloads, which can replace the requested media extension.
          const media = new File([file], filename(task.title, task.choice.container), { type: mediaMime(task.choice) });
          const blob = URL.createObjectURL(media); blobs.set(task.id, blob);
          await call('save', { id: task.id, blob });
          worker.terminate(); workers.delete(task.id); videos.delete(task.id);
        } else if (value.type === 'failed') {
          await call('failure', { id: task.id, error: value.error }); await cleanup(task.id);
        }
      }).catch(async error => { await call('failure', { id: task.id, error: messageError(error) }).catch(() => {}); await cleanup(task.id); });
    };
    worker.onerror = event => { void call('failure', { id: task.id, error: event.message || '下载工作线程意外停止。' }).finally(() => cleanup(task.id)); };
    worker.postMessage({ type: 'run', snapshot: data.snapshot, choice: task.choice, session: data.session, taskId: task.id });
    return null;
  };
  void execute().then(value => respond({ ok: true, value }), error => respond({ ok: false, error: messageError(error) }));
  return true;
});
