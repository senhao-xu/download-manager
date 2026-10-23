# Owned MP4 browser fixture

`playback.mp4` is the existing project-owned synthetic eight-second
`frontend/tests/fixtures/playback.webm` converted to H.264/AAC. It is used only
by development tests and is not included in the extension package.

Regenerate with a development FFmpeg installation:

```sh
ffmpeg -i frontend/tests/fixtures/playback.webm -c:v libx264 -preset veryfast \
  -crf 30 -pix_fmt yuv420p -c:a aac -b:a 48k -movflags +faststart \
  extension/tests/fixtures/playback.mp4
```

Running tests or using the extension does not require FFmpeg.
