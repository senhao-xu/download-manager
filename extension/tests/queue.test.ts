import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createQueue } from '../src/queue';
import type { Task } from '../src/types';

const entry = (videoId: string) => ({ videoId, title: videoId, url: `https://www.youtube.com/watch?v=${videoId}` });
const queued = (videoId: string, state: Task['state'] = 'queued'): Task => ({
  id: videoId, videoId, title: videoId, state, created: 1, received: 0,
  choice: { id: 'pending', label: '最高画质', container: 'mp4' },
  batch: { url: entry(videoId).url, quality: 'best' },
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function setup(t: TestContext, initial: Task[] = [], paused?: boolean) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const local: Record<string, unknown> = { queuePaused: paused };
  const session: Record<string, unknown> = {};
  const opened: string[] = []; const runs: string[] = [];
  let values = structuredClone(initial); let changes = Promise.resolve();
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    storage: {
      local: { get: async (key: string) => ({ [key]: local[key] }), set: async (value: Record<string, unknown>) => { Object.assign(local, value); } },
      session: { get: async (key: string) => ({ [key]: session[key] }), set: async (value: Record<string, unknown>) => { Object.assign(session, value); }, remove: async (key: string) => { delete session[key]; } },
    },
    tabs: {
      create: async ({ url }: { url: string }) => ({ id: opened.push(url) }),
      update: async () => {}, get: async () => ({ status: 'complete' }), remove: async () => {},
    },
  } });
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'chrome', prior); else Reflect.deleteProperty(globalThis, 'chrome'); });
  const queue = createQueue({
    serial(operation) { const result = changes.then(operation); changes = result.then(() => {}, () => {}); return result; },
    tasks: async () => structuredClone(values),
    persist: async tasks => { values = structuredClone(tasks).sort((a, b) => b.created - a.created); },
    source: async tabId => ({ videoId: new URL(opened[tabId - 1]).searchParams.get('v')!, title: 'Video', duration: 8, status: 'OK', live: false, client: {},
      formats: [{ itag: 18, mimeType: 'video/mp4', height: 360, bitrate: 1000, audioChannels: 2, url: 'https://fixture.googlevideo.com/videoplayback' }],
    }),
    run: async task => { runs.push(task.videoId); },
  });
  return { queue, local, opened, runs, tasks: () => values };
}

test('empty download submissions are rejected without changing the queue', async t => {
  const state = setup(t);
  await assert.rejects(state.queue.enqueue([], 'best'), /请选择 1–1000 个视频/);
  assert.deepEqual(state.tasks(), []); assert.deepEqual(state.opened, []);
});
test('duplicate and new entries preserve pause until an explicit resume', async t => {
  const state = setup(t, [queued('fixture_001')], true);
  assert.equal(await state.queue.enqueue([entry('fixture_001')], 'best'), 0);
  await flush();
  assert.equal(state.local.queuePaused, true); assert.deepEqual(state.opened, []);
  assert.equal(await state.queue.enqueue([entry('fixture_002')], 'best'), 1);
  await flush();
  assert.equal(state.local.queuePaused, true); assert.deepEqual(state.opened, []);
  assert.ok(state.tasks().every(task => task.state === 'queued'));
  await state.queue.control('resume'); await flush();
  assert.equal(state.local.queuePaused, false); assert.deepEqual(state.runs, ['fixture_001']);
  assert.equal(state.tasks().find(task => task.videoId === 'fixture_002')?.state, 'queued');
});
test('retry preserves pause and clears the old execution identity and error', async t => {
  const failed = { ...queued('fixture_001', 'failed'), error: 'Previous failure' };
  const state = setup(t, [failed], true);
  await state.queue.retry(failed.id); await flush();
  const task = state.tasks()[0];
  assert.notEqual(task.id, failed.id); assert.equal(task.state, 'queued'); assert.equal(task.error, undefined);
  assert.equal(state.local.queuePaused, true); assert.deepEqual(state.opened, []);
});
test('a new queue starts automatically when it has never been paused', async t => {
  const state = setup(t);
  assert.equal(await state.queue.enqueue([entry('fixture_001')], 'best'), 1); await flush();
  assert.deepEqual(state.runs, ['fixture_001']); assert.equal(state.opened.length, 1);
});
