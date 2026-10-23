import { call, messageError, terminal } from './types';
import type { Choice, Task, VideoInfo } from './types';
import { labels } from './widget';
import { bytes, videoId, defaultChoice, progressPercent } from './core';

const get = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const error = get<HTMLParagraphElement>('#error');
const notice = get<HTMLParagraphElement>('#notice');
const title = get<HTMLHeadingElement>('#video-title');
const quality = get<HTMLSelectElement>('#quality');
const download = get<HTMLButtonElement>('#download');
const refresh = get<HTMLButtonElement>('#refresh');
get('#version').textContent = `版本 ${chrome.runtime.getManifest().version}`;
let tabId: number | undefined; let info: VideoInfo | undefined; let selected: Choice | undefined;
let tasks: Task[] = []; let busy = false;

function renderCurrent() {
  const task = tasks.find(value => value.videoId === info?.videoId);
  const active = tasks.some(value => !terminal(value.state));
  download.disabled = busy || active || !selected; quality.disabled = busy || active;
  download.querySelector('span')!.textContent = task && !terminal(task.state) ? labels[task.state] : selected?.videoItag ? `下载 ${selected.label}` : '下载音频';
  get('#task').hidden = !task;
  if (!task) return;
  const percent = progressPercent(task);
  get('#task-label').textContent = `${labels[task.state]}${task.state === 'downloading' ? ' · ' + (percent === undefined ? bytes(task.received) : percent + '%') : ''}`;
  get('#cancel').hidden = terminal(task.state);
  const progress = get<HTMLProgressElement>('#progress'); progress.hidden = terminal(task.state);
  if (task.state === 'downloading' && percent !== undefined) progress.value = percent; else progress.removeAttribute('value');
  get('#task-error').textContent = task.error || '';
}
function renderChoice() {
  quality.value = selected?.id || '';
  get('#format-hint').textContent = selected?.videoItag ? '包含声音 · 自动合并为一个文件' : '仅保存音频 · 保留原始音质';
  renderCurrent();
}
async function load() {
  if (busy || tabId === undefined) return;
  busy = true; refresh.disabled = true; get('#current').setAttribute('aria-busy', 'true');
  notice.removeAttribute('data-error'); notice.textContent = '正在读取视频和可用清晰度…';
  info = undefined; selected = undefined; get('#download-controls').hidden = true; renderCurrent();
  try {
    info = await call<VideoInfo>('info', { tabId }); selected = defaultChoice(info);
    title.textContent = info.title; title.title = info.title;
    const seconds = Math.floor(info.duration); const minutes = Math.floor(seconds / 60);
    get('#video-meta').textContent = `YouTube · ${minutes}:${String(seconds % 60).padStart(2, '0')}`;
    quality.replaceChildren();
    for (const [name, video] of [['视频（含声音）', true], ['仅音频', false]] as const) {
      const group = document.createElement('optgroup'); group.label = name;
      for (const choice of info.choices.filter(value => !!value.videoItag === video)) {
        const option = document.createElement('option'); option.value = choice.id;
        option.textContent = [choice.label, choice.container.toUpperCase(), choice.fps ? `${choice.fps} 帧` : '', choice.estimatedBytes ? `约 ${bytes(choice.estimatedBytes)}` : ''].filter(Boolean).join(' · ');
        group.append(option);
      }
      if (group.childElementCount) quality.append(group);
    }
    notice.textContent = ''; get('#download-controls').hidden = false; renderChoice();
    await history();
  } catch (value) {
    info = undefined; selected = undefined; notice.textContent = messageError(value); notice.setAttribute('data-error', '');
    title.textContent = '暂时无法读取视频'; get('#video-meta').textContent = '播放视频几秒后，点击「重新读取」';
  } finally { busy = false; refresh.disabled = false; get('#current').setAttribute('aria-busy', 'false'); renderCurrent(); }
}
void (async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { videoId(tab?.url || ''); tabId = tab.id; await load(); }
  catch {
    title.textContent = '先打开一个 YouTube 视频';
    notice.textContent = '在视频页面打开此扩展，或在下方粘贴视频链接。';
    refresh.hidden = true; get('#current').setAttribute('aria-busy', 'false'); get<HTMLDetailsElement>('#link-entry').open = true;
  }
})().catch(value => { error.textContent = messageError(value); });
refresh.addEventListener('click', () => void load());
quality.addEventListener('change', () => {
  selected = info?.choices.find(choice => choice.id === quality.value); renderChoice();
});
download.addEventListener('click', async () => {
  if (!info || !selected || busy) return;
  busy = true; error.textContent = ''; renderCurrent();
  try { await call<Task>('start', { tabId, videoId: info.videoId, choiceId: selected.id }); await history(); }
  catch (value) { error.textContent = messageError(value); }
  finally { busy = false; renderCurrent(); }
});
get('#cancel').addEventListener('click', async () => {
  const task = tasks.find(value => value.videoId === info?.videoId && !terminal(value.state));
  if (task) { try { await call('cancel', { id: task.id }); await history(); } catch (value) { error.textContent = messageError(value); } }
});
document.querySelector('form')!.addEventListener('submit', async event => {
  event.preventDefault(); error.textContent = '';
  try { await call('open', { url: get<HTMLInputElement>('#url').value.trim() }); window.close(); }
  catch (value) { error.textContent = messageError(value); }
});
async function history() {
  const list = get('#history');
  try {
    tasks = await call<Task[]>('list'); list.replaceChildren(); renderCurrent();
    get('#history-count').textContent = tasks.length ? `${tasks.length} 个任务` : '';
    if (!tasks.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '下载后可在这里查看进度和文件'; list.append(empty); return; }
    for (const task of tasks.slice(0, 5)) {
      const row = document.createElement('div'); row.className = 'record';
      const text = document.createElement('div');
      const name = document.createElement('div'); name.className = 'record-title'; name.textContent = task.filename || task.title; name.title = task.filename || task.title;
      const status = document.createElement('div'); status.className = 'record-status'; status.textContent = `${task.choice.label} · ${task.choice.container.toUpperCase()} · ${labels[task.state]}`;
      text.append(name, status); row.append(text);
      if (!terminal(task.state) || task.downloadId !== undefined && (task.state === 'completed' || !!task.filename)) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'record-action'; button.textContent = terminal(task.state) ? '显示文件' : '取消';
        button.addEventListener('click', () => void call(terminal(task.state) ? 'show' : 'cancel', { id: task.id, downloadId: task.downloadId }).then(history).catch(value => { error.textContent = messageError(value); }));
        row.append(button);
      }
      if (task.error) { const detail = document.createElement('div'); detail.className = 'record-error'; detail.textContent = task.error; row.append(detail); }
      list.append(row);
    }
  } catch (value) { error.textContent = messageError(value); }
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.tasks) void history(); });
void history();
