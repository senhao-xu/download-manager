import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choices, filename, mediaURL, videoId, playbackMatches, defaultChoice, mediaMime, progressPercent, matchesSavedName, bytes, taskSize } from '../src/core';
import type { PageSnapshot, RawFormat, Task } from '../src/types';

const id = 'aqz-KE-bpKQ';
test('watch, short link and Shorts identify exactly one video', () => {
  for (const url of [`https://www.youtube.com/watch?v=${id}&list=PL123`, `https://youtu.be/${id}?t=20`, `https://m.youtube.com/shorts/${id}`, `https://youtube.com/live/${id}`]) assert.equal(videoId(url), id);
});
test('reject unsupported, malformed and lookalike URLs', () => {
  for (const url of [`https://youtube.com.evil.test/watch?v=${id}`, `https://user@www.youtube.com/watch?v=${id}`, `http://youtu.be/${id}`, `https://youtu.be/${id}/extra`, 'https://youtube.com/playlist?list=abc', 'https://youtube.com/watch?v=short', `https://youtu.be:8080/${id}`, `javascript:alert(1)`]) assert.throws(() => videoId(url));
});
test('media hosts cannot become an arbitrary cross-origin fetch', () => {
  assert.equal(new URL(mediaURL('https://rr1.googlevideo.com/videoplayback?expire=1')).hostname, 'rr1.googlevideo.com');
  for (const url of ['https://googlevideo.com.evil.test/videoplayback', 'https://evilgooglevideo.com/videoplayback', 'https://user:pass@rr1.googlevideo.com/videoplayback', 'https://rr1.googlevideo.com/other', 'http://rr1.googlevideo.com/videoplayback']) assert.throws(() => mediaURL(url));
});
const format = (itag: number, mimeType: string, extra: Partial<RawFormat> = {}): RawFormat => ({ itag, mimeType, bitrate: 8000, url: 'https://rr1.googlevideo.com/videoplayback', ...extra });
const snapshot = (formats: RawFormat[]): PageSnapshot => ({ videoId: id, title: 'Test', duration: 8, status: 'OK', live: false, client: {}, formats });
test('pair video with compatible default audio and count both sizes', () => {
  const info = choices(snapshot([
    format(137, 'video/mp4; codecs="avc1.640028"', { height: 1080, fps: 30, contentLength: '100' }),
    format(248, 'video/webm; codecs="vp9"', { height: 1080, fps: 30, contentLength: '110' }),
    format(140, 'audio/mp4; codecs="mp4a.40.2"', { contentLength: '20' }),
    format(141, 'audio/mp4', { bitrate: 16000, audioTrack: { audioIsDefault: false } }),
    format(251, 'audio/webm; codecs="opus"', { contentLength: '15' }),
  ]));
  assert.equal(info.choices.find(c => c.videoItag === 137)?.audioItag, 140);
  assert.equal(info.choices.find(c => c.videoItag === 137)?.estimatedBytes, 120);
  assert.equal(info.choices.find(c => c.videoItag === 248)?.audioItag, 251);
});
test('default to the highest available video quality, frame rate and MP4 tie-break', () => {
  const info = choices(snapshot([
    format(137, 'video/mp4', { height: 1080, fps: 30 }),
    format(313, 'video/webm', { height: 2160, fps: 30 }),
    format(315, 'video/webm', { height: 2160, fps: 60 }),
    format(401, 'video/mp4', { height: 2160, fps: 60 }),
    format(140, 'audio/mp4'), format(251, 'audio/webm'),
  ]));
  assert.equal(defaultChoice(info)?.videoItag, 401);
  assert.equal(defaultChoice(choices(snapshot([format(140, 'audio/mp4')])))?.audioItag, 140);
});
test('never offer silent or DRM video as an ordinary video download', () => {
  const info = choices(snapshot([
    format(137, 'video/mp4', { height: 1080 }),
    format(248, 'video/webm', { height: 1080, drmFamilies: ['widevine'] }),
    format(251, 'audio/webm'),
    format(18, 'video/mp4', { height: 360, audioChannels: 2 }),
  ]));
  assert.deepEqual(info.choices.map(c => c.videoItag).filter(Boolean), [18]);
});
test('unknown lengths stay unknown; current player/session errors reach the UI', () => {
  assert.equal(choices({ ...snapshot([format(140, 'audio/mp4', { bitrate: 0 })]), duration: 0 }).choices[0].estimatedBytes, undefined);
  assert.throws(() => choices({ ...snapshot([]), status: 'LOGIN_REQUIRED', reason: '请先登录' }), /请先登录/);
  assert.throws(() => choices({ ...snapshot([]), live: true }), /直播/);
  assert.throws(() => choices(snapshot([])), /播放几秒/);
});
test('sanitize portable filenames, reserved names and empty titles', () => {
  assert.equal(filename('../a/b\\c?:*', 'mp4'), '.._a_b_c___.mp4');
  assert.equal(filename('CON', 'webm'), '_CON.webm');
  assert.equal(filename('...', 'm4a'), 'YouTube.m4a');
  assert.equal(filename('你好 . ', 'mp4'), '你好.mp4');
});
test('saved media MIME agrees with the container and track type', () => {
  assert.equal(mediaMime({ container: 'mp4', videoItag: 137 }), 'video/mp4');
  assert.equal(mediaMime({ container: 'webm', videoItag: 248 }), 'video/webm');
  assert.equal(mediaMime({ container: 'm4a' }), 'audio/mp4');
  assert.equal(mediaMime({ container: 'webm' }), 'audio/webm');
});
test('final save keeps the video title and suffix while permitting Chrome conflict numbering', () => {
  assert.equal(matchesSavedName('标题.mp4', '标题', 'mp4'), true);
  assert.equal(matchesSavedName('标题 (2).MP4', '标题', 'mp4'), true);
  assert.equal(matchesSavedName('标题 (1) (2).mp4', '标题 (1)', 'mp4'), true);
  assert.equal(matchesSavedName('a_b.webm', 'a/b', 'webm'), true);
  assert.equal(matchesSavedName('标题.txt', '标题', 'mp4'), false);
  assert.equal(matchesSavedName('f51fb6e8-48a5-40e7-8f82-e6bdbaa0e1de.mp4', '标题', 'mp4'), false);
  assert.equal(matchesSavedName('other.mp4', '标题', 'mp4'), false);
});
test('progress handles unknown sizes and estimates without claiming early completion', () => {
  assert.equal(progressPercent({ state: 'downloading', received: 50, total: 100 }), 50);
  assert.equal(progressPercent({ state: 'downloading', received: 120, total: 100 }), 99);
  assert.equal(progressPercent({ state: 'downloading', received: 0, total: 100 }), 0);
  for (const total of [undefined, 0, -1, Infinity, NaN]) assert.equal(progressPercent({ state: 'downloading', received: 50, total }), undefined);
  for (const state of ['merging', 'saving', 'failed', 'cancelled'] as const) assert.equal(progressPercent({ state, received: 100, total: 100 }), undefined);
  assert.equal(progressPercent({ state: 'completed', received: 120, total: 100 }), 100);
});
test('size formatting distinguishes zero and small downloads from an unknown total', () => {
  assert.equal(bytes(0), '0 B'); assert.equal(bytes(50), '50 B');
  assert.equal(bytes(1250), '1.3 KB'); assert.equal(bytes(25_000_000), '25.0 MB'); assert.equal(bytes(1_500_000_000), '1.5 GB');
  for (const value of [undefined, -1, NaN, Infinity]) assert.equal(bytes(value), '大小未知');
});
test('task size uses transfer totals while active and actual muxed file size after completion', () => {
  const task: Task = { id: 'test', videoId: id, title: 'Test', created: 0, state: 'downloading', received: 25_000_000,
    choice: { id: 'test', label: '1080p', container: 'mp4', estimatedBytes: 100_000_000 } };
  assert.equal(taskSize(task), '25.0 MB / 约 100.0 MB');
  assert.equal(taskSize({ ...task, total: 90_000_000 }), '25.0 MB / 约 90.0 MB');
  assert.equal(taskSize({ ...task, received: 0 }), '0 B / 约 100.0 MB');
  assert.equal(taskSize({ ...task, choice: { ...task.choice, estimatedBytes: undefined } }), '25.0 MB / 总大小未知');
  assert.equal(taskSize({ ...task, state: 'completed', fileSize: 24_000_000 }), '文件大小 24.0 MB');
  assert.equal(taskSize({ ...task, state: 'completed' }), '已下载 25.0 MB');
  assert.equal(taskSize({ ...task, state: 'completed', received: 0 }), '文件大小未知');
  assert.equal(taskSize({ ...task, state: 'completed', fileSize: 0 }), '文件大小 0 B');
});
test('playback binding tolerates native configuration changes but rejects a different video/media identity', () => {
  const source = { ...snapshot([]), sabrUrl: 'https://rr1.googlevideo.com/videoplayback?id=stream-a', ustreamerConfig: 'old' };
  const session = { videoId: id, capturedAt: Date.now(), url: 'https://rr2.googlevideo.com/videoplayback?id=stream-a', ustreamerConfig: 'updated' };
  assert.equal(playbackMatches(source, session), true);
  assert.equal(playbackMatches(source, { ...session, url: 'https://rr1.googlevideo.com/videoplayback?id=stream-b' }), false);
  assert.equal(playbackMatches(source, { ...session, videoId: 'BaW_jenozKc' }), false);
  assert.equal(playbackMatches(source, { ...session, capturedAt: Date.now() - 16 * 60000 }), false);
});
