import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const sources = JSON.parse(process.env.COLLECTION_TEST_URLS || JSON.stringify([
  'https://www.youtube.com/@YouTube/videos',
  'https://www.youtube.com/@YouTube/shorts',
  'https://www.youtube.com/playlist?list=PLMOZDTW7ZvXM',
  'https://space.bilibili.com/632887/lists/9330612?type=season',
]));
const profile = await mkdtemp(join(tmpdir(), 'live-list-ux-'));
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-sandbox', `--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`] });
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  const manager = await context.newPage(); await manager.goto(`${origin}/batch.html`);
  const sourceTab = await context.newPage(); await sourceTab.goto(sources.find(url => url.includes('youtube.com')) || 'https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const bilibiliSource = sources.find(url => url.includes('bilibili.com'));
  if (bilibiliSource) {
    const page = await context.newPage(); await page.goto(bilibiliSource, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(2000);
  }
  await worker.evaluate(() => {
    globalThis.listTabEvents = { created: 0, removed: 0 };
    chrome.tabs.onCreated.addListener(() => globalThis.listTabEvents.created++);
    chrome.tabs.onRemoved.addListener(() => globalThis.listTabEvents.removed++);
  });
  const evidence = [];
  for (const url of sources) {
    const first = await manager.evaluate(url => chrome.runtime.sendMessage({ target: 'background', type: 'collection', url }), url);
    assert.ok(first.ok, first.error); assert.ok(first.value.entries.length);
    const item = { url, title: first.value.title, firstCount: first.value.entries.length };
    if (first.value.continuation) {
      const next = await manager.evaluate(data => chrome.runtime.sendMessage({ target: 'background', type: 'collection', ...data }), { url, continuation: first.value.continuation });
      assert.ok(next.ok, next.error); assert.ok(next.value.entries.length);
      assert.notEqual(first.value.entries[0].videoId, next.value.entries[0].videoId); item.nextCount = next.value.entries.length;
    }
    evidence.push(item); console.log(JSON.stringify(item));
  }
  const tabEvents = await worker.evaluate(() => globalThis.listTabEvents);
  assert.deepEqual(tabEvents, { created: 0, removed: 0 }); console.log(JSON.stringify({ listTabEvents: tabEvents }));
  await mkdir('artifacts', { recursive: true });
  for (const [index, url] of sources.entries()) {
    const page = await context.newPage(); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const button = page.getByRole('button', { name: '批量下载此列表', exact: true }); await button.waitFor({ timeout: 15000 });
    const before = await worker.evaluate(() => globalThis.listTabEvents.created);
    const created = context.waitForEvent('page'); await button.click(); const panel = await created;
    await panel.waitForURL(`${origin}/batch.html?source=*`); await panel.locator('.entry').first().waitFor({ timeout: 30000 });
    assert.equal(await panel.getByLabel('播放列表、频道或合集链接').inputValue(), url);
    assert.equal(await worker.evaluate(() => globalThis.listTabEvents.created), before + 1);
    await page.screenshot({ path: resolve(`artifacts/live-collection-entry-${index}.png`) });
    if (index === 0) await panel.screenshot({ path: resolve('artifacts/live-collection-manager.png'), fullPage: true });
    console.log(JSON.stringify({ pageEntry: url, visible: await button.isVisible(), newManagerTabs: 1 }));
    await panel.close(); await page.close();
  }
  await writeFile('artifacts/live-collection-ux-evidence.json', JSON.stringify({ evidence, tabEvents }, null, 2));
  console.log(JSON.stringify({ passed: true }));
} finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
