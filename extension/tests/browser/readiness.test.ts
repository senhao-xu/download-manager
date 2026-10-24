import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

test('YouTube waits for current video details before showing page controls', { timeout: 30000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'youtube-readiness-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--no-sandbox', '--enable-unsafe-extension-debugging'] });
  t.after(async () => { await context.close(); await rm(profile, { recursive: true, force: true }); });
  const installer = await context.browser()!.newBrowserCDPSession();
  await installer.send('Extensions.loadUnpacked', { path: resolve('dist') }); await installer.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const response = (id: string) => ({ videoDetails: { videoId: id, title: `Fixture ${id}`, lengthSeconds: '8' },
    playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [
      { itag: 248, mimeType: 'video/webm; codecs="vp8"', bitrate: 1000, height: 90, url: 'https://fixture.googlevideo.com/video' },
      { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 16000, audioQuality: 'AUDIO_QUALITY_MEDIUM', url: 'https://fixture.googlevideo.com/audio' },
    ] } });
  await context.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: `<html><body><ytd-watch-flexy video-id="fixture_001"><div id="movie_player"></div><div id="details"></div></ytd-watch-flexy><script>window.ytInitialPlayerResponse=${JSON.stringify(response('fixture_001'))};</script></body></html>` }));
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=fixture_001');
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id!);
  // Explicit recovery makes absence checks meaningful even before the manifest
  // script's document_idle injection. Repeated injection must stay idempotent.
  async function recover() {
    await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] }), tabId);
    await page.waitForTimeout(300);
  }
  const inline = page.locator('#yt-local-download-root');
  await recover();
  assert.equal(await inline.count(), 0, 'player data alone must not reveal the floating button over the loading skeleton');
  await page.evaluate(() => {
    document.querySelector('#details')!.innerHTML = '<ytd-watch-metadata><h1><span id="native-title"> </span></h1><div id="top-level-buttons-computed" style="display:flex;min-height:40px"><span><button aria-label="分享视频">分享</button></span></div></ytd-watch-metadata>';
  });
  await recover();
  assert.equal(await inline.count(), 0, 'an empty native title is still a loading placeholder');
  // Native renderers can update an existing text node without adding children.
  await page.evaluate(() => { document.querySelector('#native-title')!.firstChild!.textContent = 'Fixture details'; });
  await inline.locator('.main').filter({ hasText: '下载 90p' }).waitFor();
  assert.equal(await inline.evaluate(host => host.previousElementSibling?.querySelector('button')?.getAttribute('aria-label')), '分享视频');
  assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  await inline.getByRole('button', { name: '选择下载清晰度' }).click();
  await inline.locator('.menu:popover-open').waitFor();
  await page.evaluate(() => document.querySelector('#movie_player')!.classList.add('ytp-fullscreen'));
  await page.locator('#yt-local-download-root[hidden]').waitFor({ state: 'attached' });
  assert.equal(await inline.locator('.menu:popover-open').count(), 0);
  await page.evaluate(() => document.querySelector('#movie_player')!.classList.remove('ytp-fullscreen'));
  await page.locator('#yt-local-download-root:not([hidden])').waitFor();
  await page.evaluate(() => document.documentElement.requestFullscreen());
  await page.locator('#yt-local-download-root[hidden]').waitFor({ state: 'attached' });
  await page.evaluate(() => document.exitFullscreen());
  await page.locator('#yt-local-download-root:not([hidden])').waitFor();
  await page.evaluate(() => { document.querySelector('#native-title')!.firstChild!.textContent = ''; });
  await page.locator('#yt-local-download-root[hidden]').waitFor({ state: 'attached' });
  await page.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')));
  assert.equal(await inline.isVisible(), false, 'fullscreen updates must not reveal incomplete details');
  await page.evaluate(() => {
    document.querySelector('#top-level-buttons-computed')!.remove();
    document.querySelector('#native-title')!.textContent = 'Fixture details';
  });
  await recover();
  assert.equal(await inline.isVisible(), false, 'a missing action row must not expose the floating fallback during loading');
  await page.evaluate(() => {
    const actions = document.createElement('div'); actions.id = 'top-level-buttons-computed'; actions.style.minHeight = '40px';
    document.querySelector('ytd-watch-metadata')!.append(actions);
  });
  await page.locator('ytd-watch-metadata #yt-local-download-root:not([hidden])').waitFor();
  // Reload with the extension already installed: the skeleton stays untouched.
  await page.reload(); await recover(); assert.equal(await inline.count(), 0);
  await page.evaluate(() => { document.querySelector('#details')!.innerHTML = '<ytd-watch-metadata><h1>Fixture details</h1><div id="top-level-buttons-computed" style="min-height:40px"></div></ytd-watch-metadata>'; });
  await inline.locator('.main').filter({ hasText: '下载 90p' }).waitFor();
  await page.evaluate(() => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    history.pushState({}, '', '/watch?v=fixture_002');
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  assert.equal(await inline.isVisible(), false, 'hide the old video control as soon as navigation starts');
  await page.evaluate(() => document.dispatchEvent(new Event('yt-navigate-finish')));
  await recover();
  assert.equal(await inline.count(), 0, 'old native details must not reveal controls for the new video');
  await page.evaluate(value => {
    (window as Window & { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = value;
    document.querySelector('h1')!.textContent = 'Next video details';
    document.querySelector('ytd-watch-flexy')!.setAttribute('video-id', 'fixture_002');
  }, response('fixture_002'));
  await inline.locator('.main').filter({ hasText: '下载 90p' }).waitFor();
  await inline.getByRole('button', { name: '选择下载清晰度' }).click();
  assert.equal(await inline.locator('.video-title').textContent(), 'Fixture fixture_002');
});
