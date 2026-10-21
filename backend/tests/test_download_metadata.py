"""Regressions for transfer telemetry, metadata covers and image delivery.

Run from backend/: .venv/bin/python -m unittest discover -s tests -v
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from app import downloader, http_dl, jobs, thumbnails
from app.main import app
from app.progress import TransferProgress


class ProgressTests(unittest.TestCase):
    def test_audio_and_video_share_one_total_without_early_completion(self):
        transfer = TransferProgress()
        initial = transfer.update({"status": "metadata", "info_dict": {"requested_formats": [
            {"format_id": "video", "filesize": 800}, {"format_id": "audio", "filesize": 200},
        ]}})
        self.assertEqual(initial["total_bytes"], 1000)
        ev = {"status": "downloading", "info_dict": {"format_id": "video"}, "total_bytes": 800,
              "downloaded_bytes": 400, "speed": 100}
        state = transfer.update(ev)
        self.assertEqual(state["downloaded_bytes"], 400)
        self.assertEqual(state["eta"], 6)
        self.assertEqual(transfer.fraction, 0.4)
        transfer.update({**ev, "status": "finished", "downloaded_bytes": 800})
        self.assertFalse(transfer.finished)
        self.assertEqual(transfer.fraction, 0.8)
        state = transfer.update({"status": "finished", "info_dict": {"format_id": "audio"}, "downloaded_bytes": 200})
        self.assertTrue(transfer.finished)
        self.assertEqual(state["downloaded_bytes"], state["total_bytes"])
        self.assertIsNone(state["speed"])

    def test_unknown_size_is_not_reported_as_zero(self):
        transfer = TransferProgress()
        state = transfer.update({"status": "downloading", "downloaded_bytes": 400, "speed": 100})
        self.assertIsNone(state["total_bytes"])
        self.assertIsNone(state["eta"])
        self.assertEqual(transfer.fraction, 0)
        state = transfer.update({"status": "finished", "downloaded_bytes": 500})
        self.assertEqual(state["total_bytes"], 500)
        self.assertEqual(transfer.fraction, 1)

    def test_incomplete_stream_metadata_does_not_claim_a_combined_size(self):
        transfer = TransferProgress()
        transfer.update({"status": "metadata", "info_dict": {"requested_formats": [
            {"format_id": "video", "filesize": 800}, {"format_id": "audio"},
        ]}})
        state = transfer.update({"status": "finished", "info_dict": {"format_id": "video"}, "downloaded_bytes": 800})
        self.assertIsNone(state["total_bytes"])
        state = transfer.update({"status": "downloading", "info_dict": {"format_id": "audio"}, "total_bytes": 200, "downloaded_bytes": 100})
        self.assertEqual(state["total_bytes"], 1000)
        self.assertEqual(state["downloaded_bytes"], 900)

    def test_estimated_sizes_and_repeated_hooks(self):
        transfer = TransferProgress()
        event = {"status": "downloading", "filename": "video.mp4", "total_bytes_estimate": 1000, "downloaded_bytes": 600}
        state = transfer.update(event)
        self.assertTrue(state["total_bytes_estimated"])
        self.assertEqual(transfer.update(event)["downloaded_bytes"], 600)
        state = transfer.update({**event, "status": "finished", "downloaded_bytes": 900})
        self.assertFalse(state["total_bytes_estimated"])
        self.assertEqual(state["total_bytes"], 900)

    def test_invalid_rates_and_zero_speed(self):
        transfer = TransferProgress()
        for speed in [None, -1, float("nan"), float("inf")]:
            self.assertIsNone(transfer.update({"status": "downloading", "speed": speed})["speed"])
        self.assertEqual(transfer.update({"status": "downloading", "speed": 0})["speed"], 0)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        for target, value in [("app.jobs.storage.job_dir", self.directory), ("app.jobs._record_history", None)]:
            p = patch(target, return_value=value)
            p.start()
            self.addCleanup(p.stop)

    def test_single_worker_exposes_combined_bytes_until_merged(self):
        job = jobs.Job(id="single", kind="youtube")
        snapshots = []

        def download(url, quality, directory, hook, site):
            hook({"status": "metadata", "info_dict": {"requested_formats": [
                {"format_id": "v", "filesize": 800}, {"format_id": "a", "filesize": 200},
            ]}})
            hook({"status": "finished", "info_dict": {"format_id": "v"}, "downloaded_bytes": 800})
            snapshots.append(jobs.snapshot(job))
            hook({"status": "downloading", "info_dict": {"format_id": "a"}, "downloaded_bytes": 100, "total_bytes": 200, "speed": 50})
            snapshots.append(jobs.snapshot(job))
            output = directory / "merged.mp4"
            output.write_bytes(b"x" * 990)
            return {"title": "Video"}, [output]

        with patch("app.jobs.downloader.download_sync", side_effect=download):
            jobs._run_single(job, "https://example.com/video", "best")
        self.assertLess(snapshots[0].progress, 90)
        self.assertEqual(snapshots[0].total_bytes, 1000)
        self.assertEqual(snapshots[1].downloaded_bytes, 900)
        self.assertEqual(snapshots[1].eta, 2)
        self.assertEqual(job.status, "done")
        self.assertEqual(job.total_bytes, 990)
        self.assertEqual(job.downloaded_bytes, 990)
        self.assertIsNone(job.speed)

    def test_http_batch_resets_current_size_and_finishes_with_aggregate_size(self):
        job = jobs.Job(id="batch", kind="http")
        states = []

        def download(url, directory, hook, cancel_event):
            self.assertEqual(job.downloaded_bytes, 0)
            self.assertIsNone(job.total_bytes)
            hook({"status": "downloading", "filename": url, "downloaded_bytes": 20,
                  "total_bytes": 100 if url == "first" else 0, "speed": 10})
            states.append(jobs.snapshot(job))
            output = directory / url
            output.write_bytes(b"x" * 100)
            hook({"status": "finished", "filename": url, "downloaded_bytes": 100})
            return url, output, 100, "application/octet-stream"

        with patch("app.jobs.http_dl.download_sync", side_effect=download):
            jobs._run_http(job, ["first", "second"])
        self.assertEqual(states[0].total_bytes, 100)
        self.assertIsNone(states[1].total_bytes)
        self.assertEqual(states[1].current, 1)
        self.assertEqual(job.status, "done")
        self.assertEqual(job.total_bytes, 200)

    def test_torrent_pause_clears_rate_and_eta(self):
        job = jobs.Job(id="torrent", kind="bt")

        def download(source, directory, hook, **kwargs):
            hook({"status": "downloading", "downloaded_bytes": 50, "total_bytes": 100, "speed": 10})
            self.assertEqual(job.eta, 5)
            hook({"status": "paused"})
            self.assertEqual(job.status, "paused")
            self.assertEqual(job.downloaded_bytes, 50)
            self.assertIsNone(job.speed)
            self.assertIsNone(job.eta)
            hook({"status": "resumed"})
            output = directory / "torrent.bin"
            output.write_bytes(b"x" * 100)
            return output.name, output, 100, "application/octet-stream"

        with patch("app.jobs.bt_dl.download_sync", side_effect=download):
            jobs._run_bt(job, "magnet:test")
        self.assertEqual(job.total_bytes, 100)
        self.assertEqual(job.status, "done")

    def test_snapshot_and_sse_preserve_telemetry(self):
        job = jobs.Job(id="snapshot", status="done", progress=100, downloaded_bytes=200,
                       total_bytes=200, total_bytes_estimated=False, speed=None, eta=None)
        with patch.dict(jobs._jobs, {job.id: job}, clear=True):
            client = TestClient(app)
            status = client.get(f"/api/jobs/{job.id}").json()
            events = client.get(f"/api/jobs/{job.id}/events").text
        self.assertEqual(status["total_bytes"], 200)
        self.assertEqual(json.loads(events.removeprefix("data: ").strip())["downloaded_bytes"], 200)


class FakeImage:
    def __init__(self, mime="image/jpeg", status=200, chunks=(b"image",)):
        self.headers = {"content-type": mime}
        self.status_code = status
        self.chunks = chunks
        self.closed = False

    def iter_content(self, chunk_size):
        yield from self.chunks

    def close(self):
        self.closed = True


class CoverTests(unittest.TestCase):
    def test_localized_cover_keeps_standard_covers_as_first_fallbacks(self):
        localized = "https://i.ytimg.com/vi_lc/JDnC-M2Bq48/maxresdefault_en.jpg"
        standard = "https://i.ytimg.com/vi/JDnC-M2Bq48/maxresdefault.jpg"
        info = downloader._normalize_info({"thumbnail": localized, "thumbnails": [
            {"url": standard}, {"url": localized},
            {"url": "https://i.ytimg.com/vi_webp/JDnC-M2Bq48/maxresdefault.webp"},
        ]})
        urls = [parse_qs(urlparse(url).query)["url"][0] for url in info.thumbnail_candidates]
        self.assertEqual(urls[:2], [localized, standard])
        self.assertEqual(len(urls), len(set(urls)))
        self.assertEqual(info.thumbnail, info.thumbnail_candidates[0])

    def test_cover_fallbacks_survive_the_info_api(self):
        info = downloader._normalize_info({"thumbnail": "https://i.ytimg.com/vi_lc/id/maxresdefault_en.jpg",
            "thumbnails": [{"url": "https://i.ytimg.com/vi/id/hqdefault.jpg"}]})
        with patch("app.routes.downloader.extract_info", return_value=info):
            response = TestClient(app).post("/api/info", json={"url": "https://www.youtube.com/watch?v=JDnC-M2Bq48"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["thumbnail_candidates"]), 2)

    def test_playlist_skips_entries_without_a_usable_cover(self):
        info = downloader._normalize_info({"_type": "playlist", "entries": [
            {"title": "Missing cover", "thumbnails": [{"width": 480}]},
            {"title": "Has cover", "thumbnail": "https://i.ytimg.com/vi/id/hqdefault.jpg"},
        ]})
        self.assertIn("hqdefault.jpg", info.thumbnail)
        self.assertEqual(len(info.thumbnail_candidates), 1)

    def test_single_cover_is_upgraded_and_proxied(self):
        info = downloader._normalize_info({"thumbnail": "http://i0.hdslb.com/bfs/cover.jpg"})
        self.assertTrue(info.thumbnail.startswith("/api/thumbnail?"))
        self.assertEqual(parse_qs(urlparse(info.thumbnail).query)["url"], ["https://i0.hdslb.com/bfs/cover.jpg"])

    def test_playlist_cover_falls_back_to_first_entry_even_for_generators(self):
        entries = (e for e in [None, {"title": "First", "url": "https://example.com", "thumbnail": "https://i.ytimg.com/vi/id/hqdefault.jpg"}])
        info = downloader._normalize_info({"_type": "playlist", "entries": entries})
        self.assertIsNotNone(info.thumbnail)
        self.assertEqual(len(info.entries), 1)

    def test_thumbnail_list_is_used_when_main_cover_is_missing(self):
        info = downloader._normalize_info({"thumbnails": [{"url": "//i.ytimg.com/vi/id/hqdefault.jpg"}]})
        self.assertIn("/api/thumbnail?", info.thumbnail)

    def test_missing_cover_remains_nullable(self):
        self.assertIsNone(downloader._normalize_info({"title": "No image"}).thumbnail)

    def test_proxy_rejects_arbitrary_hosts_credentials_and_redirects(self):
        with patch("app.thumbnails.requests.get") as get:
            for url in ["http://i.ytimg.com/image.jpg", "https://127.0.0.1/image.jpg", "https://i.ytimg.com.evil.test/a", "https://user@i.ytimg.com/a", "https://i.ytimg.com:8000/a"]:
                with self.assertRaises(ValueError):
                    thumbnails.fetch_thumbnail(url)
            get.assert_not_called()
        response = FakeImage(status=302)
        with patch("app.thumbnails.requests.get", return_value=response) as get:
            with self.assertRaises(RuntimeError):
                thumbnails.fetch_thumbnail("https://i.ytimg.com/image.jpg")
            self.assertFalse(get.call_args.kwargs["allow_redirects"])
        self.assertTrue(response.closed)

    def test_proxy_uses_configured_connection_and_referer(self):
        response = FakeImage()
        with patch("app.thumbnails.requests.get", return_value=response) as get, patch("app.thumbnails.effective_opts", return_value={"proxy": "http://proxy:7890"}):
            self.assertEqual(thumbnails.fetch_thumbnail("https://i0.hdslb.com/image.jpg"), (b"image", "image/jpeg"))
            self.assertEqual(get.call_args.kwargs["proxy"], "http://proxy:7890")
            self.assertEqual(get.call_args.kwargs["headers"]["Referer"], "https://www.bilibili.com/")
        self.assertTrue(response.closed)

    def test_proxy_enforces_image_type_and_size(self):
        for response in [FakeImage(mime="text/html"), FakeImage(chunks=(b"x" * 9,)), FakeImage(chunks=())]:
            with patch("app.thumbnails.requests.get", return_value=response), patch("app.thumbnails._MAX_BYTES", 8):
                with self.assertRaises(RuntimeError):
                    thumbnails.fetch_thumbnail("https://i.ytimg.com/image.jpg")
            self.assertTrue(response.closed)

    def test_image_route_serves_cached_same_origin_image(self):
        with patch("app.routes.thumbnails.fetch_thumbnail", return_value=(b"jpeg", "image/jpeg")):
            response = TestClient(app).get("/api/thumbnail", params={"url": "https://i.ytimg.com/image.jpg"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"jpeg")
        self.assertIn("max-age", response.headers["cache-control"])


class HttpTelemetryTests(unittest.TestCase):
    def test_known_and_unknown_length_emit_size_speed_and_final_bytes(self):
        for length in [None, "10"]:
            response = FakeImage(mime="application/octet-stream", chunks=(b"12345", b"67890"))
            if length:
                response.headers["content-length"] = length
            events = []
            with tempfile.TemporaryDirectory() as directory, patch("app.http_dl.cffi_requests.get", return_value=response), patch("app.http_dl._proxy", return_value=None):
                _, _, size, _ = http_dl.download_sync("https://example.com/file.bin", Path(directory), events.append)
            self.assertEqual(size, 10)
            self.assertEqual(events[0]["total_bytes"], int(length) if length else 0)
            self.assertGreater(events[1]["speed"], 0)
            self.assertEqual(events[-1]["downloaded_bytes"], 10)
            self.assertTrue(response.closed)


if __name__ == "__main__":
    unittest.main()
