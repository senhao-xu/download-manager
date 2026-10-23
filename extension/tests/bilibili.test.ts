import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { videoTarget, mediaURL, choices, defaultChoice } from '../src/core';
import { readBilibili } from '../src/bilibili';

const bvid = 'BV1xx411c7mD';
test('site targets preserve BV/AV and current-part identity while canonicalizing tracking URLs', () => {
  const target = videoTarget(`https://www.bilibili.com/video/${bvid}/?p=2&spm_id_from=tracking`);
  assert.deepEqual(target, { site: 'bilibili', videoId: `bilibili:${bvid}:p2`, identity: bvid, part: 2, url: `https://www.bilibili.com/video/${bvid}/?p=2` });
  assert.equal(videoTarget('https://m.bilibili.com/video/av2').videoId, 'bilibili:av2:p1');
  assert.equal(videoTarget(`https://bilibili.com/video/${bvid}`).part, 1);
  assert.notEqual(videoTarget(target.url).videoId, videoTarget(`https://www.bilibili.com/video/${bvid}`).videoId);
  assert.equal(videoTarget('https://youtu.be/aqz-KE-bpKQ?t=3').url, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
});
test('Bilibili targets reject foreign hosts, malformed parts, non-video pages and unsupported short links', () => {
  for (const url of [
    `https://bilibili.com.evil.test/video/${bvid}`, `https://evilbilibili.com/video/${bvid}`, `http://www.bilibili.com/video/${bvid}`,
    `https://user@www.bilibili.com/video/${bvid}`, `https://www.bilibili.com:123/video/${bvid}`,
    `https://www.bilibili.com/video/${bvid}/extra`, 'https://www.bilibili.com/video/BVshort', 'https://www.bilibili.com/video/av0',
    'https://www.bilibili.com/bangumi/play/ep123', 'https://space.bilibili.com/123', 'https://b23.tv/abc',
    ...['0', '-1', '1.5', 'foo', '1e2', '9007199254740993'].map(p => `https://www.bilibili.com/video/${bvid}?p=${p}`),
  ]) assert.throws(() => videoTarget(url), url);
});
test('media requests stay restricted to the selected site and Bilibili media paths', () => {
  for (const host of ['upos-sz-mirrorcos.bilivideo.com', 'fixture.bilivideo.cn', 'upos-hz-mirrorakam.akamaized.net']) {
    const url = `https://${host}/upgcxcode/01/02/123/123.m4s?sign=secret`;
    assert.equal(mediaURL(url, 'bilibili'), url);
    assert.throws(() => mediaURL(url));
  }
  for (const url of [
    'https://bilivideo.com.evil.test/upgcxcode/x', 'https://evilbilivideo.com/upgcxcode/x', 'https://other.akamaized.net/upgcxcode/x',
    'https://user:pass@fixture.bilivideo.com/upgcxcode/x', 'https://fixture.bilivideo.com:123/upgcxcode/x',
    'http://fixture.bilivideo.com/upgcxcode/x', 'https://fixture.bilivideo.com/api/user', 'https://fixture.googlevideo.com/videoplayback',
  ]) assert.throws(() => mediaURL(url, 'bilibili'), url);
});

function fixture(t: TestContext, identity = bvid, part = 2) {
  const current = { href: `https://www.bilibili.com/video/${identity}/?p=${part}` };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: current });
  t.after(() => Reflect.deleteProperty(globalThis, 'location'));
  const video = { bvid, aid: 2, title: 'B站 / 测试', rights: { is_stein_gate: 0 }, pages: [
    { cid: 501, page: 1, part: '第一部分', duration: 7 }, { cid: 502, page: 2, part: '第二部分', duration: 8 },
  ] };
  const playback = {
    timelength: 8000, is_preview: 0,
    support_formats: [{ quality: 80, new_description: '1080P 高清' }, { quality: 112, new_description: '1080P 高码率' }],
    dash: { video: [
      { id: 80, codecid: 7, codecs: 'avc1.640028', mimeType: 'video/mp4', height: 1080, frameRate: '30000/1001', bandwidth: 20000, baseUrl: 'https://mcdn.bilivideo.cn/v1/resource/x', backupUrl: ['https://upos-test.bilivideo.com/upgcxcode/x.m4s'], size: 100 },
      { id: 80, codecid: 12, codecs: 'hev1.1.6.L120', mimeType: 'video/mp4', height: 1080, frameRate: '30000/1001', bandwidth: 10000, baseUrl: 'https://upos-test.bilivideo.com/upgcxcode/h.m4s', size: 80 },
      { id: 112, codecid: 7, codecs: 'avc1.640028', mimeType: 'video/mp4', height: 1080, frameRate: '30000/1001', bandwidth: 30000, baseUrl: 'https://upos-test.bilivideo.com/upgcxcode/premium.m4s', size: 120 },
    ], audio: [{ id: 30280, codecs: 'mp4a.40.2', mimeType: 'audio/mp4', bandwidth: 2000, baseUrl: 'https://upos-test.bilivideo.com/upgcxcode/a.m4s', size: 20 }] },
  };
  let code = 0; let navigate = false;
  t.mock.method(globalThis, 'fetch', async (input: string, options: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.bilibili.com'); assert.equal(options.credentials, 'include');
    assert.ok(options.signal);
    if (url.pathname === '/x/web-interface/view') assert.equal(url.searchParams.get(identity.startsWith('BV') ? 'bvid' : 'aid'), identity.startsWith('BV') ? identity : identity.slice(2));
    else {
      assert.equal(url.pathname, '/x/player/playurl'); assert.equal(url.searchParams.get('bvid'), bvid);
      assert.equal(url.searchParams.get('cid'), String(part === 2 ? 502 : 501));
      if (navigate) current.href = `https://www.bilibili.com/video/${identity}/?p=1`;
    }
    return Response.json({ code, message: code ? '请先登录' : 'OK', data: url.pathname === '/x/web-interface/view' ? video : playback });
  });
  return { video, playback, current, fail() { code = -101; }, navigate() { navigate = true; } };
}
test('Bilibili reader requests the current CID with normal page credentials and offers compatible formats only', async t => {
  fixture(t);
  const snapshot = await readBilibili(bvid, 2);
  assert.equal(snapshot.site, 'bilibili'); assert.equal(snapshot.videoId, `bilibili:${bvid}:p2`);
  assert.equal(snapshot.title, 'B站 / 测试 - P2 第二部分'); assert.equal(snapshot.duration, 8);
  assert.ok(snapshot.formats[0].url!.startsWith('https://upos-test.bilivideo.com/'));
  assert.equal(new Set(snapshot.formats.map(f => f.itag)).size, snapshot.formats.length);
  const info = choices(snapshot);
  assert.equal(info.site, 'bilibili'); assert.equal(info.choices.filter(c => c.videoItag !== undefined).length, 2);
  assert.equal(defaultChoice(info)?.label, '1080P 高码率');
  assert.equal(defaultChoice(info)?.estimatedBytes, 140);
  assert.ok(info.choices.some(c => c.container === 'm4a' && c.videoItag === undefined));
  assert.ok(!JSON.stringify(info).includes('bilivideo.com'));
});
test('AV input resolves metadata while keeping a stable current-page identity', async t => {
  fixture(t, 'av2', 1);
  assert.equal((await readBilibili('av2', 1)).videoId, 'bilibili:av2:p1');
});
test('unavailable videos and changed page identity cannot yield formats for another video or part', async t => {
  const state = fixture(t);
  state.fail(); await assert.rejects(async () => choices(await readBilibili(bvid, 2)), /登录/);
  state.current.href = `https://www.bilibili.com/video/${bvid}/?p=1`;
  await assert.rejects(async () => choices(await readBilibili(bvid, 2)), /切换/);
});
test('navigation during resolution discards the old part response', async t => {
  const state = fixture(t); state.navigate();
  await assert.rejects(async () => choices(await readBilibili(bvid, 2)), /切换/);
});
test('missing parts, mismatched metadata, previews and interactive branches are explicit errors', async t => {
  const state = fixture(t);
  state.video.bvid = 'BV1GJ411x7h7'; await assert.rejects(async () => choices(await readBilibili(bvid, 2)), /不匹配/);
  state.video.bvid = bvid; state.video.pages.pop(); await assert.rejects(async () => choices(await readBilibili(bvid, 2)), /分 P 不存在/);
  state.video.pages.push({ cid: 502, page: 2, part: '第二部分', duration: 8 });
  state.playback.is_preview = 1; await assert.rejects(async () => choices(await readBilibili(bvid, 2)), /试看/);
  state.playback.is_preview = 0; state.video.rights.is_stein_gate = 1; await assert.rejects(async () => choices(await readBilibili(bvid, 2)), /互动视频/);
});
