import { batchEntries, batchQuality, qualityChoice, QUEUE_LIMIT } from './batch-core';
import { choices, coverURL } from './core';
import { messageError, terminal } from './types';
import type { PageSnapshot, Task } from './types';

interface Dependencies {
  serial<T>(operation: () => Promise<T>): Promise<T>;
  tasks(): Promise<Task[]>;
  persist(values: Task[]): Promise<void>;
  source(tabId: number): Promise<PageSnapshot>;
  run(task: Task, source: PageSnapshot, tabId: number): Promise<void>;
}
export async function waitForTab(tabId: number) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if ((await chrome.tabs.get(tabId)).status === 'complete') return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('页面加载超时，请重试此任务。');
}
export function createQueue(deps: Dependencies) {
  let pumping = false;
  const tabs = new Map<string, number>();
  async function release(id: string) {
    const key = `queue-tab-${id}`;
    const stored = (await chrome.storage.session.get(key))[key] as number | undefined;
    const tab = tabs.get(id) ?? stored; tabs.delete(id);
    await chrome.storage.session.remove(key);
    if (tab !== undefined) await chrome.tabs.remove(tab).catch(() => {});
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      const task = await deps.serial(async () => {
        if ((await chrome.storage.local.get('queuePaused')).queuePaused) return;
        const values = await deps.tasks();
        if (values.some(item => !terminal(item.state) && (item.state !== 'queued' || !item.batch))) return;
        const next = [...values].reverse().find(item => item.batch && item.state === 'queued');
        if (!next) return;
        next.state = 'resolving'; await deps.persist(values); return next;
      });
      if (!task) return;
      try {
        const tab = await chrome.tabs.create({ url: task.batch!.url, active: false });
        if (tab.id === undefined) throw new Error('无法打开视频页面。');
        tabs.set(task.id, tab.id);
        await chrome.storage.session.set({ [`queue-tab-${task.id}`]: tab.id });
        await chrome.tabs.update(tab.id, { muted: true });
        await waitForTab(tab.id);
        let source: PageSnapshot | undefined; let lastError: unknown;
        for (let attempt = 0; attempt < 12; attempt++) {
          if (terminal((await deps.tasks()).find(value => value.id === task.id)?.state || 'cancelled')) return;
          try { source = await deps.source(tab.id); break; } catch (error) { lastError = error; }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!source) throw lastError || new Error('无法读取视频。');
        if (source.videoId !== task.videoId) throw new Error('视频页面已切换，已停止此项以避免下载错误的视频。');
        const resolved = source;
        const choice = qualityChoice(choices(resolved), task.batch!.quality);
        await deps.serial(async () => {
          const values = await deps.tasks(); const current = values.find(value => value.id === task.id);
          if (!current || terminal(current.state)) return;
          current.title = resolved.title; current.choice = choice;
          current.thumbnail = coverURL(resolved.thumbnail || current.thumbnail, resolved.site, current.videoId);
          await deps.persist(values);
          await deps.run(current, resolved, tab.id!);
        });
      } catch (error) {
        await deps.serial(async () => {
          const values = await deps.tasks(); const current = values.find(value => value.id === task.id);
          if (!current || terminal(current.state)) return;
          current.state = 'failed'; current.error = messageError(error); await deps.persist(values);
        });
        await release(task.id);
      } finally {
        if (terminal((await deps.tasks()).find(value => value.id === task.id)?.state || 'cancelled')) await release(task.id);
      }
    } finally {
      pumping = false;
      // Terminal events may arrive during resolution/cancellation. Recheck only
      // when no executor remains, without polling a running download.
      const values = await deps.tasks();
      if (values.some(task => task.batch && task.state === 'queued') && !values.some(task => !terminal(task.state) && (task.state !== 'queued' || !task.batch))
        && !(await chrome.storage.local.get('queuePaused')).queuePaused) void pump();
    }
  }
  return {
    pump,
    async settled(id: string) { await release(id); void pump(); },
    async enqueue(input: unknown, preference: unknown) {
      const entries = batchEntries(input);
      if (!entries.length) throw new Error(`请选择 1–${QUEUE_LIMIT} 个视频。`);
      const quality = batchQuality(preference);
      const added = await deps.serial(async () => {
        const values = await deps.tasks();
        const pending = values.filter(task => !terminal(task.state));
        const fresh = entries.filter(entry => !pending.some(task => task.videoId === entry.videoId));
        if (pending.length + fresh.length > QUEUE_LIMIT) throw new Error(`队列最多保留 ${QUEUE_LIMIT} 个未完成任务。`);
        const created: Task[] = fresh.map((entry, index) => ({ id: crypto.randomUUID(), videoId: entry.videoId,
          site: entry.videoId.startsWith('bilibili:') ? 'bilibili' : 'youtube', title: entry.title, thumbnail: entry.thumbnail,
          choice: { id: 'pending', label: quality === 'best' ? '最高画质' : quality === 'audio' ? '仅音频' : `≤${quality}p`, container: quality === 'audio' ? 'm4a' : 'mp4' },
          state: 'queued', created: Date.now() + index / 1000, received: 0, batch: { url: entry.url, quality },
        }));
        await deps.persist([...created.reverse(), ...values]);
        return fresh.length;
      });
      void pump(); return added;
    },
    async control(action: unknown) {
      await deps.serial(async () => {
        if (action === 'pause' || action === 'resume') await chrome.storage.local.set({ queuePaused: action === 'pause' });
        else if (action === 'clear') {
          const values = await deps.tasks();
          for (const task of values) if (task.batch && task.state === 'queued') task.state = 'cancelled';
          await deps.persist(values);
        } else throw new Error('队列操作无效。');
      });
      void pump();
    },
    async retry(id: unknown) {
      await deps.serial(async () => {
        const values = await deps.tasks(); const task = values.find(value => value.id === id);
        if (!task?.batch || !['failed', 'cancelled'].includes(task.state)) throw new Error('此任务无法重试。');
        if (values.some(value => value.id !== id && value.videoId === task.videoId && !terminal(value.state))) throw new Error('该视频已在队列中。');
        if (values.filter(value => !terminal(value.state)).length >= QUEUE_LIMIT) throw new Error('队列已满。');
        // A new execution identity makes late messages from the old worker inert.
        task.id = crypto.randomUUID(); task.created = Date.now(); task.state = 'queued'; task.received = 0;
        delete task.error; delete task.total; delete task.downloadId; delete task.filename; delete task.fileSize;
        await deps.persist(values);
      });
      void pump();
    },
  };
}
