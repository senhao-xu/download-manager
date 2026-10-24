import { call, messageError, terminal } from './types';
import type { BatchEntry, CollectionPage, Task } from './types';
import { collectionSource, QUEUE_LIMIT } from './batch-core';
import { bytes, coverURL, progressPercent, taskSize } from './core';
import { labels } from './widget';

const get = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const error = get('#error');
const status = get('#source-status');
const input = get<HTMLInputElement>('#source-url');
const entries = new Map<string, BatchEntry>();
const selected = new Set<string>();
const entryMetadata = new Map<string, HTMLElement>();
let queueTasks: Task[] = [];
let source = ''; let continuation: string | undefined; let loading = false;
get('#version').textContent = `版本 ${chrome.runtime.getManifest().version}`;
function cover(videoId: string, value?: string) {
  const frame = document.createElement('span'); frame.className = 'cover'; frame.textContent = '暂无封面';
  const url = coverURL(value, videoId.startsWith('bilibili:') ? 'bilibili' : 'youtube', videoId);
  if (url) {
    const image = document.createElement('img'); image.alt = '视频封面'; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.src = url;
    image.addEventListener('error', () => image.remove()); frame.append(image);
  }
  return frame;
}
function resolution(task: Task) {
  const choice = task.choice;
  if (choice.id === 'pending') return '下载时读取';
  if (choice.videoItag === undefined) return '仅音频';
  return choice.width && choice.height ? `${choice.width}×${choice.height}` : choice.height ? `${choice.height}p` : choice.label;
}
function updateEntryMetadata() {
  for (const [id, label] of entryMetadata) {
    const task = queueTasks.find(task => task.videoId === id && task.choice.id !== 'pending');
    const size = task?.state === 'completed' ? task.fileSize !== undefined ? bytes(task.fileSize) : '未知' : task?.choice.estimatedBytes ? `约 ${bytes(task.choice.estimatedBytes)}` : '下载时估算';
    label.textContent = `分辨率：${task ? resolution(task) : '下载时读取'} · 大小：${size}`;
  }
}
function selectionCount() {
  get('#selection-count').textContent = `已选 ${selected.size} / ${entries.size}`;
  get<HTMLButtonElement>('#enqueue').disabled = loading || !selected.size;
}
function renderEntries() {
  const list = get('#entries'); list.replaceChildren(); entryMetadata.clear();
  for (const entry of entries.values()) {
    const row = document.createElement('label'); row.className = 'entry';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(entry.videoId);
    check.addEventListener('change', () => { if (check.checked) selected.add(entry.videoId); else selected.delete(entry.videoId); selectionCount(); });
    const text = document.createElement('span'); text.className = 'entry-info';
    const name = document.createElement('span'); name.className = 'entry-title'; name.textContent = entry.title;
    const metadata = document.createElement('span'); metadata.className = 'entry-meta'; entryMetadata.set(entry.videoId, metadata);
    text.append(name, metadata); row.append(check, cover(entry.videoId, entry.thumbnail), text); list.append(row);
  }
  get('#selection').hidden = !entries.size && !continuation;
  get('#more').hidden = !continuation || entries.size >= QUEUE_LIMIT;
  selectionCount();
  updateEntryMetadata();
}
async function read(more = false) {
  if (loading) return;
  loading = true; error.textContent = ''; status.textContent = '正在读取列表…';
  get<HTMLButtonElement>('#read').disabled = true; get<HTMLButtonElement>('#more').disabled = true;
  try {
    if (!more) {
      source = collectionSource(input.value.trim()).url;
      entries.clear(); selected.clear(); continuation = undefined; renderEntries();
    }
    const page = await call<CollectionPage>('collection', { url: source, continuation: more ? continuation : undefined });
    for (const entry of page.entries) {
      if (entries.size >= QUEUE_LIMIT) break;
      // Preserve existing deselections when consecutive pages overlap.
      if (!entries.has(entry.videoId)) { entries.set(entry.videoId, entry); selected.add(entry.videoId); }
    }
    continuation = page.continuation;
    get('#source-title').textContent = page.title;
    status.textContent = entries.size >= QUEUE_LIMIT && continuation ? `已达到单次 ${QUEUE_LIMIT} 项上限。` : continuation ? '还有更多视频，可继续加载。' : '已读完此列表。';
    renderEntries();
  } catch (value) { status.textContent = ''; error.textContent = messageError(value); }
  finally { loading = false; get<HTMLButtonElement>('#read').disabled = false; get<HTMLButtonElement>('#more').disabled = false; selectionCount(); }
}
get('#source-form').addEventListener('submit', event => { event.preventDefault(); void read(); });
get('#more').addEventListener('click', () => void read(true));
get('#select-all').addEventListener('click', () => { entries.forEach(entry => selected.add(entry.videoId)); renderEntries(); });
get('#select-none').addEventListener('click', () => { selected.clear(); renderEntries(); });
get('#enqueue').addEventListener('click', async () => {
  if (loading || !selected.size) return;
  loading = true; selectionCount(); error.textContent = '';
  try {
    const count = await call<number>('enqueue', { entries: [...selected].map(id => entries.get(id)), quality: get<HTMLSelectElement>('#batch-quality').value });
    status.textContent = `已加入 ${count} 个任务，已在等待或下载中的视频会自动跳过。`; selected.clear(); renderEntries(); await renderQueue();
  } catch (value) { error.textContent = messageError(value); }
  finally { loading = false; selectionCount(); }
});
for (const [id, action] of [['pause', 'pause'], ['resume', 'resume'], ['clear', 'clear']]) {
  get(`#${id}`).addEventListener('click', () => void call('queue-control', { action }).then(renderQueue).catch(value => { error.textContent = messageError(value); }));
}
let queueRendering = false; let queueDirty = false;
async function renderQueue() {
  if (queueRendering) { queueDirty = true; return; }
  queueRendering = true;
  try {
    const [tasks, settings] = await Promise.all([call<Task[]>('list'), chrome.storage.local.get('queuePaused')]);
    queueTasks = tasks; updateEntryMetadata();
    const pending = tasks.filter(task => !terminal(task.state));
    get('#queue-count').textContent = `${pending.length} 个未完成 · ${tasks.filter(task => task.state === 'completed').length} 个已完成`;
    get('#queue-state').textContent = settings.queuePaused ? '后续任务已暂停；当前下载继续。' : pending.length ? '队列运行中' : '暂无等待任务';
    get<HTMLButtonElement>('#pause').disabled = !!settings.queuePaused || !pending.length;
    get<HTMLButtonElement>('#resume').disabled = !settings.queuePaused;
    const list = get('#queue'); list.replaceChildren();
    const ordered = [...pending.filter(task => task.state !== 'queued'), ...pending.filter(task => task.state === 'queued').reverse(), ...tasks.filter(task => terminal(task.state))];
    if (!ordered.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '选好视频后加入队列，即可在这里查看进度'; list.append(empty); }
    for (const task of ordered) {
      const row = document.createElement('div'); row.className = 'record'; row.dataset.id = task.id;
      const content = document.createElement('div'); content.className = 'record-info';
      const title = document.createElement('div'); title.className = 'record-title'; title.textContent = task.filename || task.title;
      const percent = progressPercent(task);
      const detail = document.createElement('div'); detail.className = 'record-status'; detail.textContent = `${labels[task.state]} · ${task.choice.label}${percent !== undefined ? ` · ${percent}%` : ''}`;
      content.append(title, detail);
      const dimensions = document.createElement('div'); dimensions.className = 'record-resolution'; dimensions.textContent = `分辨率：${resolution(task)}${task.choice.id !== 'pending' ? ` · ${task.choice.container.toUpperCase()}` : ''}`; content.append(dimensions);
      if (!terminal(task.state) && task.state !== 'queued') {
        const bar = document.createElement('progress'); bar.max = 100; bar.setAttribute('aria-label', `${task.title}下载进度`);
        if (percent !== undefined) bar.value = percent; content.append(bar);
      }
      const size = document.createElement('div'); size.className = 'record-size'; size.textContent = task.state === 'queued' ? '大小：下载时估算' : taskSize(task); content.append(size);
      row.append(cover(task.videoId, task.thumbnail), content);
      const actions = document.createElement('div'); actions.className = 'actions';
      const add = (text: string, type: string, data: Record<string, unknown>) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'record-action'; button.textContent = text;
        button.addEventListener('click', () => { button.disabled = true; void call(type, data).then(renderQueue).catch(value => { error.textContent = messageError(value); button.disabled = false; }); });
        actions.append(button);
      };
      if (!terminal(task.state)) add('取消', 'cancel', { id: task.id });
      if (task.batch && ['failed', 'cancelled'].includes(task.state)) add('重试', 'retry', { id: task.id });
      if (task.downloadId !== undefined && task.filename) add('显示文件', 'show', { downloadId: task.downloadId });
      row.append(actions);
      if (task.error) { const reason = document.createElement('div'); reason.className = 'record-error'; reason.textContent = task.error; row.append(reason); }
      list.append(row);
    }
  } catch (value) { error.textContent = messageError(value); }
  finally { queueRendering = false; if (queueDirty) { queueDirty = false; void renderQueue(); } }
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.tasks || changes.queuePaused)) void renderQueue(); });
void renderQueue();
const initial = new URL(location.href).searchParams.get('source');
if (initial) { input.value = initial; void read(); }
