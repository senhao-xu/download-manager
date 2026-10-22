`playback.webm` is a synthetic eight-second 160×90 VP8/Opus clip (solid blue and
a 440 Hz tone), generated for playback/seek tests. It contains no user media.

Regenerate with FFmpeg:

```sh
ffmpeg -f lavfi -i color=c=0x274c77:s=160x90:r=10 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 8 \
  -c:v libvpx -b:v 40k -g 10 -c:a libopus -b:a 16k playback.webm
```
