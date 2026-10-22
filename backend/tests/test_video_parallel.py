"""Run with unittest; real range-transfer tests also require aria2c on PATH."""
import re
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from app.config import settings
from app.downloader import _base_opts
from app.errors import JobCancelled
from app.video_dl import VideoYoutubeDL, _ProgressAria2FD


class VideoDownloadOptionsTests(unittest.TestCase):
    def test_fragment_parallelism_uses_the_video_connection_limit(self):
        self.assertEqual(_base_opts()["concurrent_fragment_downloads"], settings.video_connections)

    def test_native_downloader_handles_unsupported_transfer_options(self):
        for params, changes in [
            ({"concurrent_fragment_downloads": 1}, {}),
            ({"concurrent_fragment_downloads": 8, "proxy": "socks5://localhost:1080"}, {}),
            ({"concurrent_fragment_downloads": 8}, {"is_live": True}),
            ({"concurrent_fragment_downloads": 8}, {"impersonate": "chrome"}),
            ({"concurrent_fragment_downloads": 8}, {"protocol": "m3u8_native"}),
        ]:
            with self.subTest(params=params, changes=changes):
                with VideoYoutubeDL({"quiet": True, **params}) as ydl:
                    with patch.object(YoutubeDL, "dl", return_value=(True, True)) as native:
                        result = ydl.dl("video.mp4", {"url": "https://example.com/video", **changes})
                self.assertEqual(result, (True, True))
                native.assert_called_once()

    def test_missing_aria2_uses_native_downloader(self):
        with VideoYoutubeDL({"quiet": True, "concurrent_fragment_downloads": 8}) as ydl:
            with patch("app.video_dl.shutil.which", return_value=None):
                with patch.object(YoutubeDL, "dl", return_value=(True, True)) as native:
                    ydl.dl("video.mp4", {"url": "https://example.com/video"})
        native.assert_called_once()

    def test_unreachable_progress_rpc_stops_the_child_for_native_fallback(self):
        process = Mock()
        process.poll.return_value = None
        opener = Mock()
        opener.open.side_effect = OSError("unreachable")
        with VideoYoutubeDL({"quiet": True}) as ydl:
            fd = _ProgressAria2FD(ydl, ydl.params)
            with patch.object(fd, "_make_cmd", return_value=["aria2c", "--", "https://example.com/video"]):
                with patch("app.video_dl.build_opener", return_value=opener):
                    with patch("app.video_dl.subprocess.Popen", return_value=process):
                        with patch("app.video_dl.time.monotonic", side_effect=[0, 11]):
                            with self.assertRaisesRegex(OSError, "progress connection unavailable"):
                                fd._call_downloader("video.mp4.part", {})
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)


class RangeTransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.destination = Path(self.temp.name) / "video.mp4"
        self.body = bytes(range(256)) * (8 * 1024 * 1024 // 256)
        self.active = 0
        self.peak = 0
        self.ranges = []
        self.disconnects = 0
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.headers.get("X-Video-Test") != "preserved":
                    self.send_error(403)
                    return
                start, end = 0, len(owner.body) - 1
                byte_range = self.headers.get("Range")
                if byte_range and self.path != "/ignore-range":
                    match = re.fullmatch(r"bytes=(\d+)-(\d*)", byte_range)
                    if not match:
                        self.send_error(416)
                        return
                    start = int(match[1])
                    end = min(int(match[2]) if match[2] else end, end)
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(owner.body)}")
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(end - start + 1))
                self.send_header("Content-Type", "video/mp4")
                if self.path != "/ignore-range":
                    self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                with owner.lock:
                    owner.active += 1
                    owner.peak = max(owner.peak, owner.active)
                    if byte_range:
                        owner.ranges.append(byte_range)
                try:
                    if self.path == "/disconnect-always" or (
                        self.path == "/disconnect-once" and owner.disconnects == 0
                    ):
                        owner.disconnects += 1
                        self.wfile.write(owner.body[start:start + 65536])
                        self.wfile.flush()
                        self.close_connection = True
                        return
                    for offset in range(start, end + 1, 65536):
                        self.wfile.write(owner.body[offset:min(offset + 65536, end + 1)])
                        self.wfile.flush()
                        time.sleep(0.01)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    with owner.lock:
                        owner.active -= 1

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def transfer(self, path="/video", hook=None, connections=8):
        events = []

        def report(event):
            events.append(dict(event))
            if hook:
                hook(event)

        with VideoYoutubeDL({"quiet": True, "noprogress": True,
                             "concurrent_fragment_downloads": connections,
                             "retries": _base_opts()["retries"],
                             "progress_hooks": [report]}) as ydl:
            result = ydl.dl(str(self.destination), {
                "url": f"http://127.0.0.1:{self.server.server_port}{path}",
                "format_id": "video", "ext": "mp4", "filesize": len(self.body),
                "http_headers": {"X-Video-Test": "preserved"},
            })
        self.assertTrue(result[0])
        self.assertEqual(self.destination.read_bytes(), self.body)
        self.assertEqual(events[-1]["status"], "finished")
        self.assertEqual(events[-1]["downloaded_bytes"], len(self.body))
        return events

    def test_interrupted_native_stream_resumes_without_corrupting_the_file(self):
        self.transfer("/disconnect-once", connections=1)
        self.assertEqual(self.disconnects, 1)
        self.assertTrue(any(int(re.match(r"bytes=(\d+)-", value)[1]) > 0 for value in self.ranges))

    def test_persistently_interrupted_stream_stops_after_the_retry_limit(self):
        with self.assertRaises(DownloadError):
            self.transfer("/disconnect-always", connections=1)
        self.assertEqual(self.disconnects, _base_opts()["retries"] + 1)
        self.assertFalse(self.destination.exists())

    @unittest.skipUnless(shutil.which("aria2c"), "aria2c is required for real parallel transfer")
    def test_parallel_ranges_preserve_content_headers_and_live_progress(self):
        events = self.transfer()
        self.assertGreater(self.peak, 1)
        self.assertTrue(self.ranges)
        self.assertTrue(any(event.get("connections", 0) > 1 for event in events))
        self.assertTrue(any(event["status"] == "downloading"
                            and 0 < event.get("downloaded_bytes", 0) < len(self.body)
                            for event in events))

    @unittest.skipUnless(shutil.which("aria2c"), "aria2c is required for range fallback")
    def test_server_without_range_support_still_downloads_correctly(self):
        self.transfer("/ignore-range")

    @unittest.skipUnless(shutil.which("aria2c"), "aria2c is required for child process cancellation")
    def test_cancellation_terminates_aria2(self):
        processes = []
        start_process = subprocess.Popen

        def spawn(*args, **kwargs):
            process = start_process(*args, **kwargs)
            processes.append(process)
            return process

        def cancel(event):
            if event["status"] == "downloading" and event.get("downloaded_bytes", 0) > 0:
                raise JobCancelled()

        with patch("app.video_dl.subprocess.Popen", side_effect=spawn):
            with self.assertRaises(JobCancelled):
                self.transfer(hook=cancel)
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())
        self.assertFalse(self.destination.exists())

    def test_failed_parallel_transfer_restarts_instead_of_resuming_sparse_data(self):
        def fail(fd, filename, info, subtitle=False):
            Path(filename + ".part").write_bytes(b"invalid sparse data" * 1000)
            Path(filename + ".part.aria2").write_bytes(b"control file")
            raise DownloadError("parallel transfer unavailable")

        with patch("app.video_dl.shutil.which", return_value="aria2c"):
            with patch("app.video_dl._ProgressAria2FD.download", new=fail):
                self.transfer()
        self.assertFalse(Path(str(self.destination) + ".part.aria2").exists())

    def test_one_connection_downloads_with_native_yt_dlp(self):
        with patch("app.video_dl._ProgressAria2FD.download") as parallel:
            self.transfer(connections=1)
        parallel.assert_not_called()


if __name__ == "__main__":
    unittest.main()
