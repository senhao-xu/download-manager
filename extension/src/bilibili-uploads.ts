import { collectionSource } from './batch-core';
import type { CollectionPage } from './types';

// WBI uses MD5 as a public request checksum, not as a password hash.
export function md5(value: string): string {
  const input = new TextEncoder().encode(value);
  const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  bytes.set(input); bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 8, input.length * 8, true);
  view.setUint32(bytes.length - 4, Math.floor(input.length / 0x20000000), true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const shifts = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    let [a, b, c, d] = state;
    for (let index = 0; index < 64; index++) {
      const group = index >> 4;
      const f = group === 0 ? b & c | ~b & d : group === 1 ? d & b | ~d & c : group === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const word = group === 0 ? index : group === 1 ? (5 * index + 1) % 16 : group === 2 ? (3 * index + 5) % 16 : 7 * index % 16;
      const sum = (a + f + Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) + view.getUint32(offset + word * 4, true)) | 0;
      const shift = shifts[group][index % 4];
      const next = (b + (sum << shift | sum >>> (32 - shift))) | 0;
      a = d; d = c; c = b; b = next;
    }
    for (const [index, value] of [a, b, c, d].entries()) state[index] = (state[index] + value) | 0;
  }
  const result = new Uint8Array(16); const output = new DataView(result.buffer);
  state.forEach((value, index) => output.setUint32(index * 4, value, true));
  return [...result].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function signWbi(params: Record<string, string>, image: string, subImage: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const key = (url: string) => new URL(url).pathname.split('/').pop()!.split('.')[0];
  const source = key(image) + key(subImage);
  if (!/^[0-9a-f]{64}$/i.test(source)) throw new Error('Bilibili 请求配置无效，请刷新投稿页面后重试。');
  const order = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
  const mixin = order.map(index => source[index]).join('');
  const values = { ...params, wts: String(timestamp) }; delete (values as Record<string, string>).w_rid;
  const query = Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value.replace(/[!'()*]/g, ''))}`).join('&');
  return `${query}&w_rid=${md5(query + mixin)}`;
}

interface UploadContext { image: string; subImage: string; params: Record<string, string> }
// Both MAIN-world functions are self-contained and use fixed first-party URLs.
export async function readUploadContext(mid: string): Promise<UploadContext | { error: string }> {
  try {
    const current = () => location.hostname === 'space.bilibili.com' && location.pathname.split('/')[1] === mid;
    if (!current()) throw new Error('UP 主页面已切换，请重新读取列表。');
    const urls = performance.getEntriesByType('resource').map(entry => { try { return new URL(entry.name); } catch { return undefined; } })
      .filter((url): url is URL => url?.origin === 'https://api.bilibili.com' && url.pathname.startsWith('/x/space/'));
    const native = [...urls].reverse().find(url => url.pathname === '/x/space/wbi/arc/search' && url.searchParams.get('mid') === mid)
      || [...urls].reverse().find(url => url.searchParams.has('dm_img_str'));
    const params: Record<string, string> = {};
    for (const name of ['dm_img_list', 'dm_img_str', 'dm_cover_img_str', 'dm_img_inter', 'x-bili-locale-json', 'x-bili-device-req-json']) {
      const value = native?.searchParams.get(name);
      if (value !== undefined && value !== null && value.length <= 20000) params[name] = value;
    }
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Bilibili 请求配置读取失败（${response.status}）。`);
    const value = await response.json() as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
    const image = value.data?.wbi_img?.img_url; const subImage = value.data?.wbi_img?.sub_url;
    if (!image || !subImage) throw new Error('请在 Bilibili 投稿页面完成登录或验证，再重试读取列表。');
    if (!current()) throw new Error('UP 主页面已切换，请重新读取列表。');
    return { image, subImage, params };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

export async function fetchUploads(mid: string, query: string): Promise<CollectionPage | { error: string }> {
  try {
    const current = () => location.hostname === 'space.bilibili.com' && location.pathname.split('/')[1] === mid;
    const params = new URLSearchParams(query);
    if (!current() || params.get('mid') !== mid || !/^[1-9]\d*$/.test(params.get('pn') || '') || params.get('ps') !== '30') throw new Error('UP 主页面或分页信息已变更，请重试。');
    const response = await fetch(`https://api.bilibili.com/x/space/wbi/arc/search?${query}`, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Bilibili 投稿列表读取失败（${response.status}），请在原页面确认可访问后重试。`);
    const value = await response.json() as { code: number; message?: string; data?: { list?: { vlist?: { bvid?: string; title?: string; author?: string; pic?: string }[] }; page?: { count?: number } } };
    if (!current()) throw new Error('UP 主页面已切换，请重新读取列表。');
    if (value.code !== 0) throw new Error(`Bilibili 投稿列表暂时不可用（${value.code}）：${value.message || '访问受限'}。请在原页面登录或完成验证后重试。`);
    const videos = value.data?.list?.vlist || [];
    const entries = videos.filter(video => /^BV[0-9A-Za-z]{10}$/.test(video.bvid || '')).map(video => ({
      videoId: `bilibili:${video.bvid}:p1`, title: video.title || video.bvid!, url: `https://www.bilibili.com/video/${video.bvid}/`, thumbnail: video.pic,
    }));
    const page = Number(params.get('pn'));
    if (!entries.length) throw new Error('此页暂无可读取的公开视频，请确认投稿页面已正常显示。');
    return { title: `${videos[0]?.author || `UP ${mid}`} 的投稿视频`, entries, continuation: Number(value.data?.page?.count) > page * 30 ? String(page + 1) : undefined };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

export async function readBilibiliUploads(input: string, page: number): Promise<CollectionPage> {
  const source = collectionSource(input);
  if (source.site !== 'bilibili' || source.kind !== 'channel' || !Number.isSafeInteger(page) || page < 1) throw new Error('UP 主或分页信息无效。');
  const tabs = await chrome.tabs.query({ url: 'https://space.bilibili.com/*' });
  const tab = tabs.find(tab => {
    try { return !tab.discarded && tab.id !== undefined && new URL(tab.url || '').pathname.split('/')[1] === source.id; } catch { return false; }
  });
  if (!tab?.id) throw new Error('请保持该 UP 主的 Bilibili 投稿页面打开，再读取视频列表。');
  const [context] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: readUploadContext, args: [source.id] });
  if (!context?.result) throw new Error('无法读取 UP 主页面，请等待投稿页面加载完成后重试。');
  if ('error' in context.result) throw new Error(context.result.error);
  const query = signWbi({ ...context.result.params, mid: source.id, pn: String(page), ps: '30', tid: '0', keyword: '', order: 'pubdate', order_avoided: 'true', platform: 'web', web_location: '333.1387', special_type: '', index: '0' }, context.result.image, context.result.subImage);
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: fetchUploads, args: [source.id, query] });
  if (!result?.result) throw new Error('无法读取投稿列表，请刷新 UP 主页面后重试。');
  if ('error' in result.result) throw new Error(result.result.error);
  return result.result;
}
