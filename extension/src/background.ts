import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { videoId, videoTarget, choices, filename, mediaMime, matchesSavedName, BILIBILI_MEDIA_HOSTS, coverURL } from './core';
import { readPlayer } from './page';
import { readBilibili } from './bilibili';
import { call, messageError, terminal } from './types';
import type { Task, PlaybackSession, PageSnapshot, Reply } from './types';
import { collectionSource, batchEntries } from './batch-core';
import { readYouTubeCollection, browseYouTube, readBilibiliCollection } from './collections';
import { createQueue } from './queue';
import { readBilibiliUploads } from './bilibili-uploads';

const extensionOrigin = chrome.runtime.getURL('');
let creation: Promise<void> | undefined;
let changes = Promise.resolve();
async function serial<T>(operation: () => Promise<T>): Promise<T> {
  const value = changes.then(operation); changes = value.then(() => {}, () => {}); return value;
}
async function tasks(): Promise<Task[]> { return (await chrome.storage.local.get<{ tasks?: Task[] }>('tasks')).tasks || []; }
async function persist(values: Task[]) {
  const active = values.filter(task => !terminal(task.state));
  const ended = values.filter(task => terminal(task.state)).slice(0, 50);
  await chrome.storage.local.set({ tasks: [...active, ...ended].sort((a, b) => b.created - a.created) });
}
async function hasOffscreen() {
  return (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length > 0;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creation) creation = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS], justification: '在浏览器内下载、合并音视频，并在关闭弹窗后继续任务。' }).finally(() => { creation = undefined; });
  await creation;
}
async function cleanup(id: string) { if (await hasOffscreen()) await call('cleanup', { id }, 'offscreen'); }
async function reconcile() {
  const values = await tasks();
  const active = await hasOffscreen() ? await call<string[]>('active', {}, 'offscreen').catch(() => []) : [];
  for (const task of values.filter(task => !terminal(task.state))) {
    if (task.batch && task.state === 'queued') continue;
    if (active.includes(task.id)) continue;
    const item = task.downloadId ? (await chrome.downloads.search({ id: task.downloadId }))[0] : undefined;
    if (item?.state === 'complete') { task.state = 'completed'; continue; }
    if (item?.state === 'in_progress') await chrome.downloads.cancel(item.id).catch(() => {});
    task.state = 'failed'; task.error = '浏览器或扩展已重启，任务中断。请打开视频后重新下载。';
  }
  if (values.some(task => task.batch && task.state === 'queued')) await chrome.storage.local.set({ queuePaused: true });
  for (const task of values.filter(task => task.batch && terminal(task.state))) {
    const key = `queue-tab-${task.id}`; const tabId = (await chrome.storage.session.get(key))[key];
    if (typeof tabId === 'number') await chrome.tabs.remove(tabId).catch(() => {});
    await chrome.storage.session.remove(key);
  }
  // Populate older completed records once on startup. The muxed file size can
  // differ from the received source bytes, so use Chrome's saved-file metadata.
  await Promise.all(values.filter(task => task.state === 'completed' && task.fileSize === undefined && task.downloadId !== undefined).map(async task => {
    const item = (await chrome.downloads.search({ id: task.downloadId! }).catch(() => []))[0];
    if (item && Number.isFinite(item.fileSize) && item.fileSize >= 0) task.fileSize = item.fileSize;
  }));
  await persist(values);
}
const initialized = (async () => {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1], addRules: [{
    id: 1, priority: 1,
    action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders: [{ header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://www.bilibili.com/' }] },
    condition: { initiatorDomains: [chrome.runtime.id], requestDomains: BILIBILI_MEDIA_HOSTS,
      requestMethods: [chrome.declarativeNetRequest.RequestMethod.GET], resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST, chrome.declarativeNetRequest.ResourceType.MEDIA, chrome.declarativeNetRequest.ResourceType.OTHER] },
  }] });
  await reconcile();
})();

async function ensureControls(tabId: number) {
  try { await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'mount' }); }
  catch { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); }
}
chrome.runtime.onInstalled.addListener(() => {
  void chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://m.youtube.com/*', 'https://www.bilibili.com/*', 'https://m.bilibili.com/*', 'https://bilibili.com/*', 'https://space.bilibili.com/*'] }).then(tabs =>
    Promise.allSettled(tabs.filter(tab => tab.id !== undefined && !tab.discarded).map(tab => ensureControls(tab.id!))));
});

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0 || details.method !== 'POST' || !details.requestBody?.raw) return;
  const chunks = details.requestBody.raw.map(item => item.bytes).filter((bytes): bytes is ArrayBuffer => !!bytes);
  const size = chunks.reduce((sum, item) => sum + item.byteLength, 0);
  if (!size || size > 1024 * 1024) return;
  try {
    const bytes = new Uint8Array(size); let offset = 0;
    chunks.forEach(chunk => { bytes.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; });
    const request = VideoPlaybackAbrRequest.decode(bytes);
    if (!request.streamerContext?.clientInfo || !request.videoPlaybackUstreamerConfig) return;
    const base64 = (value: Uint8Array) => { let raw = ''; for (const byte of value) raw += String.fromCharCode(byte); return btoa(raw); };
    void chrome.tabs.get(details.tabId).then(async tab => {
      const prior = (await chrome.storage.session.get(`playback-${details.tabId}`))[`playback-${details.tabId}`] as PlaybackSession | undefined;
      const id = videoId(tab.url || '');
      const session: PlaybackSession = {
        videoId: id, capturedAt: details.timeStamp, url: details.url,
        poToken: request.streamerContext?.poToken?.length ? base64(request.streamerContext.poToken) : prior?.videoId === id ? prior.poToken : undefined,
        clientInfo: request.streamerContext!.clientInfo, ustreamerConfig: base64(request.videoPlaybackUstreamerConfig!),
        contexts: request.streamerContext!.sabrContexts.filter(item => item.type !== undefined && item.value).map(item => ({ type: item.type!, value: base64(item.value!) })),
      };
      await chrome.storage.session.set({ [`playback-${details.tabId}`]: session });
      void chrome.runtime.sendMessage({ target: 'offscreen', type: 'session', session }).catch(() => {});
    }).catch(() => {});
  } catch { /* Non-SABR video requests are not playback sessions. */ }
  return undefined;
}, { urls: ['https://*.googlevideo.com/videoplayback*'] }, ['requestBody']);
chrome.tabs.onRemoved.addListener(id => { void chrome.storage.session.remove(`playback-${id}`); });

const directSources = new Map<number, { videoId: string; expires: number; source: Promise<PageSnapshot> }>();
chrome.tabs.onRemoved.addListener(id => directSources.delete(id));
async function snapshot(tabId: number, direct = false): Promise<PageSnapshot> {
  const tab = await chrome.tabs.get(tabId);
  const target = videoTarget(tab.url || '');
  const [result] = target.site === 'bilibili'
    ? await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readBilibili, args: [target.identity, target.part] })
    : await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readPlayer, args: [target.identity, direct] });
  if (!result?.result) throw new Error('无法读取视频，请刷新视频页面后重试。');
  if (videoTarget((await chrome.tabs.get(tabId)).url || '').videoId !== target.videoId) throw new Error('视频或分 P 已切换，请重新读取清晰度。');
  return result.result;
}
async function downloadSource(tabId: number): Promise<PageSnapshot> {
  const native = await snapshot(tabId);
  choices(native); // Preserve native login, live and unavailable-video checks.
  if (native.site === 'bilibili') return native;
  const needsSource = !!native.sabrUrl || native.formats.some(format => !format.drmFamilies?.length && !format.drmTrackType && !format.url && !format.signatureCipher && !format.cipher);
  if (!needsSource) return native;
  const cached = directSources.get(tabId);
  if (cached?.videoId === native.videoId && cached.expires > Date.now()) return cached.source;
  const source = snapshot(tabId, true).then(value => {
    choices(value);
    return value;
  }).catch(() => {
    directSources.delete(tabId);
    return native; // Native playback remains usable when this client is unavailable.
  });
  directSources.set(tabId, { videoId: native.videoId, expires: Date.now() + 5 * 60_000, source });
  return source;
}
async function runTask(task: Task, source: PageSnapshot, tabId: number) {
  await ensureOffscreen();
  const session = (await chrome.storage.session.get(`playback-${tabId}`))[`playback-${tabId}`] as PlaybackSession | undefined;
  await call('run', { task, snapshot: source, session }, 'offscreen');
}
const queue = createQueue({ serial, tasks, persist, source: downloadSource, run: runTask });
async function collection(input: unknown, token: unknown) {
  const source = collectionSource(String(input));
  if (token !== undefined && (typeof token !== 'string' || token.length > 20000)) throw new Error('分页标识无效。');
  if (source.site === 'bilibili') {
    if (token !== undefined && !/^[1-9]\d{0,5}$/.test(String(token))) throw new Error('分页标识无效。');
    const value = source.kind === 'channel' ? await readBilibiliUploads(source.url, token ? Number(token) : 1)
      : await readBilibiliCollection(source, token ? Number(token) : 1);
    return { ...value, entries: batchEntries(value.entries) };
  }
  const value = await readYouTubeCollection(source.url, token as string | undefined, async (context, continuation) => {
    const tabs = (await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://m.youtube.com/*'] })).filter(tab => tab.id !== undefined && !tab.discarded);
    const tab = tabs.find(tab => tab.url === source.url) || tabs[0];
    if (!tab) throw new Error('加载更多需要 YouTube 页面会话，请保持原 YouTube 页面打开后重试。');
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, world: 'MAIN', func: browseYouTube, args: [context, continuation] });
    if (!result?.result) throw new Error('无法读取下一页，请确认 YouTube 页面已加载后重试。');
    if (result.result.error) throw new Error(result.result.error);
    return result.result.data;
  });
  return { ...value, entries: batchEntries(value.entries) };
}
async function tabFor(sender: chrome.runtime.MessageSender, requested?: unknown) {
  const pageTab = sender.url?.startsWith(extensionOrigin) ? undefined : sender.tab?.id;
  const id = pageTab ?? (typeof requested === 'number' ? requested : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
  if (id === undefined) throw new Error('请先打开一个 YouTube 或 Bilibili 视频。');
  return id;
}
const progressRank = { queued: 0, resolving: 1, downloading: 2, merging: 3, saving: 4 };
// Suggest after Chrome has inferred MIME/its tentative blob name. Restrict the
// override to this extension's active save, leaving all other downloads alone.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id || !item.url.startsWith(`blob:${extensionOrigin}`)) { suggest(); return; }
  void tasks().then(values => {
    const task = values.find(value => value.state === 'saving' && (value.downloadId === undefined || value.downloadId === item.id));
    suggest(task ? { filename: filename(task.title, task.choice.container), conflictAction: 'uniquify' } : undefined);
  }, () => suggest());
  return true;
});
async function finishDownload(id: number, state: string, error?: string) {
  const values = await tasks(); const task = values.find(item => item.downloadId === id);
  if (!task || terminal(task.state)) return;
  if (state === 'complete') {
    const item = (await chrome.downloads.search({ id }))[0];
    task.filename = item?.filename.split(/[\\/]/).pop();
    if (item && Number.isFinite(item.fileSize) && item.fileSize >= 0) task.fileSize = item.fileSize;
    if (!task.filename || !matchesSavedName(task.filename, task.title, task.choice.container)) {
      task.state = 'failed'; task.error = `保存文件名与视频标题或格式不符：${task.filename || '未知文件名'}。预期为 ${filename(task.title, task.choice.container)}，请检查浏览器下载设置或其他下载扩展。`;
    } else task.state = 'completed';
  }
  else if (state === 'interrupted') { task.state = error === 'USER_CANCELED' ? 'cancelled' : 'failed'; task.error = error ? `文件保存中断：${error}` : '文件保存中断。'; }
  else return;
  await persist(values); await cleanup(task.id); await queue.settled(task.id);
}
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current) void serial(async () => { await initialized; await finishDownload(delta.id, delta.state!.current!, delta.error?.current); });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!message || typeof message !== 'object' || sender.id !== chrome.runtime.id) return;
  const data = message as Record<string, unknown>;
  if (data.target !== 'background' || typeof data.type !== 'string') return;
  const internal = sender.url?.startsWith(extensionOrigin) === true;
  const executor = sender.url === chrome.runtime.getURL('offscreen.html');
  const allowed = internal || (sender.url && /^https:\/\/(?:(?:www|m)\.youtube\.com|(?:(?:www|m|space)\.)?bilibili\.com)\//.test(sender.url));
  if (!allowed) return;
  const execute = async () => {
    await initialized;
    if (data.type === 'info') {
      const tabId = await tabFor(sender, data.tabId);
      // Also repair tabs opened before installation or extension reload.
      videoTarget((await chrome.tabs.get(tabId)).url || '');
      await ensureControls(tabId);
      return choices(await downloadSource(tabId));
    }
    if (data.type === 'list') return tasks();
    if (data.type === 'batch-open') {
      const source = collectionSource(String(data.url));
      if (!internal && collectionSource((await chrome.tabs.get(await tabFor(sender))).url || '').url !== source.url) throw new Error('列表页面已切换，请重试。');
      await chrome.tabs.create({ url: chrome.runtime.getURL(`batch.html?source=${encodeURIComponent(source.url)}`) }); return null;
    }
    if (data.type === 'collection' && internal) return collection(data.url, data.continuation);
    if (data.type === 'enqueue' && internal) return queue.enqueue(data.entries, data.quality);
    if (data.type === 'queue-control' && internal) return queue.control(data.action);
    if (data.type === 'retry' && internal) return queue.retry(data.id);
    if (data.type === 'open' && internal) {
      const target = videoTarget(String(data.url)); await chrome.tabs.create({ url: target.url }); return null;
    }
    if (data.type === 'show' && internal) { if (typeof data.downloadId !== 'number') throw new Error('无效文件。'); await chrome.downloads.show(data.downloadId); return null; }
    return serial(async () => {
      const values = await tasks();
      if (data.type === 'start') {
        if (values.some(task => !terminal(task.state))) throw new Error('已有下载任务正在进行，请完成或取消后再开始。');
        const tabId = await tabFor(sender, data.tabId); const source = await downloadSource(tabId);
        if (source.videoId !== data.videoId) throw new Error('视频已经切换，请重新选择清晰度。');
        const choice = choices(source).choices.find(item => item.id === data.choiceId);
        if (!choice) throw new Error('该清晰度不可用，请刷新列表。');
        const task: Task = { id: crypto.randomUUID(), site: source.site || 'youtube', videoId: source.videoId, title: source.title, thumbnail: coverURL(source.thumbnail, source.site, source.videoId), choice, state: 'queued', created: Date.now(), received: 0 };
        values.unshift(task); await persist(values);
        try {
          await runTask(task, source, tabId);
        } catch (error) { task.state = 'failed'; task.error = messageError(error); await persist(values); throw error; }
        return task;
      }
      const task = values.find(item => item.id === data.id);
      if (!task) throw new Error('任务不存在。');
      if (data.type === 'cancel') {
        if (terminal(task.state)) return null;
        task.state = 'cancelled'; await persist(values);
        if (task.downloadId !== undefined) await chrome.downloads.cancel(task.downloadId).catch(() => {});
        await cleanup(task.id); await queue.settled(task.id); return null;
      }
      if (!executor) throw new Error('无效的内部任务消息。');
      if (terminal(task.state)) return null;
      if (data.type === 'progress') {
        const next = data.state as keyof typeof progressRank;
        if (['resolving', 'downloading', 'merging'].includes(next) && progressRank[next] >= (progressRank[task.state as keyof typeof progressRank] ?? 99)) task.state = next;
        if (typeof data.received === 'number' && Number.isFinite(data.received)) task.received = Math.max(task.received, data.received);
        if (typeof data.total === 'number' && data.total > 0) task.total = data.total;
      } else if (data.type === 'failure') {
        task.state = 'failed'; task.error = String(data.error).slice(0, 500);
        for (const [tabId, cached] of directSources) if (cached.videoId === task.videoId) directSources.delete(tabId);
        await persist(values); await cleanup(task.id); await queue.settled(task.id); return null;
      }
      else if (data.type === 'save') {
        if (typeof data.blob !== 'string' || !data.blob.startsWith(`blob:${extensionOrigin}`)) throw new Error('无效的文件地址。');
        // Blob URLs support GET, not HEAD. Inspect the header and cancel the
        // body immediately, without reading the completed video into memory.
        const file = await fetch(data.blob);
        const mime = file.headers.get('Content-Type')?.split(';')[0];
        await file.body?.cancel();
        if (mime !== mediaMime(task.choice)) throw new Error('保存文件的媒体类型异常，已停止保存以避免生成 .txt 文件。请重新加载扩展后重试。');
        task.state = 'saving'; await persist(values);
        task.downloadId = await chrome.downloads.download({ url: data.blob, filename: filename(task.title, task.choice.container), saveAs: false, conflictAction: 'uniquify' });
        await persist(values);
        const saved = (await chrome.downloads.search({ id: task.downloadId }))[0];
        if (saved && saved.state !== 'in_progress') await finishDownload(saved.id, saved.state, saved.error);
        return null;
      } else throw new Error('未知任务消息。');
      await persist(values); return null;
    });
  };
  void execute().then(value => respond({ ok: true, value } satisfies Reply<unknown>), error => respond({ ok: false, error: messageError(error) } satisfies Reply<unknown>));
  return true;
});
