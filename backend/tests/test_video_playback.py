"""Persisted videos stream inline without changing attachment downloads."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import history, jobs
from app.config import settings
from app.main import app


class VideoPlaybackTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.downloads = self.directory / "downloads"
        self.downloads.mkdir()
        for name, value in [("data_dir", self.directory), ("download_dir", self.downloads)]:
            change = patch.object(settings, name, value)
            change.start()
            self.addCleanup(change.stop)
        registry = patch.dict(jobs._jobs, {}, clear=True)
        registry.start()
        self.addCleanup(registry.stop)
        self.client = TestClient(app)

    def record(self, filename="video.mp4", *, kind="youtube", content=b"0123456789", **extra):
        path = self.downloads / "same-job" / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        record = {"id": "same-job", "kind": kind, "filename": filename,
                  "path": str(path), "created": 1, **extra}
        history.append(record)
        return record

    def test_each_persisted_video_has_its_own_restart_safe_stream_url(self):
        for index, kind in enumerate(["youtube", "bilibili", "http", "bt"]):
            self.record(f"{index}.webm", kind=kind, content=kind.encode())
        items = self.client.get("/api/history").json()["items"]
        self.assertEqual(len({item["stream_url"] for item in items}), 4)
        self.assertEqual(jobs._jobs, {})
        for item in items:
            with self.subTest(kind=item["kind"]):
                response = self.client.get(item["stream_url"])
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, item["kind"].encode())
                self.assertEqual(response.headers["content-type"], "video/webm")
                self.assertTrue(response.headers["content-disposition"].startswith("inline;"))

    def test_inline_get_head_and_ranges_preserve_attachment_defaults(self):
        self.record()
        item = self.client.get("/api/history").json()["items"][0]
        url = item["stream_url"]
        head = self.client.head(url)
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.content, b"")
        self.assertEqual(head.headers["content-length"], "10")
        self.assertEqual(head.headers["accept-ranges"], "bytes")
        self.assertTrue(head.headers["content-disposition"].startswith("inline;"))
        for byte_range, expected, content_range in [
            ("bytes=2-5", b"2345", "bytes 2-5/10"),
            ("bytes=7-", b"789", "bytes 7-9/10"),
            ("bytes=-3", b"789", "bytes 7-9/10"),
        ]:
            with self.subTest(byte_range=byte_range):
                response = self.client.get(url, headers={"Range": byte_range})
                self.assertEqual(response.status_code, 206)
                self.assertEqual(response.content, expected)
                self.assertEqual(response.headers["content-range"], content_range)
                self.assertTrue(response.headers["content-disposition"].startswith("inline;"))
        invalid = self.client.get(url, headers={"Range": "bytes=20-30"})
        self.assertEqual(invalid.status_code, 416)
        download = self.client.get(item["download_url"])
        self.assertEqual(download.content, b"0123456789")
        self.assertTrue(download.headers["content-disposition"].startswith("attachment;"))

    def test_expired_nonvideo_and_unsafe_files_are_not_streamable(self):
        expired = self.record("expired.mp4")
        Path(expired["path"]).unlink()
        for filename in ["audio.mp3", "archive.zip", "page.html"]:
            self.record(filename, mime="video/mp4")  # Do not trust a stored MIME.
        outside = self.directory / "outside.mp4"
        outside.write_bytes(b"keep")
        link = self.downloads / "same-job" / "escape.mp4"
        link.symlink_to(outside)
        for path in [outside, link]:
            history.append({"id": "same-job", "kind": "http", "path": str(path), "created": 1})
        items = self.client.get("/api/history").json()["items"]
        for item in items:
            with self.subTest(key=item["key"]):
                self.assertIsNone(item["stream_url"])
                response = self.client.get(f'/api/history/files/{item["key"]}?inline=true')
                self.assertIn(response.status_code, [404, 415])
        self.assertEqual(outside.read_bytes(), b"keep")

    def test_file_removed_after_listing_and_unknown_keys_return_404(self):
        record = self.record()
        item = self.client.get("/api/history").json()["items"][0]
        Path(record["path"]).unlink()
        self.assertEqual(self.client.get(item["stream_url"]).status_code, 404)
        self.assertEqual(self.client.head(item["stream_url"]).status_code, 404)
        self.assertEqual(self.client.get("/api/history/files/unknown?inline=true").status_code, 404)


if __name__ == "__main__":
    unittest.main()
