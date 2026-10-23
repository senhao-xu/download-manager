import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { collectionSource } from '../src/batch-core';
import { coverURL } from '../src/core';
import { md5, signWbi, readUploadContext, fetchUploads } from '../src/bilibili-uploads';

const image = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const subImage = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';
test('Bilibili UP home and both upload URL layouts identify the same canonical video source', () => {
  for (const suffix of ['', '/', '/video', '/video/', '/upload/video', '/upload/video/?spm_id_from=tracking']) {
    assert.deepEqual(collectionSource(`https://space.bilibili.com/1575688490${suffix}`), { site: 'bilibili', kind: 'channel', id: '1575688490', owner: '1575688490', url: 'https://space.bilibili.com/1575688490/upload/video' });
  }
  for (const url of ['https://space.bilibili.com/0/video', 'https://space.bilibili.com/123/upload/audio', 'https://space.bilibili.com/123/upload/article', 'https://space.bilibili.com.evil.test/123/video', 'https://user@space.bilibili.com/123/video', 'https://space.bilibili.com:8080/123/video']) assert.throws(() => collectionSource(url), url);
});
test('MD5 checksum handles padding boundaries and Unicode independently of browser crypto', () => {
  for (const value of ['', 'abc', 'hello', '测试封面🖼️', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64), 'd'.repeat(130)]) assert.equal(md5(value), createHash('md5').update(value).digest('hex'));
});
test('WBI signing uses public image keys, sorted encoded values and the requested timestamp', () => {
  const query = signWbi({ mid: '123', pn: '2', ps: '30', keyword: "hello!'()* space", w_rid: 'old' }, image, subImage, 1702204169);
  const params = new URLSearchParams(query);
  assert.equal(params.get('keyword'), 'hello space'); assert.equal(params.get('wts'), '1702204169');
  const unsigned = query.slice(0, query.lastIndexOf('&w_rid='));
  const mixin = 'ea1db124af3c7062474693fa704f4ff8';
  assert.equal(params.get('w_rid'), createHash('md5').update(unsigned + mixin).digest('hex'));
  assert.throws(() => signWbi({}, 'https://i0.hdslb.com/invalid.png', subImage));
});
function page(t: TestContext) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const location = { hostname: 'space.bilibili.com', pathname: '/123/upload/video' };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'location', prior); else Reflect.deleteProperty(globalThis, 'location'); });
  return location;
}
test('upload context reuses only natural page device fields and projects public nav keys', async t => {
  page(t);
  t.mock.method(performance, 'getEntriesByType', () => [{ name: 'https://api.bilibili.com/x/space/wbi/arc/search?mid=123&dm_img_str=native-page-value&w_rid=old&not_allowed=secret' }]);
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, 'https://api.bilibili.com/x/web-interface/nav'); assert.equal(init?.credentials, 'include');
    return new Response(JSON.stringify({ code: -101, data: { wbi_img: { img_url: image, sub_url: subImage }, uname: 'must not project' } }));
  });
  const context = await readUploadContext('123'); assert.ok(!('error' in context));
  assert.deepEqual(context, { image, subImage, params: { dm_img_str: 'native-page-value' } });
  assert.ok('error' in await readUploadContext('999'));
});
test('uploads project canonical entries, covers and continuation without concealing access errors', async t => {
  const location = page(t); let code = 0; let navigate = false;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(String(url)).pathname, '/x/space/wbi/arc/search'); assert.equal(init?.credentials, 'include');
    if (navigate) location.pathname = '/999/upload/video';
    return new Response(JSON.stringify({ code, message: code ? '访问受限' : '', data: { page: { count: 61 }, list: { vlist: [{ bvid: 'BV1GJ411x7h7', title: '视频', author: 'UP 主', pic: 'http://i0.hdslb.com/bfs/archive/cover.jpg' }, { bvid: 'invalid', title: 'Skip' }] } } }));
  });
  const query = 'mid=123&pn=1&ps=30';
  const result = await fetchUploads('123', query); assert.ok(!('error' in result));
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].videoId, 'bilibili:BV1GJ411x7h7:p1'); assert.equal(result.continuation, '2');
  assert.equal(result.title, 'UP 主 的投稿视频');
  code = -403; const denied = await fetchUploads('123', query); assert.ok('error' in denied); assert.match(denied.error, /-403.*登录或完成验证/);
  code = 0; navigate = true; const changed = await fetchUploads('123', query); assert.ok('error' in changed); assert.match(changed.error, /已切换/);
});
test('covers upgrade known CDN images and reject arbitrary or credentialed URLs', () => {
  assert.equal(coverURL('http://i0.hdslb.com/bfs/archive/cover.jpg', 'bilibili'), 'https://i0.hdslb.com/bfs/archive/cover.jpg');
  assert.equal(coverURL(undefined, 'youtube', 'fixture_001'), 'https://i.ytimg.com/vi/fixture_001/hqdefault.jpg');
  for (const url of ['https://i0.hdslb.com.evil.test/bfs/cover.jpg', 'https://user@i0.hdslb.com/bfs/cover.jpg', 'https://i0.hdslb.com:8080/bfs/cover.jpg', 'https://evil.test/cover.jpg', 'javascript:alert(1)']) assert.equal(coverURL(url, 'bilibili'), undefined);
});
