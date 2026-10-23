import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { Input, Output, BufferSource, BufferTarget, WebMOutputFormat, ALL_FORMATS, Conversion } from 'mediabunny';
import type { PageSnapshot, Reply, Task } from '../../src/types';
import { bytes } from '../../src/core';

const clip = await readFile(new URL('../../../frontend/tests/fixtures/playback.webm', import.meta.url));
async function split(audio: boolean) {
  const input = new Input({ source: new BufferSource(clip), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ target, format: new WebMOutputFormat() });
  const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' }, video: { discard: audio }, audio: { discard: !audio } });
  await conversion.execute(); input.dispose(); return Buffer.from(target.buffer!);
}

test('real MV3 package downloads, muxes, persists and cancels without a server', { timeout: 60000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'yt-extension-test-'));
  const downloadPath = join(profile, 'downloads'); await mkdir(downloadPath);
  await mkdir(join(profile, 'Default'));
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadPath, prompt_for_download: false } }));
  execFileSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-subj', '/CN=fixture.googlevideo.com', '-keyout', join(profile, 'key.pem'), '-out', join(profile, 'cert.pem'), '-days', '1'], { stdio: 'pipe' });
  const [video, audio] = await Promise.all([split(false), split(true)]);
  const padding = Buffer.alloc(9); padding[0] = 0xec;
  padding.writeBigUInt64BE((1n << 56n) | BigInt(5 * 4 * 1024 * 1024), 1);
  const largeVideo = Buffer.concat([video, padding, Buffer.alloc(5 * 4 * 1024 * 1024)]);
  let slow = false; let fail = false; let large = false; let activeRequests = 0; let peakRequests = 0;
  const heldAudio: (() => void)[] = [];
  const server = createServer({ key: await readFile(join(profile, 'key.pem')), cert: await readFile(join(profile, 'cert.pem')) }, (request, response) => {
    const params = new URL(request.url!, 'https://fixture.googlevideo.com').searchParams;
    const isVideo = params.get('kind') === 'video';
    const body = isVideo ? large ? largeVideo : video : audio; const rejected = fail && !isVideo;
    const range = params.get('range')?.split('-').map(Number);
    const start = range?.[0] || 0; const end = range?.[1] ?? body.length - 1;
    activeRequests++; peakRequests = Math.max(peakRequests, activeRequests);
    response.once('close', () => { activeRequests--; });
    const send = () => {
      response.writeHead(rejected ? 403 : 200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
      response.end(rejected ? 'expired' : body.subarray(start, end + 1));
    };
    // Make audio fail first: aborting its sibling must preserve the real error.
    if (slow) { if (isVideo) setTimeout(send, 350); else heldAudio.push(send); }
    else if (fail && isVideo) setTimeout(send, 400); else if (large) setTimeout(send, start === 0 ? 80 : 10); else send();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, acceptDownloads: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', '--enable-unsafe-extension-debugging', '--ignore-certificate-errors', '--no-proxy-server', `--host-resolver-rules=MAP fixture.googlevideo.com 127.0.0.1:${port}`] });
  t.after(async () => { await context.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(profile, { recursive: true, force: true }); });
  const raw: PageSnapshot = { videoId: 'fixture_001', title: 'Fixture / 音画', duration: 8, status: 'OK', live: false, client: {}, formats: [
    { itag: 248, mimeType: 'video/webm; codecs="vp8"', bitrate: 1000, height: 90, fps: 10, url: 'https://fixture.googlevideo.com/videoplayback?kind=video', contentLength: String(video.length) },
    { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 16000, audioQuality: 'AUDIO_QUALITY_MEDIUM', url: 'https://fixture.googlevideo.com/videoplayback?kind=audio', contentLength: String(audio.length) },
  ] };
  const observed: string[] = [];
  context.on('request', request => observed.push(request.url()));
  const response = { videoDetails: { videoId: raw.videoId, title: raw.title, lengthSeconds: '8' }, playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: raw.formats } };
  let sabrOnly = false; let playerRequests = 0; let fixtureReady = false;
  await context.route('https://www.youtube.com/**', route => {
    if (new URL(route.request().url()).pathname === '/youtubei/v1/player') {
      playerRequests++;
      const body = route.request().postDataJSON();
      assert.equal(body.videoId, response.videoDetails.videoId);
      assert.equal(body.context.client.clientName, 'VISIONOS');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
    }
    const native = sabrOnly ? { ...response, streamingData: { serverAbrStreamingUrl: 'https://fixture.googlevideo.com/videoplayback?id=sabr-only', adaptiveFormats: raw.formats.map(({ url, ...format }) => format) } } : response;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><head><meta charset="utf-8"></head><body><div id="movie_player"></div><ytd-watch-metadata><div id="top-level-buttons-computed"></div></ytd-watch-metadata><script>window.ytInitialPlayerResponse=${fixtureReady ? JSON.stringify(native) : 'undefined'};window.fixtureReads=0;document.querySelector('#movie_player').getPlayerResponse=()=>{window.fixtureReads++;return window.ytInitialPlayerResponse;};</script></body></html>` });
  });
  const page = await context.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${raw.videoId}`);
  assert.equal(await page.locator('#yt-local-download-root').count(), 0);
  // Install only after the video tab is open: manifest content scripts alone
  // never inject into this existing document. Exercise onInstalled recovery.
  const installer = await context.browser()!.newBrowserCDPSession();
  // Opt out of Playwright's GUID renaming so the final media suffix is tested.
  await installer.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  const { id: extensionId } = await installer.send('Extensions.loadUnpacked', { path: resolve('dist') });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await installer.detach();
  const inline = page.locator('#yt-local-download-root');
  // Installation precedes player readiness. A delayed response must update
  // quality automatically, without opening the menu or receiving media events.
  await inline.locator('.main').filter({ hasText: '正在重试清晰度' }).waitFor();
  await page.evaluate(value => { (window as Window & { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = value; }, response);
  fixtureReady = true;
  await inline.locator('.main:not([disabled])').filter({ hasText: '下载 90p' }).waitFor();
  assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  await inline.getByRole('button', { name: '选择下载清晰度' }).click();
  await inline.locator('.option').filter({ hasText: '90p' }).waitFor();
  assert.equal(await page.locator('#yt-local-download-root').count(), 1);
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id!);
  // Check the native toolbar popup: a normal tab has a wide viewport and cannot
  // reproduce Chrome's initial popup sizing (the reported narrow-column bug).
  await worker.evaluate(() => chrome.action.openPopup());
  const cdp = await context.browser()!.newBrowserCDPSession();
  const popupTarget = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url === `chrome-extension://${extensionId}/popup.html`)!;
  assert.ok(popupTarget);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: false });
  const dimensions = new Promise<{ width: number; scrollWidth: number }>(resolve => {
    cdp.on('Target.receivedMessageFromTarget', event => {
      const message = JSON.parse(event.message);
      if (event.sessionId === sessionId && message.id === 1) resolve(message.result.result.value);
    });
  });
  await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '({width:innerWidth,scrollWidth:document.body.scrollWidth})', returnByValue: true } }) });
  assert.deepEqual(await dimensions, { width: 400, scrollWidth: 400 });
  await cdp.send('Target.closeTarget', { targetId: popupTarget.targetId }); await cdp.detach();
  let popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // A tab used as a popup test surface must leave the video as the active tab.
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
  await popup.reload();
  await popup.locator('#download-controls:not([hidden])').waitFor();
  assert.equal(await popup.locator('#video-title').textContent(), raw.title);
  assert.equal(await popup.getByLabel('下载清晰度').isVisible(), true);
  assert.equal(await popup.getByRole('button', { name: '下载 90p', exact: false }).isEnabled(), true);
  assert.equal(await popup.locator('[popover]').count(), 0);
  assert.equal(await popup.evaluate(() => document.documentElement.getBoundingClientRect().width), 400);
  assert.match(await popup.locator('#version').textContent() || '', /^版本 0\.1\./);
  const send = async <T>(type: string, data: Record<string, unknown> = {}) => {
    const reply = await popup.evaluate(async message => chrome.runtime.sendMessage(message), { target: 'background', type, tabId, ...data }) as Reply<T>;
    assert.ok(reply.ok, !reply.ok ? reply.error : ''); return reply.value;
  };
  const info = await send<{ videoId: string; choices: { id: string }[] }>('info');
  assert.equal(info.videoId, raw.videoId);
  // Re-injection is idempotent, and a detached host is recovered without reloading.
  for (let i = 0; i < 2; i++) await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] }), tabId);
  await page.evaluate(() => document.querySelector('#yt-local-download-root')!.remove());
  await send('info');
  await inline.waitFor();
  assert.equal(await inline.count(), 1);
  // Ignore a hidden old action row. Place the control after a translated Share.
  await page.evaluate(() => {
    document.querySelector('ytd-watch-metadata')!.innerHTML = '<div id="top-level-buttons-computed" hidden></div><div id="top-level-buttons-computed" class="visible-actions"><span><button aria-label="分享视频">分享</button></span></div>';
  });
  await page.locator('.visible-actions #yt-local-download-root').waitFor();
  assert.equal(await inline.evaluate(host => host.previousElementSibling?.querySelector('button')?.getAttribute('aria-label')), '分享视频');
  // Alternative/new action layouts have a visible fallback. Missing metadata
  // temporarily uses a floating control, then moves back when YouTube renders it.
  await page.evaluate(() => { document.querySelector('ytd-watch-metadata')!.innerHTML = '<div id="actions-inner" style="display:flex"></div>'; });
  await page.locator('#actions-inner #yt-local-download-root').waitFor();
  await page.evaluate(() => document.querySelector('ytd-watch-metadata')!.remove());
  await page.locator('#yt-local-download-root[data-floating]').waitFor();
  assert.equal(await inline.getByRole('button', { name: '下载当前视频' }).isVisible(), true);
  await page.evaluate(() => { const metadata = document.createElement('ytd-watch-metadata'); metadata.innerHTML = '<div id="top-level-buttons-computed"></div>'; document.body.append(metadata); });
  await page.locator('ytd-watch-metadata #yt-local-download-root:not([data-floating])').waitFor();
  await inline.getByRole('button', { name: '选择下载清晰度' }).click();
  await inline.locator('.option').filter({ hasText: '90p' }).waitFor();
  await inline.locator('.option').filter({ hasText: '90p' }).click();
  assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  assert.match(await inline.locator('.main').textContent() || '', /下载 90p/);
  await inline.getByRole('button', { name: '下载当前视频' }).click();
  assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  let task: Task | undefined;
  for (let i = 0; i < 30; i++) { task = (await send<Task[]>('list'))[0]; if (task) break; await popup.waitForTimeout(100); }
  assert.ok(task);
  let done: Task | undefined;
  for (let i = 0; i < 150; i++) {
    done = (await send<Task[]>('list')).find(item => item.id === task.id);
    if (done?.state === 'failed') assert.fail(JSON.stringify({ error: done.error, requests: observed.filter(url => url.includes('googlevideo.com')) }));
    if (done?.state === 'completed') break;
    await popup.waitForTimeout(100);
  }
  assert.equal(done?.state, 'completed');
  assert.equal(done?.filename, 'Fixture _ 音画.webm');
  await inline.getByRole('button', { name: '选择下载清晰度' }).click();
  await inline.locator('.status').waitFor({ state: 'visible' });
  assert.equal(await inline.locator('.status progress').isVisible(), false);
  assert.equal(await inline.locator('.inline-progress').isVisible(), false);
  await inline.getByRole('button', { name: '选择下载清晰度' }).click();
  await inline.locator('.menu:popover-open').waitFor({ state: 'hidden' });
  const download = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], done!.downloadId!);
  assert.equal(download.filename, join(downloadPath, 'Fixture _ 音画.webm'), JSON.stringify({ filename: download.filename, mime: download.mime }));
  assert.equal(download.mime, 'video/webm');
  const file = await readFile(download.filename);
  assert.equal(done!.fileSize, file.length);
  const input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
  assert.equal(await (await input.getPrimaryVideoTrack())!.getCodec(), 'vp8');
  assert.equal(await (await input.getPrimaryAudioTrack())!.getCodec(), 'opus');
  assert.ok(Math.abs((await input.computeDuration()) - 8) < .05); input.dispose();
  await popup.reload(); assert.equal((await send<Task[]>('list'))[0].state, 'completed');
  const completedRecord = popup.locator('.record').filter({ hasText: done!.filename! });
  await completedRecord.locator('.record-size').filter({ hasText: `文件大小 ${bytes(file.length)}` }).waitFor();
  assert.equal(await completedRecord.locator('.record-progress').count(), 0);
  // The new primary popup action starts a real task; formats and preference are
  // shared with the inline menu, without another menu-opening click.
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
  await popup.reload(); await popup.locator('#download-controls:not([hidden])').waitFor();
  const audioId = await popup.locator('#quality optgroup[label="仅音频"] option').first().getAttribute('value');
  assert.ok(audioId); await popup.getByLabel('下载清晰度').selectOption(audioId);
  assert.equal(await popup.locator('#format-hint').textContent(), '仅保存音频 · 保留原始音质');
  await popup.locator('#download').click();
  let audioTask: Task | undefined;
  for (let i = 0; i < 100; i++) {
    audioTask = (await send<Task[]>('list')).find(value => value.choice.id === audioId);
    if (audioTask && ['completed', 'failed'].includes(audioTask.state)) break;
    await popup.waitForTimeout(100);
  }
  assert.equal(audioTask?.state, 'completed', audioTask?.error);
  const audioDownload = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], audioTask!.downloadId!);
  assert.match(audioDownload.filename, /\.webm$/);
  // Chrome can normalize the .webm container to video/webm for audio-only too.
  assert.ok(['audio/webm', 'video/webm'].includes(audioDownload.mime));
  const audioInput = new Input({ source: new BufferSource(await readFile(audioDownload.filename)), formats: ALL_FORMATS });
  assert.equal(await audioInput.getPrimaryVideoTrack(), null);
  assert.equal(await (await audioInput.getPrimaryAudioTrack())!.getCodec(), 'opus'); audioInput.dispose();
  await popup.getByLabel('下载清晰度').selectOption(info.choices[0].id);
  assert.equal(await popup.evaluate(async id => (await navigator.storage.getDirectory()).getDirectoryHandle(`yt-${id}`).then(() => true, () => false), task.id), false);
  const metadata = JSON.stringify(await send<Task[]>('list'));
  assert.equal(metadata.includes('googlevideo.com'), false);
  // Strict extension CSP permits only the locally packaged WASM runtime.
  assert.ok(await popup.evaluate(async () => !!await WebAssembly.compileStreaming(fetch(chrome.runtime.getURL('quickjs.wasm')))));
  slow = true;
  await popup.locator('#download').click();
  await popup.locator('#cancel:not([hidden])').waitFor();
  const cancelled = (await send<Task[]>('list'))[0];
  assert.notEqual(cancelled.id, task.id);
  await inline.locator('.inline-progress[value]').waitFor({ state: 'visible' });
  const percent = Number(await inline.locator('.inline-progress').getAttribute('value'));
  assert.ok(percent > 0 && percent < 100);
  assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  assert.match(await inline.locator('.main').textContent() || '', new RegExp(`${percent}%`));
  assert.equal(await popup.locator('#progress').getAttribute('value'), String(percent));
  const transferSize = `${bytes(video.length)} / 约 ${bytes(video.length + audio.length)}`;
  await popup.locator('#task-size').filter({ hasText: transferSize }).waitFor();
  assert.equal(await popup.locator('.record').first().locator('.record-progress').getAttribute('value'), String(percent));
  await popup.locator('.record').first().locator('.record-size').filter({ hasText: transferSize }).waitFor();
  await mkdir('artifacts', { recursive: true });
  await inline.screenshot({ path: resolve('artifacts/youtube-progress-preview.png') });
  await popup.close();
  // Progress remains visible with the toolbar popup closed and after reloading
  // the YouTube tab. Its backing transfer continues in the offscreen worker.
  await page.reload();
  await inline.locator('.inline-progress[value]').waitFor({ state: 'visible' });
  assert.equal(await inline.locator('.inline-progress').getAttribute('value'), String(percent));
  popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.bringToFront(); await popup.reload();
  await popup.locator('#video-title').filter({ hasText: '先打开一个 YouTube 视频' }).waitFor();
  await popup.locator('.record').first().locator('.record-progress[value]').waitFor({ state: 'visible' });
  assert.equal(await popup.locator('.record').first().locator('.record-progress').getAttribute('value'), String(percent));
  assert.match(await popup.locator('.record').first().locator('.record-status').textContent() || '', new RegExp(`${percent}%`));
  await popup.locator('.record').first().locator('.record-size').filter({ hasText: transferSize }).waitFor();
  await popup.locator('body').screenshot({ path: resolve('artifacts/youtube-history-progress-preview.png') });
  assert.equal(['queued', 'resolving', 'downloading'].includes((await send<Task[]>('list')).find(item => item.id === cancelled.id)!.state), true);
  await send('cancel', { id: cancelled.id });
  for (const release of heldAudio.splice(0)) release();
  await inline.locator('.inline-progress').waitFor({ state: 'hidden' });
  await popup.locator('.record').first().locator('.record-progress').waitFor({ state: 'hidden' });
  await popup.waitForTimeout(300);
  assert.equal((await send<Task[]>('list')).find(item => item.id === cancelled.id)!.state, 'cancelled');
  assert.equal(await popup.evaluate(async id => (await navigator.storage.getDirectory()).getDirectoryHandle(`yt-${id}`).then(() => true, () => false), cancelled.id), false);
  // Exercise phases too short to catch reliably during a tiny fixture mux.
  const present = async (state: Task['state'], total?: number, received = 50) => {
    await worker.evaluate(async value => {
      const tasks = (await chrome.storage.local.get('tasks')).tasks as Task[];
      const task = tasks.find(item => item.id === value.id)!;
      task.state = value.state; task.total = value.total; task.received = value.received;
      if (value.state === 'downloading' && value.total === undefined) task.choice.estimatedBytes = undefined;
      await chrome.storage.local.set({ tasks });
    }, { id: cancelled.id, state, total, received });
    await page.waitForFunction(label => document.querySelector('#yt-local-download-root')!.shadowRoot!.querySelector('.main span')!.textContent === label, state === 'downloading' ? '正在下载' : state === 'merging' ? '正在合并音画' : '正在保存文件');
  };
  await present('downloading');
  assert.equal(await inline.locator('.inline-progress').isVisible(), true);
  assert.equal(await inline.locator('.inline-progress').getAttribute('value'), null);
  await popup.locator('.record').first().locator('.record-size').filter({ hasText: '50 B / 总大小未知' }).waitFor();
  assert.equal(await popup.locator('.record').first().locator('.record-progress').getAttribute('value'), null);
  for (const state of ['merging', 'saving'] as const) {
    await present(state, 100, 120);
    assert.equal(await inline.locator('.inline-progress').isVisible(), true);
    assert.equal(await inline.locator('.inline-progress').getAttribute('value'), null);
    assert.doesNotMatch(await inline.locator('.main').textContent() || '', /100%/);
    assert.equal(await popup.locator('.record').first().locator('.record-progress').getAttribute('value'), null);
  }
  await worker.evaluate(async id => {
    const tasks = (await chrome.storage.local.get('tasks')).tasks as Task[];
    tasks.find(item => item.id === id)!.state = 'cancelled'; await chrome.storage.local.set({ tasks });
  }, cancelled.id);
  await inline.locator('.inline-progress').waitFor({ state: 'hidden' });
  slow = false; fail = true;
  const failed = await send<Task>('start', { videoId: raw.videoId, choiceId: info.choices[0].id });
  let failure: Task | undefined;
  for (let i = 0; i < 50; i++) { failure = (await send<Task[]>('list')).find(item => item.id === failed.id); if (failure?.state === 'failed') break; await popup.waitForTimeout(100); }
  assert.equal(failure?.state, 'failed'); assert.match(failure?.error || '', /失效|验证/);
  // Keep the injected function literal free of tsx's function-name helper.
  const [forged] = await worker.evaluate<Array<{ result?: Reply<unknown> }>>(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: async id => chrome.runtime.sendMessage({ target: 'background', type: 'progress', id, state: 'completed', received: 99999 }), args: [${JSON.stringify(cancelled.id)}] })`);
  assert.equal(forged.result?.ok, false);
  fail = false; response.videoDetails.lengthSeconds = '20';
  await page.reload();
  const incomplete = await send<Task>('start', { videoId: raw.videoId, choiceId: info.choices[0].id });
  let incompleteTask: Task | undefined;
  for (let i = 0; i < 50; i++) { incompleteTask = (await send<Task[]>('list')).find(item => item.id === incomplete.id); if (incompleteTask?.state === 'failed') break; await popup.waitForTimeout(100); }
  assert.equal(incompleteTask?.state, 'failed'); assert.match(incompleteTask?.error || '', /未下载完整/);
  assert.equal(await popup.evaluate(async id => (await navigator.storage.getDirectory()).getDirectoryHandle(`yt-${id}`).then(() => true, () => false), incomplete.id), false);
  await page.evaluate(() => { history.pushState({}, '', '/watch?v=fixture_002'); document.dispatchEvent(new Event('yt-navigate-finish')); });
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#yt-local-download-root').count(), 1);
  await page.locator('#yt-local-download-root').getByRole('button', { name: '选择下载清晰度' }).click();
  await page.locator('#yt-local-download-root .notice').filter({ hasText: '正在加载' }).waitFor();
  assert.equal(await page.locator('#yt-local-download-root .option').count(), 0);
  // Loading errors are visible in the popup itself and offer a direct retry.
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
  await popup.reload(); await popup.locator('#notice[data-error]').waitFor();
  assert.match(await popup.locator('#notice').textContent() || '', /正在加载/);
  assert.equal(await popup.getByRole('button', { name: '重新读取' }).isVisible(), true);
  assert.equal(await popup.locator('#download-controls').isHidden(), true);
  // Metadata was unavailable during preload. A single main-button click must
  // load it and start downloading, rather than merely opening the format menu.
  await page.evaluate(value => { (window as Window & { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = value; }, { ...response, videoDetails: { ...response.videoDetails, videoId: 'fixture_002', lengthSeconds: '8' } });
  await inline.getByRole('button', { name: '下载当前视频' }).click();
  let firstClick: Task | undefined;
  for (let i = 0; i < 100; i++) {
    firstClick = (await send<Task[]>('list')).find(value => value.videoId === 'fixture_002');
    if (firstClick && ['completed', 'failed'].includes(firstClick.state)) break;
    await page.waitForTimeout(100);
  }
  assert.equal(firstClick?.state, 'completed', firstClick?.error);
  assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  // Exhaust automatic retries on an unavailable SPA player. They stop, expose
  // a retry action/error, and can still recover on a later media-ready event.
  await page.evaluate(() => { history.pushState({}, '', '/watch?v=fixture_007'); document.dispatchEvent(new Event('yt-navigate-finish')); });
  await inline.locator('.main').filter({ hasText: '重试获取清晰度' }).waitFor({ timeout: 20000 });
  assert.match(await inline.locator('.main').getAttribute('title') || '', /正在加载/);
  const reads = () => page.evaluate(() => (window as Window & { fixtureReads?: number }).fixtureReads || 0);
  const exhaustedReads = await reads();
  await page.waitForTimeout(1200);
  assert.equal(await reads(), exhaustedReads);
  await page.evaluate(value => {
    (window as Window & { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = value;
    const video = document.createElement('video'); video.id = 'readiness-fixture'; document.body.append(video);
    video.dispatchEvent(new Event('loadedmetadata')); video.dispatchEvent(new Event('playing'));
  }, { ...response, videoDetails: { ...response.videoDetails, videoId: 'fixture_007' }, streamingData: { adaptiveFormats: [...raw.formats, { ...raw.formats[0], itag: 313, height: 2160, fps: 60 }] } });
  await inline.locator('.main:not([disabled])').filter({ hasText: '下载 2160p' }).waitFor();
  assert.equal(await reads(), exhaustedReads + 1); // Both events share one read.
  assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  await inline.getByRole('button', { name: '选择下载清晰度' }).click();
  await inline.locator('.option').filter({ hasText: '90p' }).click();
  await page.evaluate(() => document.querySelector('#readiness-fixture')!.dispatchEvent(new Event('playing')));
  assert.match(await inline.locator('.main').textContent() || '', /下载 90p/);
  assert.equal(await reads(), exhaustedReads + 1); // Preserve explicit selection.
  // A discarded video's scheduled retry must not read or overwrite the new one.
  await page.evaluate(() => { history.pushState({}, '', '/watch?v=fixture_008'); document.dispatchEvent(new Event('yt-navigate-finish')); });
  await inline.locator('.main').filter({ hasText: '正在重试清晰度' }).waitFor();
  await page.evaluate(value => {
    history.pushState({}, '', '/watch?v=fixture_009');
    (window as Window & { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = value;
    document.dispatchEvent(new Event('yt-navigate-finish'));
  }, { ...response, videoDetails: { ...response.videoDetails, videoId: 'fixture_009' } });
  await inline.locator('.main:not([disabled])').filter({ hasText: '下载 90p' }).waitFor();
  const currentReads = await reads();
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('#readiness-fixture')!.dispatchEvent(new Event('playing')));
  assert.equal(await reads(), currentReads); // Old timer/listeners were removed.
  assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  // No captured SABR session exists. Resolve actual direct source formats and
  // download from one click; info/start reuse the same short-lived resolution.
  sabrOnly = true; response.videoDetails.videoId = 'fixture_004'; response.videoDetails.lengthSeconds = '8';
  await page.goto('https://www.youtube.com/watch?v=fixture_004');
  await inline.locator('.main:not([disabled])').filter({ hasText: '下载 90p' }).waitFor();
  await inline.getByRole('button', { name: '下载当前视频' }).click();
  let recovered: Task | undefined;
  for (let i = 0; i < 100; i++) {
    recovered = (await send<Task[]>('list')).find(value => value.videoId === 'fixture_004');
    if (recovered && ['completed', 'failed'].includes(recovered.state)) break;
    await page.waitForTimeout(100);
  }
  assert.equal(recovered?.state, 'completed', recovered?.error);
  assert.equal(playerRequests, 1);
  fail = true;
  const expired = await send<Task>('start', { videoId: 'fixture_004', choiceId: info.choices[0].id });
  for (let i = 0; i < 50; i++) {
    const state = (await send<Task[]>('list')).find(value => value.id === expired.id)?.state;
    if (state === 'failed') break;
    await page.waitForTimeout(100);
  }
  assert.equal((await send<Task[]>('list')).find(value => value.id === expired.id)?.state, 'failed');
  fail = false;
  const retry = await send<Task>('start', { videoId: 'fixture_004', choiceId: info.choices[0].id });
  for (let i = 0; i < 100; i++) {
    const state = (await send<Task[]>('list')).find(value => value.id === retry.id)?.state;
    if (state === 'completed' || state === 'failed') break;
    await page.waitForTimeout(100);
  }
  assert.equal((await send<Task[]>('list')).find(value => value.id === retry.id)?.state, 'completed');
  assert.equal(playerRequests, 2); // Failed signed sources are re-resolved for retry.
  // Download a real, valid WebM with trailing EBML Void padding. This requires
  // multiple ranges in the actual worker, including out-of-order completions.
  // Lose the initial filename: the final hook must recover the title rather
  // than letting Chrome use the UUID of its temporary blob URL.
  await worker.evaluate('globalThis.testDownload = chrome.downloads.download; chrome.downloads.download = options => { const { filename, ...rest } = options; return globalThis.testDownload.call(chrome.downloads, rest); }; true');
  large = true; peakRequests = 0; sabrOnly = false;
  raw.formats[0].contentLength = String(largeVideo.length);
  response.videoDetails.videoId = 'fixture_005';
  await page.goto('https://www.youtube.com/watch?v=fixture_005');
  await inline.locator('.main:not([disabled])').filter({ hasText: '下载 90p' }).waitFor();
  await inline.getByRole('button', { name: '下载当前视频' }).click();
  let parallel: Task | undefined;
  for (let i = 0; i < 150; i++) {
    parallel = (await send<Task[]>('list')).find(value => value.videoId === 'fixture_005');
    if (parallel && ['completed', 'failed'].includes(parallel.state)) break;
    await page.waitForTimeout(100);
  }
  assert.equal(parallel?.state, 'completed', parallel?.error);
  assert.equal(peakRequests, 4);
  assert.match(parallel!.filename!, /^Fixture _ 音画(?: \(\d+\))?\.webm$/);
  const parallelDownload = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], parallel!.downloadId!);
  const parallelInput = new Input({ source: new BufferSource(await readFile(parallelDownload.filename)), formats: ALL_FORMATS });
  assert.equal(await (await parallelInput.getPrimaryVideoTrack())!.getCodec(), 'vp8');
  assert.equal(await (await parallelInput.getPrimaryAudioTrack())!.getCodec(), 'opus');
  assert.ok(Math.abs(await parallelInput.computeDuration() - 8) < .05); parallelInput.dispose();
  await worker.evaluate('chrome.downloads.download = globalThis.testDownload; delete globalThis.testDownload; true');
  // A corrupt/lost Blob MIME is different: Chrome may change even a suggested
  // suffix after determination. Detect it before creating a text download.
  const naming = await context.browser()!.newBrowserCDPSession();
  const offscreenTarget = (await naming.send('Target.getTargets')).targetInfos.find(target => target.url === `chrome-extension://${extensionId}/offscreen.html`)!;
  assert.ok(offscreenTarget);
  const { sessionId: offscreenSession } = await naming.send('Target.attachToTarget', { targetId: offscreenTarget.targetId, flatten: false });
  const mutateMime = new Promise<void>(resolve => naming.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId === offscreenSession && JSON.parse(event.message).id === 1) { assert.equal(JSON.parse(event.message).result?.exceptionDetails, undefined); resolve(); }
  }));
  await naming.send('Target.sendMessageToTarget', { sessionId: offscreenSession, message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: 'window.testObjectURL = URL.createObjectURL; URL.createObjectURL = file => window.testObjectURL.call(URL, new Blob([file])); true' } }) });
  await mutateMime; await naming.detach();
  large = false; raw.formats[0].contentLength = String(video.length); response.videoDetails.videoId = 'fixture_006';
  await page.goto('https://www.youtube.com/watch?v=fixture_006');
  const badMime = await send<Task>('start', { videoId: 'fixture_006', choiceId: info.choices[0].id });
  let rejectedMime: Task | undefined;
  for (let i = 0; i < 100; i++) {
    rejectedMime = (await send<Task[]>('list')).find(value => value.id === badMime.id);
    if (rejectedMime?.state === 'failed') break;
    await page.waitForTimeout(100);
  }
  assert.equal(rejectedMime?.state, 'failed'); assert.match(rejectedMime?.error || '', /媒体类型/);
  assert.equal(rejectedMime?.downloadId, undefined);
  // A 0.1.4 record has received bytes but no saved fileSize. Restart just the
  // service worker to exercise startup backfill from Chrome's real download.
  await worker.evaluate(async id => {
    const tasks = (await chrome.storage.local.get('tasks')).tasks as Task[];
    delete tasks.find(item => item.id === id)!.fileSize;
    await chrome.storage.local.set({ tasks });
  }, done!.id);
  const recovery = await context.newCDPSession(popup);
  const running = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Extension worker version was not reported')), 5000);
    recovery.on('ServiceWorker.workerVersionUpdated', event => {
      const version = event.versions.find(value => value.scriptURL === `chrome-extension://${extensionId}/background.js` && value.runningStatus === 'running');
      if (version) { clearTimeout(timeout); resolve(version.versionId); }
    });
  });
  await recovery.send('ServiceWorker.enable');
  await recovery.send('ServiceWorker.stopWorker', { versionId: await running });
  assert.equal((await send<Task[]>('list')).find(value => value.id === done!.id)!.fileSize, file.length);
  await recovery.detach();
  await page.evaluate(() => { history.pushState({}, '', '/watch?v=fixture_003'); document.dispatchEvent(new Event('yt-navigate-finish')); });
  await page.waitForTimeout(350);
  // Replacing an unpacked extension in an existing tab must replace its orphan
  // UI. The next click must use the fresh context. CDP-installed extensions are
  // temporary, so explicitly reinstall instead of chrome.runtime.reload().
  const replacement = await context.browser()!.newBrowserCDPSession();
  await replacement.send('Extensions.uninstall', { id: extensionId });
  await replacement.send('Extensions.loadUnpacked', { path: resolve('dist') });
  await replacement.detach();
  await page.waitForTimeout(500);
  assert.equal(await inline.count(), 1);
  await inline.getByRole('button', { name: '下载当前视频' }).click();
  await inline.locator('.notice').filter({ hasText: '正在加载' }).waitFor();
  const offscreen = context.backgroundPages(); // Offscreen execution is not a visible app tab.
  assert.equal(offscreen.length, 0);
  assert.equal(observed.some(url => /^https?:\/\/(localhost|127\.)/.test(url)), false);
});
