import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchEntries, batchQuality, collectionSource, qualityChoice } from '../src/batch-core';
import { browseYouTube, embeddedJSON, parseYouTubeCollection, readYouTubeCollection, readBilibiliCollection } from '../src/collections';
import { readPlayer } from '../src/page';
import type { VideoInfo } from '../src/types';

test('collection URLs canonicalize only supported first-party lists and channel tabs', () => {
  assert.equal(collectionSource('https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PL_abc').url, 'https://www.youtube.com/playlist?list=PL_abc');
  assert.equal(collectionSource('https://m.youtube.com/@YouTube/shorts').url, 'https://www.youtube.com/@YouTube/shorts');
  assert.equal(collectionSource('https://www.youtube.com/channel/UCabc').url, 'https://www.youtube.com/channel/UCabc/videos');
  assert.equal(collectionSource('https://space.bilibili.com/123/lists/456?type=season').kind, 'season');
  assert.equal(collectionSource('https://space.bilibili.com/123/channel/seriesdetail?sid=456').kind, 'series');
  assert.equal(collectionSource('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2').kind, 'video');
  for (const url of ['https://youtube.com.evil.test/playlist?list=PLabc', 'http://youtube.com/@YouTube', 'https://user@youtube.com/@YouTube', 'https://youtube.com:8080/@YouTube', 'https://youtube.com/results?search_query=test', 'https://space.bilibili.com/123/lists/0', 'https://space.bilibili.com.evil.test/123/lists/45', 'https://youtu.be/aqz-KE-bpKQ']) assert.throws(() => collectionSource(url), url);
});
test('submitted entries reject mismatched IDs, unsafe URLs, invalid quality and oversized batches', () => {
  const entry = { videoId: 'aqz-KE-bpKQ', title: 'Video', url: 'https://youtu.be/aqz-KE-bpKQ' };
  assert.equal(batchEntries([entry, entry]).length, 1);
  assert.equal(batchEntries([entry])[0].url, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  for (const value of [[], [null], [{ ...entry, videoId: 'other_id001' }], [{ ...entry, url: 'https://evil.test/' }], Array(1001).fill(entry)]) assert.throws(() => batchEntries(value));
  assert.throws(() => batchQuality('2160')); assert.equal(batchQuality('audio'), 'audio');
});
test('quality cap selects actual compatible formats and never silently exports audio for a video request', () => {
  const info: VideoInfo = { videoId: 'aqz-KE-bpKQ', title: '', duration: 8, choices: [
    { id: '4k', videoItag: 401, label: '4K 超清', height: 2160, container: 'mp4' },
    { id: 'hd', videoItag: 137, label: '1080P 高码率', container: 'mp4' },
    { id: 'sd', videoItag: 18, label: '360p', container: 'mp4' },
    { id: 'audio', audioItag: 140, label: '仅音频', container: 'm4a' },
  ] };
  assert.equal(qualityChoice(info, 'best').id, '4k'); assert.equal(qualityChoice(info, '1080').id, 'hd');
  assert.equal(qualityChoice(info, '720').id, 'sd'); assert.equal(qualityChoice(info, 'audio').id, 'audio');
  assert.throws(() => qualityChoice({ ...info, choices: [info.choices[3]] }, 'best'));
});
test('Shorts select the matching player despite stale watch metadata, preload and detached-player errors', async t => {
  const response = (id: string) => ({ videoDetails: { videoId: id, title: id }, playabilityStatus: { status: 'OK' } });
  const before = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { ytInitialPlayerResponse: response('stale_id001') } });
  const doc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { title: 'Shorts', querySelectorAll: () => [
    { getPlayerResponse() { throw new Error('Detached'); } }, { getPlayerResponse: () => response('preload_001') }, { getPlayerResponse: () => response('current_001') },
  ] } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'window', before); else Reflect.deleteProperty(globalThis, 'window'); if (doc) Object.defineProperty(globalThis, 'document', doc); else Reflect.deleteProperty(globalThis, 'document'); });
  assert.equal((await readPlayer('current_001')).title, 'current_001');
  assert.equal((await readPlayer('missing_001')).status, 'UNAVAILABLE');
});
test('YouTube list parsing confines results to selected content, deduplicates and reads continuation items only', () => {
  const entry = (id: string, title: string) => ({ playlistVideoRenderer: { videoId: id, title: { runs: [{ text: title }] } } });
  const selected = { contents: [entry('fixture_001', 'First'), entry('fixture_001', 'First'), { playlistVideoRenderer: { videoId: 'private_001', isPlayable: false } },
    { shortsLockupViewModel: { onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: 'shorts_one1' } } }, overlayMetadata: { primaryText: { content: 'Short' } } } },
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'next-page' } } } }], header: { continuationCommand: { token: 'sorting-token' } } };
  const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: selected } }, { tabRenderer: { content: entry('outside_001', 'Outside') } }] } } };
  const page = parseYouTubeCollection(data, 'List');
  assert.deepEqual(page.entries.map(item => item.title), ['First', 'Short']); assert.equal(page.continuation, 'next-page');
  const next = parseYouTubeCollection({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [entry('fixture_002', 'Next')] } }] }, 'List', true);
  assert.equal(next.entries[0].videoId, 'fixture_002'); assert.equal(next.continuation, undefined);
});
test('embedded page data parses nested JSON and escaped strings without executing page JavaScript', () => {
  const data = { title: 'brace } [ and "quotes" \\ path', nested: [{ value: 1 }] };
  assert.deepEqual(embeddedJSON(`ytcfg.set(${JSON.stringify(data)}); throw new Error('must not execute');`, /ytcfg\.set\(/g), [data]);
  assert.deepEqual(embeddedJSON('ytcfg.set({value:doSomething()});', /ytcfg\.set\(/g), []);
  assert.deepEqual(embeddedJSON('ytcfg.set({"incomplete":true', /ytcfg\.set\(/g), []);
});
test('YouTube first-page and continuation requests run without a document and reuse first-party context', async t => {
  const source = 'https://www.youtube.com/playlist?list=PL_tabless';
  const context = { client: { clientName: 'WEB', clientVersion: 'fixture', visitorData: 'page-session' } };
  const data = { metadata: { playlistMetadataRenderer: { title: 'List & "title"' } }, contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: {
    playlistVideoListRenderer: { contents: [{ playlistVideoRenderer: { videoId: 'fixture_001', title: { simpleText: 'First' } } }] },
  } } }] } } };
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(url));
    if (String(url).startsWith(source)) {
      assert.equal(init?.credentials, 'include');
      return new Response(`<script>window["ytInitialData"] = ${JSON.stringify(data)};ytcfg.set({"OTHER_CONFIG":1});ytcfg.set(${JSON.stringify({ INNERTUBE_CONTEXT: context })});</script>`);
    }
    assert.equal(String(url), '/youtubei/v1/browse?prettyPrint=false'); assert.equal(init?.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(String(init?.body)), { context, continuation: 'next-page' });
    return new Response(JSON.stringify({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [{ playlistVideoRenderer: { videoId: 'fixture_002', title: { simpleText: 'Next' } } }] } }] }));
  });
  const browse = async (context: unknown, token: string) => {
    const result = await browseYouTube(context, token); assert.equal(result.error, undefined); return result.data;
  };
  assert.equal((await readYouTubeCollection(source)).title, 'List & "title"');
  assert.equal((await readYouTubeCollection(source, 'next-page', browse)).entries[0].videoId, 'fixture_002');
  assert.deepEqual(requests, [source, '/youtubei/v1/browse?prettyPrint=false']);
  // A restarted worker can reconstruct context for an already-held page token.
  requests.length = 0;
  const restoredSource = `${source}_restored`;
  const restored = await readYouTubeCollection(restoredSource, 'next-page', browse);
  assert.equal(restored.entries[0].videoId, 'fixture_002');
  assert.deepEqual(requests, [restoredSource, '/youtubei/v1/browse?prettyPrint=false']);
  await assert.rejects(readYouTubeCollection(source, 'next-page'), /保持原 YouTube 页面打开/);
});
test('YouTube missing configuration, HTTP errors and invalid sources surface without opening a fallback tab', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('verification page'));
  await assert.rejects(readYouTubeCollection('https://www.youtube.com/@missing/videos'), /登录或验证/);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(readYouTubeCollection('https://www.youtube.com/@missing/videos'), /503/);
  await assert.rejects(readYouTubeCollection('https://youtube.com.evil.test/playlist?list=PLbad'));
  await assert.rejects(readYouTubeCollection('https://www.youtube.com/@missing/videos', ''));
});
test('Bilibili collections, parts and paginated list requests preserve canonical identities', async t => {
  let payload: unknown = { bvid: 'BV1GJ411x7h7', title: 'Parts', pages: [{ page: 1, part: 'First' }, { page: 2, part: 'Second' }] };
  const requests: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => { requests.push(new URL(String(url))); assert.equal(init?.credentials, 'include'); return new Response(JSON.stringify({ code: 0, data: payload })); });
  const source = collectionSource('https://www.bilibili.com/video/BV1GJ411x7h7/');
  assert.equal((await readBilibiliCollection(source)).entries[1].url, 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2');
  payload = { title: 'Video', ugc_season: { id: 123, title: 'Collection', sections: [{ episodes: [{ bvid: 'BV1GJ411x7h7', title: 'Episode' }] }] } };
  assert.equal((await readBilibiliCollection(source)).title, 'Collection');
  payload = { meta: { name: 'Season' }, page: { total: 61 }, archives: [{ bvid: 'BV1GJ411x7h7', title: 'Episode' }] };
  const page = await readBilibiliCollection(collectionSource('https://space.bilibili.com/123/lists/456?type=season'), 2);
  assert.equal(page.continuation, '3'); assert.equal(requests.at(-1)?.searchParams.get('page_num'), '2');
});
