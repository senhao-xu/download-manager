import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { Input, Output, BufferSource, BufferTarget, Mp4OutputFormat, Conversion, ALL_FORMATS } from 'mediabunny';
import type { Reply, Task, VideoInfo } from '../../src/types';

const bvid = 'BV1xx411c7mD';
const clip = await readFile(new URL('../fixtures/playback.mp4', import.meta.url));
async function split(audio: boolean) {
  const input = new Input({ source: new BufferSource(clip), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ target, format: new Mp4OutputFormat() });
  const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' }, video: { discard: audio }, audio: { discard: !audio } });
  await conversion.execute(); input.dispose(); return Buffer.from(target.buffer!);
}

test('Bilibili MV3 reads the normal session, downloads current-part MP4/audio, scopes headers and cleans failures', { timeout: 60000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'bilibili-extension-test-'));
  const downloadPath = join(profile, 'downloads'); await mkdir(downloadPath);
  await mkdir(join(profile, 'Default'));
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadPath, prompt_for_download: false } }));
  execFileSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-subj', '/CN=fixture.bilivideo.com', '-keyout', join(profile, 'key.pem'), '-out', join(profile, 'cert.pem'), '-days', '1'], { stdio: 'pipe' });
  const [video, audio] = await Promise.all([split(false), split(true)]);
  const free = Buffer.alloc(8); free.writeUInt32BE(5 * 4 * 1024 * 1024 + 8); free.write('free', 4);
  const largeVideo = Buffer.concat([video, free, Buffer.alloc(5 * 4 * 1024 * 1024)]);
  let active = 0; let peak = 0; let failed = false; let slow = false;
  const requests: { range?: string; referer?: string }[] = [];
  const server = createServer({ key: await readFile(join(profile, 'key.pem')), cert: await readFile(join(profile, 'cert.pem')) }, (request, response) => {
    const url = new URL(request.url!, 'https://fixture.bilivideo.com');
    assert.equal(url.searchParams.has('range'), false);
    const body = url.searchParams.get('kind') === 'video' ? largeVideo : audio;
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    requests.push({ range: request.headers.range, referer: request.headers.referer });
    const authorized = request.headers.referer === 'https://www.bilibili.com/' && !failed;
    const start = Number(range?.[1] || 0); const end = Number(range?.[2] || body.length - 1);
    active++; peak = Math.max(peak, active); response.once('close', () => { active--; });
    const send = () => {
      if (response.destroyed) return;
      response.writeHead(authorized ? range ? 206 : 200 : 403, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
      response.end(authorized ? body.subarray(start, end + 1) : 'forbidden');
    };
    setTimeout(send, slow ? 1200 : start === 0 ? 80 : 30);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, acceptDownloads: true, ignoreDefaultArgs: ['--disable-extensions'],
    // The public CDN is simulated on loopback; preserve its public address
    // space so an unrelated webpage can exercise the scoped header rule too.
    args: ['--no-sandbox', '--enable-unsafe-extension-debugging', '--ignore-certificate-errors', '--no-proxy-server', `--ip-address-space-overrides=127.0.0.1:${port}=public`, `--host-resolver-rules=MAP fixture.bilivideo.com 127.0.0.1:${port}`] });
  t.after(async () => { await context.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(profile, { recursive: true, force: true }); });
  await context.addCookies([{ name: 'SESSDATA', value: 'test-session', domain: '.bilibili.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const cids: string[] = []; let sawSession = false; let unavailable = false; let initiallyFullscreen = false;
  await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
    <html><head><meta charset="utf-8"><style>
    body{margin:20px}#video-page-app{display:grid;grid-template-columns:minmax(0,1fr)240px;gap:24px}
    #native-header{grid-column:1/-1}main{min-width:0}.video-toolbar-container{height:57px;display:flex;align-items:center;justify-content:space-between}
    .video-toolbar-left{width:250px;height:28px}.video-toolbar-right{width:50px;height:28px}#native-cover{width:200px;height:112px}
    </style></head><body${initiallyFullscreen ? ' class="webscreen-fix"' : ''}><div id="video-page-app"><header id="native-header"></header><main><h1>Bilibili Fixture</h1>
    <div class="video-toolbar-container"><div class="video-toolbar-left">点赞 · 投币 · 收藏 · 分享</div><div class="video-toolbar-right">更多</div></div>
    </main><aside id="native-sidebar">推荐视频</aside></div><script>
    const app=document.querySelector('#video-page-app');const expected=app.innerHTML;
    setTimeout(()=>{
      if(app.innerHTML!==expected)throw new Error('Native hydration tree was changed before initialization');
      document.querySelector('#native-header').innerHTML='<input id="native-search" aria-label="站内搜索">';
      const cover=document.createElement('img');cover.id='native-cover';cover.alt='推荐视频封面';
      cover.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="112"><rect width="200" height="112" fill="#00a1d6"/></svg>');
      document.querySelector('#native-sidebar').append(cover);app.dataset.nativeReady='true';
    },750);
    </script></body></html>` }));
  await context.route('https://api.bilibili.com/**', async route => {
    const url = new URL(route.request().url());
    sawSession ||= (await route.request().allHeaders()).cookie?.includes('SESSDATA=test-session') || false;
    const metadata = { bvid, aid: 2, title: 'Bilibili Fixture', pages: [{ cid: 501, page: 1, part: '第一部分', duration: 8 }, { cid: 502, page: 2, part: '第二部分', duration: 8 }] };
    if (url.pathname === '/x/player/playurl') cids.push(url.searchParams.get('cid')!);
    else assert.equal(url.pathname, '/x/web-interface/view');
    const data = url.pathname === '/x/web-interface/view' ? metadata : { timelength: 8000,
      support_formats: [{ quality: 16, new_description: '90P 测试' }], dash: {
        video: [{ id: 16, codecid: 7, mimeType: 'video/mp4', codecs: 'avc1.64000a', width: 160, height: 90, frameRate: '10', bandwidth: 21000000,
          baseUrl: `https://fixture.bilivideo.com/upgcxcode/track.m4s?kind=video&cid=${url.searchParams.get('cid')}` }],
        audio: [{ id: 30280, mimeType: 'audio/mp4', codecs: 'mp4a.40.2', bandwidth: 48000, baseUrl: 'https://fixture.bilivideo.com/upgcxcode/track.m4s?kind=audio' }],
      } };
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'https://www.bilibili.com', 'Access-Control-Allow-Credentials': 'true' }, body: JSON.stringify({ code: unavailable ? -101 : 0, message: unavailable ? '请先登录' : 'OK', data }) });
  });
  const page = await context.newPage();
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`https://www.bilibili.com/video/${bvid}/?p=2`);
  const installer = await context.browser()!.newBrowserCDPSession();
  await installer.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  const { id: extensionId } = await installer.send('Extensions.loadUnpacked', { path: resolve('dist') }); await installer.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const inline = page.locator('#yt-local-download-root');
  await inline.locator('.main').filter({ hasText: '下载 90P 测试' }).waitFor();
  assert.equal(await inline.count(), 1); assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  // Installing before delayed native hydration and reloading with the extension
  // present must leave the app's DOM intact so native header/images initialize.
  async function nativeLayout() {
    await page.locator('#video-page-app[data-native-ready="true"]').waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('#native-cover');
      const control = document.querySelector('#yt-local-download-root')?.getBoundingClientRect();
      const toolbar = document.querySelector('.video-toolbar-container')?.getBoundingClientRect();
      return !!image?.naturalWidth && !!control && !!toolbar && Math.abs(control.top + control.height / 2 - toolbar.top - toolbar.height / 2) < 2;
    });
    assert.deepEqual(pageErrors, []);
    assert.equal(await page.locator('#native-search').count(), 1);
    assert.equal(await page.locator('#video-page-app #yt-local-download-root').count(), 0);
    assert.equal(await inline.evaluate(element => element.parentElement === document.body), true);
    const layout = await page.evaluate(() => {
      const toolbar = document.querySelector('.video-toolbar-container')!.getBoundingClientRect();
      const left = document.querySelector('.video-toolbar-left')!.getBoundingClientRect();
      const right = document.querySelector('.video-toolbar-right')!.getBoundingClientRect();
      const control = document.querySelector('#yt-local-download-root')!.getBoundingClientRect();
      return { height: toolbar.height, afterLeft: control.left > left.right, beforeRight: control.right < right.left, rightAligned: Math.abs(control.right - (right.left - 8)) < 1 };
    });
    assert.deepEqual(layout, { height: 57, afterLeft: true, beforeRight: true, rightAligned: true });
  }
  await nativeLayout();
  await page.reload(); await nativeLayout();
  await page.setViewportSize({ width: 760, height: 850 });
  await page.locator('#yt-local-download-root[data-floating]:not([data-anchored])').waitFor();
  // Bilibili web fullscreen does not set document.fullscreenElement. It must
  // still hide the floating control and explicitly dismiss its top-layer menu.
  await inline.getByRole('button', { name: '选择下载清晰度' }).click();
  await inline.locator('.menu:popover-open').waitFor();
  await page.evaluate(() => document.body.classList.add('webscreen-fix'));
  await page.locator('#yt-local-download-root[hidden]').waitFor({ state: 'attached' });
  assert.equal(await inline.isVisible(), false);
  assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  await page.evaluate(() => document.body.classList.remove('webscreen-fix'));
  await page.locator('#yt-local-download-root[data-floating]:not([hidden])').waitFor();
  await page.setViewportSize({ width: 1280, height: 850 }); await nativeLayout();
  await inline.getByRole('button', { name: '选择下载清晰度' }).click();
  await inline.locator('.menu:popover-open').waitFor();
  const menu = await inline.locator('.menu').boundingBox();
  assert.ok(menu && menu.x >= 0 && menu.x + menu.width <= 1280);
  await inline.locator('.option').filter({ hasText: '90P 测试' }).click();
  assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  await nativeLayout();
  // Fullscreen the document, which includes the extension host: UA subtree
  // suppression alone cannot make this assertion pass.
  await page.evaluate(() => document.documentElement.requestFullscreen());
  await page.locator('#yt-local-download-root[hidden]').waitFor({ state: 'attached' });
  assert.equal(await inline.isVisible(), false);
  assert.equal(await page.evaluate(() => document.fullscreenElement === document.documentElement), true);
  await page.evaluate(() => document.exitFullscreen()); await nativeLayout();
  assert.equal(await inline.isVisible(), true);
  // Injection into a page already in web fullscreen must start hidden too.
  initiallyFullscreen = true; await page.reload();
  await page.locator('#yt-local-download-root[hidden]').waitFor({ state: 'attached' });
  assert.equal(await inline.isVisible(), false);
  initiallyFullscreen = false;
  await page.evaluate(() => document.body.classList.remove('webscreen-fix')); await nativeLayout();
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' }))[0].id!);
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId); await popup.reload();
  await popup.locator('#download-controls:not([hidden])').waitFor();
  assert.match(await popup.locator('#video-meta').textContent() || '', /Bilibili/);
  assert.equal(await popup.locator('#video-title').textContent(), 'Bilibili Fixture - P2 第二部分');
  const send = async <T>(type: string, data: Record<string, unknown> = {}) => {
    const reply = await popup.evaluate(message => chrome.runtime.sendMessage(message), { target: 'background', type, tabId, ...data }) as Reply<T>;
    assert.ok(reply.ok, !reply.ok ? reply.error : ''); return reply.value;
  };
  const finish = async (id: string) => {
    for (let i = 0; i < 150; i++) {
      const task = (await send<Task[]>('list')).find(task => task.id === id)!;
      if (['completed', 'failed', 'cancelled'].includes(task.state)) return task;
      await page.waitForTimeout(100);
    }
    throw new Error('Bilibili fixture task did not terminate');
  };
  const info = await send<VideoInfo>('info');
  assert.equal(info.site, 'bilibili'); assert.equal(info.videoId, `bilibili:${bvid}:p2`); assert.ok(sawSession);
  await inline.getByRole('button', { name: '下载当前视频' }).click();
  await popup.locator('#task:not([hidden])').waitFor();
  const created = (await send<Task[]>('list'))[0];
  const done = await finish(created.id);
  assert.equal(done.state, 'completed', done.error); assert.equal(done.site, 'bilibili');
  assert.equal(done.filename, 'Bilibili Fixture - P2 第二部分.mp4');
  assert.equal(peak, 4, JSON.stringify(requests)); assert.ok(requests.some(r => r.range === 'bytes=0-0'));
  assert.ok(requests.every(r => r.referer === 'https://www.bilibili.com/' && r.range));
  const download = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], done.downloadId!);
  const file = await readFile(download.filename); assert.equal(file.length, done.fileSize); assert.equal(download.mime, 'video/mp4');
  const input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
  assert.equal(await (await input.getPrimaryVideoTrack())!.getCodec(), 'avc'); assert.equal(await (await input.getPrimaryAudioTrack())!.getCodec(), 'aac');
  assert.ok(Math.abs(await input.computeDuration() - 8) < .1); input.dispose();
  await mkdir('artifacts', { recursive: true }); await popup.screenshot({ path: resolve('artifacts/bilibili-fixture-preview.png') });
  // The same toolbar control exports AAC in its original audio container.
  const audioChoice = info.choices.find(choice => !choice.videoItag)!;
  await popup.getByLabel('下载清晰度').selectOption(audioChoice.id); await popup.locator('#download').click();
  await popup.locator('.record-status').filter({ hasText: '仅音频' }).waitFor();
  const audioTask = await finish((await send<Task[]>('list'))[0].id);
  assert.equal(audioTask.state, 'completed', audioTask.error); assert.match(audioTask.filename!, /\.m4a$/);
  const audioDownload = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], audioTask.downloadId!);
  const audioInput = new Input({ source: new BufferSource(await readFile(audioDownload.filename)), formats: ALL_FORMATS });
  assert.equal(await audioInput.getPrimaryVideoTrack(), null); assert.equal(await (await audioInput.getPrimaryAudioTrack())!.getCodec(), 'aac'); audioInput.dispose();
  // DOM-driven SPA part changes replace the widget and invalidate old choices.
  await page.evaluate(() => { history.pushState({}, '', '?p=1'); document.querySelector('h1')!.textContent = '第一部分'; });
  await inline.locator('.video-title').filter({ hasText: 'P1 第一部分' }).waitFor({ state: 'attached' });
  assert.equal(await inline.count(), 1); assert.ok(cids.includes('501') && cids.includes('502'));
  const stale = await popup.evaluate(message => chrome.runtime.sendMessage(message), { target: 'background', type: 'start', tabId, videoId: info.videoId, choiceId: info.choices[0].id }) as Reply<Task>;
  assert.equal(stale.ok, false); assert.match(!stale.ok ? stale.error : '', /切换/);
  const part1 = await send<VideoInfo>('info');
  failed = true;
  const rejected = await finish((await send<Task>('start', { videoId: part1.videoId, choiceId: part1.choices[0].id })).id);
  assert.equal(rejected.state, 'failed'); assert.match(rejected.error || '', /失效|验证/); assert.equal(rejected.downloadId, undefined);
  failed = false; slow = true;
  const cancelling = await send<Task>('start', { videoId: part1.videoId, choiceId: part1.choices[0].id });
  await send('cancel', { id: cancelling.id }); assert.equal((await finish(cancelling.id)).state, 'cancelled');
  assert.equal(await popup.evaluate(async id => (await navigator.storage.getDirectory()).getDirectoryHandle(`yt-${id}`).then(() => true, () => false), cancelling.id), false);
  const metadata = JSON.stringify(await send<Task[]>('list'));
  assert.equal(metadata.includes('bilivideo.com'), false); assert.equal(metadata.includes('test-session'), false);
  // A webpage's own CDN request must not receive the extension's Referer rule.
  await context.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Unrelated page</h1>' }));
  const unrelated = await context.newPage(); await unrelated.goto('https://example.test/'); slow = false;
  const status = await unrelated.evaluate(async () => fetch('https://fixture.bilivideo.com/upgcxcode/track.m4s?kind=audio').then(response => response.status, () => 0));
  assert.equal(status, 403, JSON.stringify(requests.at(-1)));
  assert.equal(requests.at(-1)?.referer, 'https://example.test/');
  unavailable = true;
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId); await popup.reload();
  await popup.locator('#notice[data-error]').filter({ hasText: '请先登录' }).waitFor();
  assert.equal(await popup.locator('#download-controls').isHidden(), true);
});
