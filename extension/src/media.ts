import {
  Input, BlobSource, ALL_FORMATS, Output, Mp4OutputFormat, WebMOutputFormat,
  EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacketSink, StreamTarget,
} from 'mediabunny';
import type { InputTrack, EncodedPacket } from 'mediabunny';

export async function mergeTracks(video: Blob | undefined, audio: Blob | undefined, container: string,
  writable: FileSystemWritableFileStream, signal: AbortSignal, expectedDuration: number) {
  const inputs: Input[] = [];
  const output = new Output({
    format: container === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 }),
  });
  try {
    const open = (blob: Blob) => { const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS }); inputs.push(input); return input; };
    const videoInput = video && open(video);
    const audioInput = audio ? open(audio) : videoInput;
    const v = videoInput && await videoInput.getPrimaryVideoTrack();
    const a = audioInput && await audioInput.getPrimaryAudioTrack();
    if (video && !v) throw new Error('下载流中没有有效的视频轨。');
    if (!a) throw new Error('下载流中没有有效的音频轨。');
    const vc = v && await v.getCodec(); const ac = await a.getCodec();
    if ((v && !vc) || !ac) throw new Error('此音视频编码暂不支持合并。');
    const vs = vc && new EncodedVideoPacketSource(vc);
    const as = new EncodedAudioPacketSource(ac);
    if (vs) output.addVideoTrack(vs);
    output.addAudioTrack(as);
    await output.start();
    const durations = await Promise.all([v?.computeDuration(), a.computeDuration()]);
    if (expectedDuration > 0 && durations.some(value => value !== undefined && value + 1.5 < expectedDuration)) throw new Error('视频或音频数据未下载完整，请重新下载。');
    async function copy(track: InputTrack, add: (packet: EncodedPacket) => Promise<void>, close: () => void) {
      for await (const packet of new EncodedPacketSink(track).packets()) {
        signal.throwIfAborted();
        await add(packet);
      }
      close();
    }
    const videoConfig = v && await v.getDecoderConfig(); const audioConfig = await a.getDecoderConfig();
    await Promise.all([
      v && vs ? copy(v, packet => vs.add(packet, { decoderConfig: videoConfig || undefined }), () => vs.close()) : Promise.resolve(),
      copy(a, packet => as.add(packet, { decoderConfig: audioConfig || undefined }), () => as.close()),
    ]);
    signal.throwIfAborted();
    await output.finalize();
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  } finally { inputs.forEach(input => input.dispose()); }
}
