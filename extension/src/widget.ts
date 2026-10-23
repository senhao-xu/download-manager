import { bytes, defaultChoice, progressPercent } from './core';
import { call, messageError, terminal } from './types';
import type { Choice, VideoInfo, Task } from './types';

export const labels: Record<Task['state'], string> = { queued: '等待下载', resolving: '准备下载', downloading: '正在下载', merging: '正在合并音画', saving: '正在保存文件', completed: '已完成', failed: '下载失败', cancelled: '已取消' };
const styles = `
:host{display:inline-flex!important;flex:0 0 auto!important;min-width:max-content;font:500 14px/1.5 Roboto,Arial,"Microsoft YaHei",sans-serif;--bg:#fff;--fg:#0f0f0f;--sub:#606060;--soft:#f2f2f2;--line:#ddd;color:var(--fg);vertical-align:middle}
:host([hidden]){display:none!important}
:host([data-floating]){position:fixed;right:24px;bottom:24px;z-index:2147483646;filter:drop-shadow(0 2px 8px #0004)}
:host([data-anchored]){position:absolute!important;left:var(--yt-anchor-left)!important;top:var(--yt-anchor-top)!important;z-index:10}
:host([data-dark]){--bg:#202020;--fg:#f1f1f1;--sub:#aaa;--soft:#333;--line:#454545}
*{box-sizing:border-box}[hidden]{display:none!important}button{font:inherit;cursor:pointer;color:inherit}button:disabled{cursor:default;opacity:.6}button:focus-visible{outline:2px solid #3ea6ff;outline-offset:2px}
.split{position:relative;display:inline-flex;overflow:hidden;white-space:nowrap;border-radius:24px;background:var(--fg);color:var(--bg);margin:0 6px}.main,.toggle{border:0;background:transparent;color:inherit;padding:9px 14px;min-height:38px}.main{border-radius:24px 0 0 24px}.toggle{border-radius:0 24px 24px 0;border-left:1px solid var(--sub);padding:9px 11px}.main:hover,.toggle:hover{opacity:.8}.split .inline-progress{position:absolute;left:0;bottom:0;width:100%;height:4px;margin:0;accent-color:#f03;background:#8885}.inline-progress::-webkit-progress-bar{background:#8885}.inline-progress::-webkit-progress-value{background:#f03}
.menu{inset:unset;margin:0;border:1px solid var(--line);border-radius:14px;padding:0;background:var(--bg);color:var(--fg);width:340px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow-y:auto;box-shadow:0 6px 24px #0003;font:400 14px/1.5 Roboto,Arial,"Microsoft YaHei",sans-serif}.heading{display:flex;justify-content:space-between;align-items:center;padding:13px 16px;gap:10px}.heading strong{font-weight:500}.quiet{color:var(--sub);font-size:12px}.refresh{border:0;background:transparent;color:var(--sub);padding:4px 0}.options{max-height:350px;overflow-y:auto}.option{width:100%;display:grid;grid-template-columns:18px 1fr auto;gap:9px;align-items:center;text-align:left;padding:10px 16px;background:transparent;border:0;font-weight:400}.option:hover,.option[aria-pressed=true]{background:var(--soft)}.check{visibility:hidden}.option[aria-pressed=true] .check{visibility:visible}.detail{display:block;font-size:12px;color:var(--sub);margin-top:1px}.foot{padding:10px 16px;border-top:1px solid var(--line);font-size:12px;color:var(--sub)}.notice{padding:12px 16px;color:var(--sub);overflow-wrap:anywhere;font-weight:400}.notice:empty{display:none}.status{display:none;padding:10px 16px;border-top:1px solid var(--line);font-weight:400}.status.visible{display:block}.status-line{display:flex;justify-content:space-between;gap:12px;align-items:center}.cancel{border:0;background:transparent;color:var(--fg);padding:3px 0;text-decoration:underline;white-space:nowrap}progress{display:block;width:100%;height:5px;margin:10px 0 2px;accent-color:var(--fg);border:0}.task-error{font-size:12px;color:var(--sub);margin-top:5px;overflow-wrap:anywhere}.task-error:empty{display:none}.video-title{font-weight:500;padding:0 16px 10px;overflow-wrap:anywhere}.video-title:empty{display:none}
`;

export function createCollectionWidget(host: HTMLElement, url: string) {
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${styles}.main{border-radius:24px}.notice{position:absolute;right:0;bottom:48px;width:280px;border:1px solid var(--line);border-radius:10px;background:var(--bg);box-shadow:0 4px 16px #0002}</style><div class="split"><button type="button" class="main" aria-label="批量下载此列表">↓ 批量下载</button></div><div class="notice" role="alert" hidden></div>`;
  const button = root.querySelector<HTMLButtonElement>('button')!;
  const notice = root.querySelector<HTMLDivElement>('.notice')!;
  let disposed = false;
  button.addEventListener('click', async () => {
    button.disabled = true; notice.hidden = true;
    try { await call('batch-open', { url }); }
    catch (error) { if (!disposed) { notice.textContent = messageError(error); notice.hidden = false; } }
    finally { if (!disposed) button.disabled = false; }
  });
  return { setHidden(hidden: boolean) { host.hidden = hidden; if (hidden) notice.hidden = true; }, destroy() { disposed = true; host.remove(); } };
}

export function createWidget(host: HTMLElement, tabId?: number) {
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${styles}</style><div class="split"><button type="button" class="main" aria-label="下载当前视频">↓ <span>下载</span></button><button type="button" class="toggle" aria-label="选择下载清晰度" aria-expanded="false">▾</button><progress class="inline-progress" max="100" aria-label="下载进度" hidden></progress></div><div class="menu" popover="auto"><div class="heading"><strong>下载到本机</strong><button type="button" class="refresh">刷新格式</button></div><div class="video-title"></div><div class="notice" role="status"></div><div class="options" role="group" aria-label="可用下载清晰度"></div><div class="status"><div class="status-line"><span class="task-label"></span><button type="button" class="cancel">取消</button></div><progress max="100" aria-label="任务进度"></progress><div class="task-error"></div></div><div class="foot">视频选项包含声音，自动合并为一个文件</div></div>`;
  const get = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
  const main = get<HTMLButtonElement>('.main'); const toggle = get<HTMLButtonElement>('.toggle');
  const menu = get<HTMLDivElement>('.menu'); const notice = get<HTMLDivElement>('.notice');
  // A native invoker prevents light-dismiss on pointerdown from hiding the
  // popover just before a custom click handler would open it again.
  toggle.popoverTargetElement = menu;
  const options = get<HTMLDivElement>('.options'); const title = get<HTMLDivElement>('.video-title');
  let info: VideoInfo | undefined; let selected: Choice | undefined; let busy = false; let disposed = false; let task: Task | undefined;
  let loading: Promise<void> | undefined; let loadError = '';
  const retryDelays = [1000, 2000, 4000, 8000];
  let retryAttempt = 0; let retryTimer: ReturnType<typeof setTimeout> | undefined;
  function position() {
    const rect = host.getBoundingClientRect();
    menu.style.left = `${Math.max(12, Math.min(rect.right - 340, window.innerWidth - Math.min(340, window.innerWidth - 24) - 12))}px`;
    const height = menu.getBoundingClientRect().height;
    const top = rect.bottom + 8 + height <= window.innerHeight - 12 ? rect.bottom + 8 : rect.top - height - 8;
    menu.style.top = `${Math.max(12, Math.min(top, window.innerHeight - height - 12))}px`;
  }
  function open() { if (disposed || host.hidden) return; menu.showPopover(); toggle.setAttribute('aria-expanded', 'true'); position(); }
  menu.addEventListener('toggle', () => {
    const visible = menu.matches(':popover-open');
    toggle.setAttribute('aria-expanded', String(visible));
    if (visible) position();
  });
  function renderChoices() {
    options.replaceChildren();
    for (const choice of info?.choices || []) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'option';
      row.setAttribute('aria-pressed', String(choice.id === selected?.id));
      const check = document.createElement('span'); check.className = 'check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.textContent = choice.label;
      const detail = document.createElement('span'); detail.className = 'detail'; detail.textContent = `${choice.fps ? choice.fps + '帧 · ' : ''}${choice.container.toUpperCase()}${choice.videoItag ? ' · 含声音' : ''}`; name.append(detail);
      const size = document.createElement('span'); size.className = 'quiet'; size.textContent = choice.estimatedBytes ? `约 ${bytes(choice.estimatedBytes)}` : '大小未知';
      row.append(check, name, size);
      row.addEventListener('click', () => {
        selected = choice; notice.textContent = '';
        renderChoices(); renderTask();
        menu.hidePopover(); main.focus({ preventScroll: true });
      });
      options.append(row);
    }
  }
  function renderTask() {
    const active = task && !terminal(task.state);
    const percent = task && progressPercent(task);
    const phase = task ? `${labels[task.state]}${task.state === 'downloading' && percent !== undefined ? ` ${percent}%` : ''}` : '';
    main.disabled = busy || !!active;
    let label = '下载';
    if (active) label = phase;
    else if (loading) label = '读取清晰度…';
    else if (busy) label = '正在准备…';
    else if (selected) label = `${task?.state === 'failed' ? '重试下载' : '下载'} ${selected.videoItag ? selected.label : '音频'}`;
    else if (loadError) label = retryTimer !== undefined ? '正在重试清晰度…' : '重试获取清晰度';
    main.querySelector('span')!.textContent = label;
    main.title = task?.error || loadError;
    for (const progress of root.querySelectorAll<HTMLProgressElement>('progress')) {
      progress.hidden = !active;
      if (percent !== undefined && task?.state === 'downloading') progress.value = percent; else progress.removeAttribute('value');
      progress.setAttribute('aria-valuetext', phase);
    }
    const status = get<HTMLDivElement>('.status'); status.classList.toggle('visible', !!task);
    if (!task) return;
    get('.task-label').textContent = `${labels[task.state]}${task.state === 'downloading' ? ' · ' + (percent === undefined ? bytes(task.received) : percent + '%') : ''}`;
    get<HTMLButtonElement>('.cancel').hidden = !active;
    get('.task-error').textContent = task.error || '';
  }
  function load(automatic = false): Promise<void> {
    if (disposed) return Promise.resolve();
    if (loading) return loading;
    if (busy) return Promise.resolve();
    clearTimeout(retryTimer); retryTimer = undefined;
    if (!automatic) retryAttempt = 0;
    busy = true; loadError = ''; notice.textContent = '正在读取视频和清晰度…';
    loading = (async () => {
      try {
        const value = await call<VideoInfo>('info', { tabId });
        if (disposed) return;
        info = value; title.textContent = value.title;
        selected = defaultChoice(value); retryAttempt = 0;
        notice.textContent = ''; renderChoices();
        await updateTasks();
      } catch (error) {
        if (disposed) return;
        info = undefined; selected = undefined; options.replaceChildren();
        loadError = messageError(error); notice.textContent = loadError;
        if (retryAttempt < retryDelays.length) {
          retryTimer = setTimeout(() => { retryTimer = undefined; void load(true); }, retryDelays[retryAttempt++]);
        }
      } finally {
        loading = undefined; busy = false;
        if (!disposed) { renderTask(); if (menu.matches(':popover-open')) position(); }
      }
    })();
    renderTask();
    return loading;
  }
  async function updateTasks() {
    try {
      const values = await call<Task[]>('list'); if (disposed) return;
      task = info ? values.find(value => value.videoId === info!.videoId) : undefined; renderTask();
    } catch { /* The next task/storage event refreshes transient popup failures. */ }
  }
  toggle.addEventListener('click', () => { if (!info) void load(); });
  get('.refresh').addEventListener('click', () => void load());
  main.addEventListener('click', async () => {
    if (!info || !selected) await load();
    if (disposed) return;
    if (!info || !selected) { open(); return; }
    if (menu.matches(':popover-open')) menu.hidePopover();
    busy = true; notice.textContent = ''; renderTask();
    try { task = await call<Task>('start', { tabId, videoId: info.videoId, choiceId: selected.id }); }
    catch (error) { if (!disposed) { notice.textContent = messageError(error); open(); } }
    finally { busy = false; if (!disposed) renderTask(); }
  });
  get('.cancel').addEventListener('click', async () => {
    if (task) { await call('cancel', { id: task.id }).catch(error => { notice.textContent = messageError(error); }); await updateTasks(); }
  });
  const storageChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local' && changes.tasks) void updateTasks(); };
  chrome.storage.onChanged.addListener(storageChange);
  // The player can become ready after content injection or an SPA navigation.
  // Readiness may recover even after the finite automatic retry budget is spent.
  const playerReady = (event: Event) => { if (event.target instanceof HTMLVideoElement && !info) void load(true); };
  document.addEventListener('loadedmetadata', playerReady, true);
  document.addEventListener('playing', playerReady, true);
  const reposition = () => { if (menu.matches(':popover-open')) position(); };
  window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true);
  void load();
  return { load, open, setHidden(hidden: boolean) {
    if (host.hidden !== hidden) host.hidden = hidden;
    if (hidden && menu.matches(':popover-open')) menu.hidePopover();
  }, destroy() {
    disposed = true; clearTimeout(retryTimer);
    document.removeEventListener('loadedmetadata', playerReady, true); document.removeEventListener('playing', playerReady, true);
    window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); host.remove();
    try { chrome.storage.onChanged.removeListener(storageChange); } catch { /* Also clean up DOM listeners after an extension update invalidates its API context. */ }
  } };
}
