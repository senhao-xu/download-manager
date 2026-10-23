import type { PageSnapshot } from './types';

// This function is serialized by chrome.scripting. Keep it self contained.
export async function readPlayer(expectedId: string, direct = false): Promise<PageSnapshot> {
  type PlayerResponse = {
    videoDetails?: { videoId?: string; title?: string; lengthSeconds?: string; isLive?: boolean };
    playabilityStatus?: { status?: string; reason?: string };
    streamingData?: { formats?: PageSnapshot['formats']; adaptiveFormats?: PageSnapshot['formats']; serverAbrStreamingUrl?: string };
    playerConfig?: { mediaCommonConfig?: { mediaUstreamerRequestConfig?: { videoPlaybackUstreamerConfig?: string } } };
  };
  const page = window as Window & { ytInitialPlayerResponse?: PlayerResponse; ytcfg?: { get(key: string): unknown } };
  const player = document.querySelector('#movie_player') as (Element & { getPlayerResponse?(): PlayerResponse }) | null;
  let response = player?.getPlayerResponse?.();
  if (response?.videoDetails?.videoId !== expectedId) response = page.ytInitialPlayerResponse;
  if (response?.videoDetails?.videoId !== expectedId) {
    return { videoId: expectedId, title: document.title, duration: 0, status: 'UNAVAILABLE', reason: response?.playabilityStatus?.reason || '视频正在加载，请先播放几秒后重试。', live: false, formats: [], client: {} };
  }
  let client = { clientName: Number(page.ytcfg?.get('INNERTUBE_CONTEXT_CLIENT_NAME')) || 1, clientVersion: String(page.ytcfg?.get('INNERTUBE_CONTEXT_CLIENT_VERSION') || '') };
  if (direct && response.playabilityStatus?.status === 'OK' && !response.videoDetails?.isLive) {
    // Request ordinary downloadable formats from YouTube itself. This avoids
    // depending on a SABR request captured before the extension was installed.
    const clientVersion = '1.02';
    const result = await fetch('/youtubei/v1/player?prettyPrint=false', {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: expectedId, context: {
        client: { clientName: 'VISIONOS', clientVersion, deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471', visitorData: page.ytcfg?.get('VISITOR_DATA'), hl: 'en', gl: 'US' },
      }, contentCheckOk: true, racyCheckOk: true }),
    });
    if (!result.ok) throw new Error('暂时无法获取下载地址，请稍后重试。');
    const value = await result.json() as PlayerResponse;
    if (value.videoDetails?.videoId !== expectedId || value.playabilityStatus?.status !== 'OK') throw new Error(value.playabilityStatus?.reason || 'YouTube 暂时未提供可用下载地址。');
    response = value; client = { clientName: 101, clientVersion };
  }
  const data = response.streamingData;
  return JSON.parse(JSON.stringify({
    videoId: expectedId, title: response.videoDetails?.title || document.title,
    duration: Number(response.videoDetails?.lengthSeconds || 0),
    live: !!response.videoDetails?.isLive,
    status: response.playabilityStatus?.status || 'UNAVAILABLE', reason: response.playabilityStatus?.reason,
    formats: [...(data?.formats || []), ...(data?.adaptiveFormats || [])], sabrUrl: direct ? undefined : data?.serverAbrStreamingUrl,
    ustreamerConfig: response.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig,
    playerUrl: page.ytcfg?.get('PLAYER_JS_URL'),
    client,
  })) as PageSnapshot;
}
