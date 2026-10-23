import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { Input, BufferSource, ALL_FORMATS } from 'mediabunny';
import type { Task, Reply, CollectionPage } from '../../src/types';
import { collectionSource } from '../../src/batch-core';

test('Shorts, paginated collections and persistent sequential batch queue in the real MV3 package', { timeout: 90000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'batch-extension-'));
  const downloads = join(profile, 'downloads'); await mkdir(downloads); await mkdir(join(profile, 'Default'));
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  execFileSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-subj', '/CN=fixture.googlevideo.com', '-keyout', join(profile, 'key.pem'), '-out', join(profile, 'cert.pem'), '-days', '1'], { stdio: 'pipe' });
  const media = await readFile(new URL('../../../frontend/tests/fixtures/playback.webm', import.meta.url));
  let rejectBad = true; let hold = true; let uploadDenied = false;
  let youtube: (request: IncomingMessage, response: ServerResponse) => void;
  const server = createServer({ key: await readFile(join(profile, 'key.pem')), cert: await readFile(join(profile, 'cert.pem')) }, (request, response) => {
    if (request.headers.host?.startsWith('www.youtube.com')) { youtube(request, response); return; }
    if (request.headers.host?.startsWith('space.bilibili.com')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<html><body><div id="native-content">Bilibili 合集原生内容</div><script>fetch("https://api.bilibili.com/x/space/wbi/arc/search?mid=123&pn=1&ps=40&dm_img_str=native-page-field&native_fixture=1").then(()=>{window.nativeReady=true;});</script></body></html>'); return;
    }
    if (request.headers.host?.startsWith('api.bilibili.com')) {
      const url = new URL(request.url!, 'https://api.bilibili.com');
      if (url.pathname === '/x/web-interface/nav') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://space.bilibili.com', 'Access-Control-Allow-Credentials': 'true' });
        response.end(JSON.stringify({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } })); return;
      }
      if (url.pathname === '/x/space/wbi/arc/search') {
        if (!url.searchParams.has('native_fixture')) {
          const unsigned = url.search.slice(1).replace(/&w_rid=[^&]+$/, '');
          assert.equal(url.searchParams.get('w_rid'), createHash('md5').update(unsigned + 'ea1db124af3c7062474693fa704f4ff8').digest('hex'));
          assert.equal(url.searchParams.get('dm_img_str'), 'native-page-field');
          assert.equal(url.searchParams.get('ps'), '30');
        }
        const next = url.searchParams.get('pn') === '2';
        response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://space.bilibili.com', 'Access-Control-Allow-Credentials': 'true' });
        response.end(JSON.stringify({ code: uploadDenied ? -403 : 0, message: uploadDenied ? '访问受限' : '', data: { page: { count: 31 }, list: { vlist: [{ bvid: next ? 'BV1EEao6uExB' : 'BV1GJ411x7h7', title: next ? '投稿第二页' : '投稿第一页', author: 'CLS同学', pic: 'http://i0.hdslb.com/bfs/archive/test.jpg' }] } } })); return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code: 0, data: { meta: { name: '测试合集' }, page: { total: 1 }, archives: [{ bvid: 'BV1GJ411x7h7', title: '合集视频' }] } })); return;
    }
    const params = new URL(request.url!, 'https://fixture.googlevideo.com').searchParams;
    if (params.get('id') === 'batch_can01' && hold) return;
    const range = params.get('range')?.split('-').map(Number); const start = range?.[0] || 0; const end = range?.[1] ?? media.length - 1;
    const rejected = params.get('id') === 'batch_bad01' && rejectBad;
    response.writeHead(rejected ? 403 : 200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${media.length}` } : {}) });
    response.end(rejected ? 'expired' : media.subarray(start, end + 1));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--no-sandbox', '--enable-unsafe-extension-debugging', '--ignore-certificate-errors', '--no-proxy-server', `--host-resolver-rules=MAP fixture.googlevideo.com 127.0.0.1:${port}, MAP www.youtube.com 127.0.0.1:${port}, MAP space.bilibili.com 127.0.0.1:${port}, MAP api.bilibili.com 127.0.0.1:${port}`] });
  t.after(async () => { await context.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(profile, { recursive: true, force: true }); });
  await context.route(/https:\/\/(?:i\.ytimg\.com|i0\.hdslb\.com)\//, route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=', 'base64') }));
  const player = (id: string) => ({ videoDetails: { videoId: id, title: `测试 ${id}`, lengthSeconds: '8' }, playabilityStatus: { status: 'OK' }, streamingData: { formats: [
    { itag: 18, mimeType: 'video/webm; codecs="vp8, opus"', bitrate: 10000, width: 160, height: 90, fps: 10, audioChannels: 2, url: `https://fixture.googlevideo.com/videoplayback?id=${id}`, contentLength: String(media.length) },
  ] } });
  const item = (id: string) => ({ playlistVideoRenderer: { videoId: id, title: { simpleText: `测试 ${id}` } } });
  const listData = (next: boolean) => ({ contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { playlistVideoListRenderer: { contents: [
    item(next ? 'batch_good2' : 'batch_bad01'), ...(!next ? [item('batch_good1'), { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'next-token' } } } }] : []),
  ] } } } }] } } });
  youtube = (request, response) => {
    const url = new URL(request.url!, 'https://www.youtube.com');
    const html = (body: string) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body); };
    if (url.pathname === '/youtubei/v1/browse') {
      let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
        assert.equal(JSON.parse(body).continuation, 'next-token');
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [item('batch_good2')] } }] }));
      }); return;
    }
    if (url.pathname === '/playlist' || url.pathname.startsWith('/@fixture/')) return html(`<title>测试列表 - YouTube</title><script>window.ytInitialData=${JSON.stringify({ ...listData(false), metadata: { playlistMetadataRenderer: { title: '测试列表' } } })};window.ytcfg={set(){}};ytcfg.set({"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"fixture"}}});</script>`);
    const requested = url.searchParams.get('v') || url.pathname.split('/').pop()!;
    const id = requested === 'batch_move1' ? 'batch_real1' : requested;
    const shorts = url.pathname.startsWith('/shorts/');
    return html(`<html><body><div id="movie_player"></div>${shorts ? '<div id="shorts-player" class="html5-video-player"></div>' : '<ytd-watch-metadata><div id="top-level-buttons-computed"></div></ytd-watch-metadata>'}<script>${requested === 'batch_move1' ? "history.replaceState({},'', '/watch?v=batch_real1');" : ''}window.currentResponse=${JSON.stringify(player(id))};window.ytInitialPlayerResponse=${JSON.stringify(player('old_video01'))};document.querySelector('#movie_player').getPlayerResponse=()=>${shorts ? 'window.ytInitialPlayerResponse' : 'window.currentResponse'};${shorts ? "document.querySelector('#shorts-player').getPlayerResponse=()=>window.currentResponse;" : ''}</script></body></html>`);
  };
  const install = await context.browser()!.newBrowserCDPSession();
  await install.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const { id: extensionId } = await install.send('Extensions.loadUnpacked', { path: resolve('dist') }); await install.detach();
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const manager = await context.newPage(); await manager.goto(`chrome-extension://${extensionId}/batch.html`);
  const send = async <T>(type: string, data: Record<string, unknown> = {}) => {
    const reply = await manager.evaluate(async message => chrome.runtime.sendMessage(message), { target: 'background', type, ...data }) as Reply<T>;
    assert.ok(reply.ok, !reply.ok ? reply.error : ''); return reply.value;
  };
  const waitTask = async (videoId: string, state: string) => {
    const deadline = Date.now() + 20000; let values: Task[] = [];
    while (Date.now() < deadline) {
      values = await send<Task[]>('list'); const found = values.find(task => task.videoId === videoId && task.state === state);
      if (found) return found;
      await manager.waitForTimeout(100);
    }
    assert.fail(JSON.stringify({ videoId, state, values }));
  };
  // Real serialized MAIN-world read: watch metadata is stale, Shorts response
  // lives only on shorts-player. Then scroll/navigation keeps the same document.
  const short = await context.newPage(); await short.goto('https://www.youtube.com/shorts/shorts_one1');
  await short.locator('#yt-local-download-root .main').filter({ hasText: '下载 90p' }).waitFor();
  await short.evaluate(value => { (window as Window & { currentResponse?: unknown }).currentResponse = value; history.pushState({}, '', '/shorts/shorts_two2'); document.dispatchEvent(new Event('yt-navigate-finish')); }, player('shorts_two2'));
  await short.locator('#yt-local-download-root .video-title').filter({ hasText: 'shorts_two2' }).waitFor({ state: 'attached' });
  await short.locator('#yt-local-download-root .main').click();
  await waitTask('shorts_two2', 'completed');
  // Count Chrome tab lifecycle events, including a tab created and immediately
  // removed between observations. Neither initial reads nor pagination may do it.
  await worker.evaluate(() => {
    const state = globalThis as typeof globalThis & { collectionTabs?: { created: number; removed: number } };
    state.collectionTabs = { created: 0, removed: 0 };
    chrome.tabs.onCreated.addListener(() => state.collectionTabs!.created++);
    chrome.tabs.onRemoved.addListener(() => state.collectionTabs!.removed++);
  });
  assert.equal((await send<CollectionPage>('collection', { url: 'https://www.youtube.com/playlist?list=PL_fixture' })).entries.length, 2);
  await manager.getByLabel('播放列表、频道或合集链接').fill('https://www.youtube.com/playlist?list=PL_fixture');
  await manager.getByRole('button', { name: '读取列表', exact: true }).click();
  await manager.locator('.entry').nth(1).waitFor();
  // Deselection survives pagination and duplicate pages.
  await manager.locator('.entry input').first().uncheck();
  await manager.getByRole('button', { name: '加载更多', exact: true }).click();
  await manager.locator('.entry').nth(2).waitFor();
  assert.equal(await manager.locator('.entry input').first().isChecked(), false);
  assert.deepEqual(await worker.evaluate(() => (globalThis as typeof globalThis & { collectionTabs?: { created: number; removed: number } }).collectionTabs), { created: 0, removed: 0 });
  await short.close();
  const noSession = await manager.evaluate(async () => chrome.runtime.sendMessage({ target: 'background', type: 'collection', url: 'https://www.youtube.com/playlist?list=PL_fixture', continuation: 'next-token' }));
  assert.equal(noSession.ok, false); assert.match(noSession.error, /保持原 YouTube 页面打开/);
  assert.deepEqual(await worker.evaluate(() => (globalThis as typeof globalThis & { collectionTabs?: { created: number; removed: number } }).collectionTabs), { created: 0, removed: 1 });
  // Collection/channel pages expose a direct entry. Opening the manager is an
  // explicit user action; its automatic metadata read must not open more tabs.
  const sourcePage = await context.newPage();
  await sourcePage.goto('https://www.youtube.com/@fixture/videos');
  const batchButton = sourcePage.getByRole('button', { name: '批量下载此列表', exact: true });
  await batchButton.waitFor();
  const opened: import('playwright').Page[] = [];
  for (const source of ['https://www.youtube.com/@fixture/videos', 'https://www.youtube.com/playlist?list=PL_fixture', 'https://space.bilibili.com/123/lists/456?type=season', 'https://space.bilibili.com/123', 'https://space.bilibili.com/123/video', 'https://space.bilibili.com/123/upload/video']) {
    if (source.includes('/playlist')) {
      await sourcePage.evaluate(() => { history.pushState({}, '', '/playlist?list=PL_fixture'); document.dispatchEvent(new Event('yt-navigate-finish')); });
      await sourcePage.waitForTimeout(250);
    } else if (source.includes('bilibili')) { await sourcePage.goto(source); await sourcePage.waitForFunction(() => (window as Window & { nativeReady?: boolean }).nativeReady); }
    await batchButton.waitFor();
    assert.equal(await sourcePage.locator('#yt-local-download-root').count(), 1);
    const next = context.waitForEvent('page'); await batchButton.click(); const panel = await next; opened.push(panel);
    await panel.waitForURL(`chrome-extension://${extensionId}/batch.html?source=*`);
    await panel.locator('.entry').first().waitFor();
    assert.equal(await panel.getByLabel('播放列表、频道或合集链接').inputValue(), collectionSource(source).url);
    if (source.includes('bilibili')) {
      assert.equal(await sourcePage.locator('#native-content').textContent(), 'Bilibili 合集原生内容');
      assert.equal(await sourcePage.locator('#yt-local-download-root').evaluate(host => host.parentElement === document.body), true);
      if (collectionSource(source).kind === 'channel') {
        assert.equal(await panel.locator('.entry .cover img').getAttribute('src'), 'https://i0.hdslb.com/bfs/archive/test.jpg');
        assert.match(await panel.locator('.entry-meta').textContent() || '', /分辨率：下载时读取.*大小：下载时估算/);
        const before = await worker.evaluate(() => (globalThis as typeof globalThis & { collectionTabs?: { created: number; removed: number } }).collectionTabs);
        await panel.getByRole('button', { name: '加载更多', exact: true }).click(); await panel.locator('.entry').nth(1).waitFor();
        assert.match(await panel.locator('.entry').nth(1).textContent() || '', /投稿第二页/);
        assert.deepEqual(await worker.evaluate(() => (globalThis as typeof globalThis & { collectionTabs?: { created: number; removed: number } }).collectionTabs), before);
        uploadDenied = true;
        const denied = await panel.evaluate(async () => chrome.runtime.sendMessage({ target: 'background', type: 'collection', url: 'https://space.bilibili.com/123/upload/video' }));
        assert.equal(denied.ok, false); assert.match(denied.error, /-403.*登录或完成验证/); uploadDenied = false;
        await panel.screenshot({ path: resolve('artifacts/bilibili-uploads-metadata-preview.png'), fullPage: true });
      }
    }
  }
  await sourcePage.goto('https://www.youtube.com/watch?v=fixture_011');
  await sourcePage.locator('#yt-local-download-root .main').filter({ hasText: '下载 90p' }).waitFor();
  assert.equal(await batchButton.count(), 0);
  await sourcePage.evaluate(() => { history.pushState({}, '', '/feed/subscriptions'); document.dispatchEvent(new Event('yt-navigate-finish')); });
  await sourcePage.locator('#yt-local-download-root').waitFor({ state: 'detached' });
  for (const panel of opened) await panel.close(); await sourcePage.close();
  await manager.getByRole('button', { name: '全选已加载', exact: true }).click();
  await manager.getByRole('button', { name: '加入下载队列', exact: true }).click();
  const bad = await waitTask('batch_bad01', 'failed');
  const good = await waitTask('batch_good1', 'completed'); await waitTask('batch_good2', 'completed');
  const goodRow = manager.locator(`.record[data-id="${good.id}"]`);
  assert.match(await goodRow.locator('.record-resolution').textContent() || '', /160×90.*WEBM/);
  assert.match(await goodRow.locator('.record-size').textContent() || '', /文件大小/);
  assert.ok((await goodRow.locator('.cover img').getAttribute('src'))?.includes('/batch_good1/'));
  const saved = (await worker.evaluate(async id => chrome.downloads.search({ id }), good.downloadId!))[0];
  const output = new Input({ source: new BufferSource(await readFile(saved.filename)), formats: ALL_FORMATS });
  assert.ok(await output.getPrimaryVideoTrack()); assert.ok(await output.getPrimaryAudioTrack()); assert.ok(Math.abs(await output.computeDuration() - 8) < .05); output.dispose();
  const stored = JSON.stringify(await send<Task[]>('list')); assert.ok(!stored.includes('googlevideo.com')); assert.ok(!stored.includes('poToken'));
  rejectBad = false; await send('retry', { id: bad.id }); await waitTask('batch_bad01', 'completed');
  const entry = (id: string) => ({ videoId: id, title: `测试 ${id}`, url: `https://www.youtube.com/watch?v=${id}` });
  await send('enqueue', { entries: [entry('batch_move1')], quality: 'best' });
  assert.match((await waitTask('batch_move1', 'failed')).error || '', /页面已切换/);
  await send('enqueue', { entries: [entry('batch_can01'), entry('batch_next1')], quality: '720' });
  const current = await waitTask('batch_can01', 'resolving');
  await send('queue-control', { action: 'pause' }); await send('cancel', { id: current.id });
  assert.equal((await send<Task[]>('list')).find(task => task.videoId === 'batch_next1')?.state, 'queued');
  // Stop/restart the actual service worker. A waiting task stays waiting and
  // can be explicitly resumed; it must not become a fictitious failed download.
  const recovery = await context.newCDPSession(manager);
  const running = new Promise<string>(done => recovery.on('ServiceWorker.workerVersionUpdated', event => {
    const version = event.versions.find(value => value.scriptURL === `chrome-extension://${extensionId}/background.js` && value.runningStatus === 'running'); if (version) done(version.versionId);
  }));
  await recovery.send('ServiceWorker.enable'); await recovery.send('ServiceWorker.stopWorker', { versionId: await running });
  assert.equal((await send<Task[]>('list')).find(task => task.videoId === 'batch_next1')?.state, 'queued');
  assert.equal(await manager.evaluate(async () => (await chrome.storage.local.get('queuePaused')).queuePaused), true);
  await recovery.detach(); worker = context.serviceWorkers()[0] || worker;
  await send('queue-control', { action: 'resume' }); await waitTask('batch_next1', 'completed');
  // Closing the queue page does not own execution.
  hold = false;
  await send('enqueue', { entries: [entry('batch_last1')], quality: 'best' });
  await manager.close();
  const reopened = await context.newPage(); await reopened.goto(`chrome-extension://${extensionId}/batch.html`);
  let last: Task | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await reopened.evaluate(async () => chrome.runtime.sendMessage({ target: 'background', type: 'list' }));
    last = result.value.find((task: Task) => task.videoId === 'batch_last1');
    if (last?.state === 'completed' || last?.state === 'failed') break;
    await reopened.waitForTimeout(100);
  }
  assert.equal(last?.state, 'completed', last?.error);
  await reopened.waitForTimeout(300); assert.deepEqual(await reopened.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter(key => key.startsWith('queue-tab-'))), []);
  await reopened.screenshot({ path: resolve('artifacts/batch-queue-preview.png'), fullPage: true });
});
