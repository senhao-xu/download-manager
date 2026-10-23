import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { Input, BufferSource, ALL_FORMATS } from 'mediabunny';

const entries = JSON.parse(process.env.BATCH_TEST_ENTRIES || JSON.stringify([
  { videoId: 'DTi8wZ1a1TA', title: 'YouTube test', url: 'https://www.youtube.com/watch?v=DTi8wZ1a1TA' },
  { videoId: 'bilibili:BV1GJ411x7h7:p1', title: 'Bilibili test', url: 'https://www.bilibili.com/video/BV1GJ411x7h7/' },
]));
const profile = await mkdtemp(join(tmpdir(), 'live-batch-'));
const downloads = join(profile, 'downloads'); await mkdir(downloads); await mkdir(join(profile, 'Default'));
await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, acceptDownloads: true,
  ignoreDefaultArgs: ['--enable-automation'], args: ['--no-sandbox', `--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
try {
  const cdp = await context.browser().newBrowserCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }); await cdp.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const manager = await context.newPage(); await manager.goto(`chrome-extension://${new URL(worker.url()).hostname}/batch.html`);
  const added = await manager.evaluate(entries => chrome.runtime.sendMessage({ target: 'background', type: 'enqueue', entries, quality: '720' }), entries);
  assert.ok(added.ok, added.error); assert.equal(added.value, entries.length);
  let tasks = []; let previous = '';
  for (let attempt = 0; attempt < 180; attempt++) {
    tasks = (await manager.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'list' }))).value;
    const summary = tasks.map(task => ({ videoId: task.videoId, state: task.state, received: task.received, error: task.error }));
    const states = summary.map(task => task.state).join(',');
    if (states !== previous || attempt % 10 === 0) { console.log(JSON.stringify(summary)); previous = states; }
    assert.ok(tasks.filter(task => !['queued', 'completed', 'failed', 'cancelled'].includes(task.state)).length <= 1);
    if (tasks.length === entries.length && tasks.every(task => ['completed', 'failed', 'cancelled'].includes(task.state))) break;
    await manager.waitForTimeout(1000);
  }
  const evidence = [];
  for (const task of tasks) {
    assert.equal(task.state, 'completed', task.error);
    const [saved] = await worker.evaluate(id => chrome.downloads.search({ id }), task.downloadId);
    const media = new Input({ source: new BufferSource(await readFile(saved.filename)), formats: ALL_FORMATS });
    const video = await media.getPrimaryVideoTrack(); const audio = await media.getPrimaryAudioTrack();
    assert.ok(video); assert.ok(audio); assert.ok(task.fileSize > 0);
    evidence.push({ videoId: task.videoId, filename: task.filename, bytes: task.fileSize, duration: await media.computeDuration(), videoCodec: await video.getCodec(), audioCodec: await audio.getCodec(), quality: task.choice.label });
    media.dispose();
  }
  await mkdir('artifacts', { recursive: true });
  await manager.screenshot({ path: resolve('artifacts/live-batch-preview.png'), fullPage: true });
  await writeFile('artifacts/live-batch-evidence.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, evidence }));
} finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
