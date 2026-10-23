import { chromium } from 'playwright';
import { mkdtemp, rm, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Input, BufferSource, ALL_FORMATS } from 'mediabunny';
import { tmpdir } from 'node:os';
import { resolve, join, extname, basename } from 'node:path';
const profile = await mkdtemp(join(tmpdir(), 'youtube-live-'));
const site = process.env.BILIBILI_TEST_URL ? 'bilibili' : 'youtube';
const videoURL = process.env.BILIBILI_TEST_URL || process.env.YOUTUBE_TEST_URL || `https://www.youtube.com/watch?v=${process.env.YOUTUBE_TEST_VIDEO || 'DTi8wZ1a1TA'}`;
await mkdir('test-results', { recursive: true });
const downloadPath = join(profile, 'downloads'); await mkdir(downloadPath);
await mkdir(join(profile, 'Default'));
await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadPath, prompt_for_download: false } }));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: process.env.HEADED !== '1', acceptDownloads: true, downloadsPath: resolve('test-results'),
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', `--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
});
const log = [];
if (process.env.YOUTUBE_TEST_DEBUG === '1') context.on('request', request => {
  const url = new URL(request.url());
  if (url.pathname === '/youtubei/v1/player') {
    try { console.log(JSON.stringify({ playerClient: request.postDataJSON()?.context?.client?.clientName })); } catch {}
  } else if (url.hostname.endsWith('.googlevideo.com') && url.searchParams.has('itag')) {
    console.log(JSON.stringify({ mediaClient: url.searchParams.get('c'), itag: url.searchParams.get('itag'), range: url.searchParams.get('range'), n: url.searchParams.has('n') }));
  }
});
try {
  const downloadSession = await context.browser().newBrowserCDPSession();
  await downloadSession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  await downloadSession.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(site => {
    const origin = chrome.runtime.getURL('').replace(/\/$/, '');
    const active = new Map(); const byTrack = new Map();
    globalThis.rangeStats = { peak: 0, peakPerTrack: 0, requests: 0 };
    chrome.webRequest.onBeforeRequest.addListener(details => {
      const url = new URL(details.url);
      if (details.method !== 'GET' || details.initiator !== origin || site === 'youtube' && !url.searchParams.has('range')) return;
      const track = url.searchParams.get('itag') || url.pathname;
      active.set(details.requestId, track); byTrack.set(track, (byTrack.get(track) || 0) + 1);
      globalThis.rangeStats.requests++;
      globalThis.rangeStats.peak = Math.max(globalThis.rangeStats.peak, active.size);
      globalThis.rangeStats.peakPerTrack = Math.max(globalThis.rangeStats.peakPerTrack, byTrack.get(track));
    }, { urls: ['https://*.googlevideo.com/videoplayback*', 'https://*.bilivideo.com/*', 'https://*.bilivideo.cn/*', 'https://upos-hz-mirrorakam.akamaized.net/*'] });
    const finish = details => {
      const track = active.get(details.requestId);
      if (!track) return;
      active.delete(details.requestId); byTrack.set(track, byTrack.get(track) - 1);
    };
    chrome.webRequest.onCompleted.addListener(finish, { urls: ['https://*.googlevideo.com/videoplayback*', 'https://*.bilivideo.com/*', 'https://*.bilivideo.cn/*', 'https://upos-hz-mirrorakam.akamaized.net/*'] });
    chrome.webRequest.onErrorOccurred.addListener(finish, { urls: ['https://*.googlevideo.com/videoplayback*', 'https://*.bilivideo.com/*', 'https://*.bilivideo.cn/*', 'https://upos-hz-mirrorakam.akamaized.net/*'] });
  }, site);
  const id = new URL(worker.url()).hostname;
  const player = await context.newPage();
  await player.goto(videoURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await player.waitForTimeout(process.env.HEADED === '1' ? 15000 : 8000);
  console.log(JSON.stringify(await player.evaluate(() => { const response = document.querySelector('#shorts-player')?.getPlayerResponse?.() || document.querySelector('#movie_player')?.getPlayerResponse?.() || window.ytInitialPlayerResponse; return { title: document.title, videoId: response?.videoDetails?.videoId, status: response?.playabilityStatus?.status, reason: response?.playabilityStatus?.reason }; })));
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, site === 'bilibili' ? 'https://www.bilibili.com/video/*' : ['https://www.youtube.com/watch*', 'https://www.youtube.com/shorts/*']);
  console.log(JSON.stringify(await worker.evaluate(async tabId => { const session = (await chrome.storage.session.get(`playback-${tabId}`))[`playback-${tabId}`]; return { capturedSession: !!session, videoId: session?.videoId, age: session && Date.now() - session.capturedAt, configLength: session?.ustreamerConfig?.length, poLength: session?.poToken?.length, contexts: session?.contexts?.map(item=>item.type) }; }, tabId)));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await worker.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), tabId);
  await popup.reload();
  await popup.locator('#download-controls:not([hidden])').waitFor();
  const info = await popup.evaluate(tabId => chrome.runtime.sendMessage({ target: 'background', type: 'info', tabId }), tabId);
  if (!info.ok) throw new Error(info.error);
  await player.locator('#yt-local-download-root').scrollIntoViewIfNeeded();
  await player.locator('#yt-local-download-root').getByRole('button', { name: '选择下载清晰度' }).click();
  await player.locator('#yt-local-download-root .option').first().waitFor();
  await mkdir('artifacts', { recursive: true });
  await player.screenshot({ path: resolve(`artifacts/${site}-extension-preview.png`) });
  log.push({ title: info.value.title, choices: info.value.choices.map(item => ({ id: item.id, label: item.label, container: item.container })) });
  const quality = process.env.BILIBILI_TEST_QUALITY || process.env.YOUTUBE_TEST_QUALITY;
  const choice = (quality && info.value.choices.find(item => item.label === quality)) || info.value.choices.find(item => item.videoItag) || info.value.choices[0];
  console.log(JSON.stringify({ selected: choice.label, container: choice.container, estimatedBytes: choice.estimatedBytes }));
  if (process.env.YOUTUBE_TEST_ENTRY === 'popup') {
    await popup.locator('#quality').selectOption(choice.id); await popup.locator('#download').click();
  } else {
    const inline = player.locator('#yt-local-download-root');
    await inline.locator('.option').filter({ hasText: choice.label }).filter({ hasText: choice.container.toUpperCase() }).first().click();
    if (await inline.locator('.menu:popover-open').count()) throw new Error('Quality menu did not collapse');
    await inline.getByRole('button', { name: '下载当前视频' }).click();
  }
  let started;
  for (let i = 0; i < 50; i++) {
    const created = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'list' }));
    started = created.value?.find(task => task.videoId === info.value.videoId);
    if (started) break;
    await popup.waitForTimeout(100);
  }
  if (!started) throw new Error(await popup.locator('#error').textContent() || 'Popup did not create a download task');
  for (let i = 0; i < 180; i++) {
    await popup.waitForTimeout(1000);
    const reply = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'list' }));
    const task = reply.value.find(item => item.id === started.id);
    const previous = log.at(-1);
    if (previous?.state !== task.state || i % 10 === 0) { log.push({ state: task.state, received: task.received, error: task.error }); console.log(JSON.stringify(log.at(-1))); }
    if (['completed', 'failed', 'cancelled'].includes(task.state)) {
      if (task.state !== 'completed') throw new Error(task.error || task.state);
      const files = await worker.evaluate(async downloadId => chrome.downloads.search({ id: downloadId }), task.downloadId);
      const concurrency = await worker.evaluate(() => globalThis.rangeStats);
      if (task.choice.estimatedBytes > 4 * 4 * 1024 * 1024) { assert.equal(concurrency.peak, 4); assert.ok(concurrency.peakPerTrack > 1); }
      console.log(JSON.stringify({ concurrency }));
      assert.equal(extname(files[0].filename), `.${task.choice.container}`);
      assert.equal(task.filename, basename(files[0].filename));
      assert.equal(task.fileSize, files[0].fileSize);
      await popup.locator('.record-title').filter({ hasText: task.filename }).first().waitFor();
      await popup.locator('.record').filter({ hasText: task.filename }).first().locator('.record-size').filter({ hasText: '文件大小' }).waitFor();
      await popup.locator('body').screenshot({ path: resolve(`artifacts/${site}-saved-file-preview.png`) });
      const expectedMime = task.choice.container === 'm4a' ? 'audio/mp4' : `${task.choice.videoItag ? 'video' : 'audio'}/${task.choice.container}`;
      // Chrome's download database also uses extension-based MIME aliases.
      const mimeAliases = task.choice.container === 'm4a' ? ['audio/x-m4a'] : task.choice.container === 'webm' && !task.choice.videoItag ? ['video/webm'] : [];
      assert.ok([expectedMime, ...mimeAliases].includes(files[0].mime), files[0].mime);
      const destination = resolve(`test-results/live-${site === 'bilibili' ? 'bilibili-' : ''}${task.choice.label.replace(/[<>:"/\\|?*]/g, '_')}.${task.choice.container}`);
      await copyFile(files[0].filename, destination);
      const input = new Input({ source: new BufferSource(await readFile(destination)), formats: ALL_FORMATS });
      const video = await input.getPrimaryVideoTrack(); const audio = await input.getPrimaryAudioTrack();
      if (!audio || (!!video !== !!task.choice.videoItag)) throw new Error('Saved file has unexpected audio/video tracks');
      console.log(JSON.stringify({ videoCodec: video && await video.getCodec(), audioCodec: await audio.getCodec(), height: video && await video.getDisplayHeight(), duration: await input.computeDuration() }));
      input.dispose();
      console.log(JSON.stringify({ passed: true, title: task.title, choice: task.choice.label, filename: basename(files[0].filename), mime: files[0].mime, bytes: files[0].fileSize }));
      break;
    }
    if (i === 179) throw new Error('Live download timed out');
  }
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
