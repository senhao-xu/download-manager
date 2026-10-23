import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadParts, RANGE_BYTES, DOWNLOAD_CONNECTIONS } from '../src/transfer';
import type { TransferSource } from '../src/transfer';

const url = 'https://fixture.googlevideo.com/videoplayback';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('four shared connections write out-of-order ranges correctly without overlapping file writes', async t => {
  const originals = [Buffer.alloc(RANGE_BYTES * 5 + 37), Buffer.alloc(RANGE_BYTES + 7, 23)];
  for (let i = 0; i < originals[0].length; i++) originals[0][i] = (i * 7 + Math.floor(i / RANGE_BYTES)) % 251;
  const outputs = originals.map(buffer => Buffer.alloc(buffer.length));
  const writing = [false, false]; const ranges: string[][] = [[], []];
  let active = 0; let peak = 0; let received = 0;
  const finished: number[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL, options: RequestInit) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    const index = Number(input.searchParams.get('track'));
    const range = input.searchParams.get('range')!; ranges[index].push(range);
    const [start, end] = range.split('-').map(Number);
    active++; peak = Math.max(peak, active);
    await wait(start === 0 ? 45 : 5);
    active--; finished.push(start);
    return new Response(new Uint8Array(originals[index].subarray(start, end + 1)), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${originals[index].length}` } });
  });
  const sources: TransferSource[] = originals.map((buffer, index) => ({ url: `${url}?track=${index}`, length: buffer.length,
    async write(data, position) {
      assert.equal(writing[index], false); writing[index] = true;
      await wait(2); outputs[index].set(data, position); writing[index] = false;
    } }));
  await downloadParts(sources, new AbortController().signal, count => { received += count; });
  assert.equal(peak, DOWNLOAD_CONNECTIONS); assert.ok(finished[0] > 0);
  for (let i = 0; i < originals.length; i++) {
    assert.deepEqual(outputs[i], originals[i]);
    assert.equal(new Set(ranges[i]).size, Math.ceil(originals[i].length / RANGE_BYTES));
  }
  assert.equal(received, originals.reduce((sum, value) => sum + value.length, 0));
});

test('transient response retries count bytes once; unknown length uses one streaming request', async t => {
  let requests = 0; let received = 0; const writes: number[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    requests++;
    if (requests === 1) return new Response('', { status: 503 });
    assert.equal(input.searchParams.has('range'), false);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close(); } }));
  });
  await downloadParts([{ url, async write(data, position) { writes.push(position); assert.deepEqual([...data], position ? [3] : [1, 2]); } }], new AbortController().signal, count => { received += count; });
  assert.equal(requests, 2); assert.equal(received, 3); assert.deepEqual(writes, [0, 2]);
});

test('persistent server failure exhausts a bounded retry count', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('', { status: 503 }); });
  await assert.rejects(downloadParts([{ url, length: 4, async write() { assert.fail('failed write'); } }], new AbortController().signal, () => assert.fail('failed progress')), /503/);
  assert.equal(requests, 3);
});

test('cancellation aborts all four active requests without writing bytes', async t => {
  const cancel = new AbortController(); let active = 0; let aborted = 0;
  t.mock.method(globalThis, 'fetch', async (_input: URL, options: RequestInit) => new Promise((_, reject) => {
    active++;
    options.signal!.addEventListener('abort', () => { aborted++; reject(options.signal!.reason); }, { once: true });
    if (active === DOWNLOAD_CONNECTIONS) queueMicrotask(() => cancel.abort());
  }));
  await assert.rejects(downloadParts([{ url, length: RANGE_BYTES * 8, async write() { assert.fail('cancelled write'); } }], cancel.signal, () => assert.fail('cancelled progress')), { name: 'AbortError' });
  assert.equal(active, DOWNLOAD_CONNECTIONS); assert.equal(aborted, DOWNLOAD_CONNECTIONS);
});

test('first HTTP failure aborts sibling ranges and preserves the actionable error', async t => {
  let aborted = 0;
  t.mock.method(globalThis, 'fetch', async (input: URL, options: RequestInit) => {
    if (input.searchParams.get('range')!.startsWith('0-')) { await wait(10); return new Response('', { status: 403 }); }
    return new Promise((_, reject) => options.signal!.addEventListener('abort', () => { aborted++; reject(options.signal!.reason); }, { once: true }));
  });
  await assert.rejects(downloadParts([{ url, length: RANGE_BYTES * 8, async write() { assert.fail('failed write'); } }], new AbortController().signal, () => assert.fail('failed progress')), /失效|验证/);
  assert.equal(aborted, DOWNLOAD_CONNECTIONS - 1);
});

test('truncated, oversized and mismatched ranges never become successful media bytes', async t => {
  for (const variant of ['truncated', 'oversized', 'position']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(variant === 'truncated' ? 2 : variant === 'oversized' ? 6 : 4), { status: 206,
      headers: { 'Content-Range': variant === 'position' ? 'bytes 4-7/8' : 'bytes 0-3/4' } }));
    await assert.rejects(downloadParts([{ url, length: 4, async write() { assert.fail('invalid write'); } }], new AbortController().signal, () => assert.fail('invalid progress')), /不完整|分片/);
  }
});
