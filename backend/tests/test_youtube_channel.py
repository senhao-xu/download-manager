"""Bound channel extraction and keep queued videos independent and deduplicated."""
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import downloader, history, jobs
from app.main import app
from app.schemas import QueueVideo


def entry(number):
    video_id = f"video{number:06d}"
    return {"id": video_id, "url": f"https://www.youtube.com/watch?v={video_id}",
            "title": f"Video {number}", "duration": 61}


class ChannelExtractionTests(unittest.TestCase):
    def test_channel_roots_and_supported_tabs(self):
        for path in ["@chefwang", "@chefwang/featured", "channel/UC123", "user/chef", "c/chef"]:
            with self.subTest(path=path):
                actual = downloader.channel_url(f"https://www.youtube.com/{path}")
                self.assertTrue(actual.endswith("/videos"))
        for tab in ["videos", "shorts", "streams"]:
            self.assertEqual(downloader.channel_url(f"https://m.youtube.com/@chefwang/{tab}"),
                             f"https://www.youtube.com/@chefwang/{tab}")
        for url in ["https://youtube.com.evil.test/@chef/videos", "file://youtube.com/@chef",
                    "https://www.youtube.com/watch?v=video000001", "https://www.youtube.com/playlist?list=123"]:
            self.assertIsNone(downloader.channel_url(url))

    def test_extracts_only_the_requested_flat_page_plus_one_lookahead(self):
        raw = {"_type": "playlist", "title": "Chef Wang", "entries": [entry(n) for n in range(21, 42)]}
        with patch("app.downloader.YoutubeDL") as factory:
            factory.return_value.__enter__.return_value.extract_info.return_value = raw
            result = downloader.extract_info_sync("https://www.youtube.com/@chefwang", page=2)
        opts = factory.call_args.args[0]
        self.assertEqual((opts["extract_flat"], opts["playliststart"], opts["playlistend"]), ("in_playlist", 21, 41))
        factory.return_value.__enter__.return_value.extract_info.assert_called_once_with(
            "https://www.youtube.com/@chefwang/videos", download=False)
        self.assertTrue(result.is_channel)
        self.assertTrue(result.has_more)
        self.assertEqual(len(result.entries), 20)
        self.assertEqual(result.entries[0].id, "video000021")
        self.assertTrue(result.entries[0].thumbnail.startswith("/api/thumbnail?"))
        self.assertEqual(result.entries[0].duration, 61)
        self.assertEqual(result.formats, [])
        self.assertEqual(result.page, 2)

    def test_last_page_skips_unavailable_entries_and_recovers_flat_ids(self):
        raw = {"entries": [None, {"id": "video000001", "url": "video000001"},
                           {"id": "invalid", "url": "https://example.com"}]}
        result = downloader._normalize_channel(raw, page=3, page_size=20)
        self.assertFalse(result.has_more)
        self.assertEqual([e.url for e in result.entries], ["https://www.youtube.com/watch?v=video000001"])

    def test_single_video_and_regular_playlist_keep_full_extraction(self):
        for url in ["https://youtu.be/video000001", "https://www.youtube.com/playlist?list=123"]:
            with self.subTest(url=url), patch("app.downloader.YoutubeDL") as factory:
                factory.return_value.__enter__.return_value.extract_info.return_value = {"title": "Video"}
                result = downloader.extract_info_sync(url)
                self.assertFalse(factory.call_args.args[0]["extract_flat"])
                self.assertNotIn("playlistend", factory.call_args.args[0])
                self.assertFalse(result.is_channel)

    def test_info_api_marks_available_downloads_without_creating_jobs(self):
        result = downloader._normalize_channel({"entries": [entry(1), entry(2)]}, 2, 20)
        with patch("app.routes.downloader.extract_info", return_value=result) as extract:
            with patch("app.routes.history.available_video_ids", return_value={"video000001"}):
                with patch("app.jobs._executor.submit") as submit:
                    response = TestClient(app).post("/api/info", json={
                        "url": "https://www.youtube.com/@chefwang/videos", "page": 2,
                    })
        self.assertEqual(response.status_code, 200)
        self.assertEqual([e["downloaded"] for e in response.json()["entries"]], [True, False])
        extract.assert_awaited_once_with("https://www.youtube.com/@chefwang/videos", page=2, page_size=20)
        submit.assert_not_called()

    def test_page_limits_are_validated_before_extraction(self):
        client = TestClient(app)
        with patch("app.routes.downloader.extract_info") as extract:
            for limits in [{"page": 0}, {"page": 1001}, {"page_size": 0}, {"page_size": 51}]:
                self.assertEqual(client.post("/api/info", json={"url": "https://youtube.com/@chefwang", **limits}).status_code, 422)
        extract.assert_not_called()


class ChannelQueueTests(unittest.TestCase):
    def setUp(self):
        self.registry = patch.dict(jobs._jobs, {}, clear=True)
        self.registry.start()
        self.addCleanup(self.registry.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def test_skip_available_files_but_allow_expired_downloads(self):
        existing = self.directory / "existing.mp4"
        existing.write_bytes(b"video")
        records = [{"kind": "youtube", "source": entry(1)["url"], "path": str(existing)},
                   {"kind": "youtube", "source": entry(2)["url"], "path": str(self.directory / "expired.mp4")},
                   {"kind": "bilibili", "source": entry(3)["url"], "path": str(existing)}]
        with patch("app.history.list_all", return_value=records):
            self.assertEqual(history.available_video_ids(), {"video000001"})
            with patch("app.jobs._executor.submit") as submit:
                created, downloaded, active = jobs.queue_videos([QueueVideo(**entry(n)) for n in (1, 2)], "1080")
        self.assertEqual((len(created), downloaded, active), (1, 1, 0))
        self.assertEqual(created[0].source, entry(2)["url"])
        self.assertEqual(submit.call_args.args[3], "1080")

    def test_skip_can_be_disabled_but_active_and_in_request_duplicates_are_skipped(self):
        jobs._jobs["active"] = jobs.Job(id="active", kind="youtube", source=entry(2)["url"], status="paused")
        videos = [QueueVideo(**entry(1)), QueueVideo(url="https://youtu.be/video000001?t=5"), QueueVideo(**entry(2))]
        with patch("app.jobs.history.available_video_ids", return_value={"video000001"}) as available:
            with patch("app.jobs._executor.submit") as submit:
                created, downloaded, active = jobs.queue_videos(videos, "best", skip_downloaded=False)
        available.assert_not_called()
        self.assertEqual((len(created), downloaded, active), (1, 0, 2))
        self.assertEqual(submit.call_count, 1)
        snapshot = jobs.snapshot(created[0])
        self.assertEqual(snapshot.title, "Video 1")
        self.assertEqual(snapshot.source, entry(1)["url"])
        self.assertTrue(snapshot.thumbnail.startswith("/api/thumbnail?"))

    def test_invalid_later_entry_does_not_partially_enqueue(self):
        with patch("app.jobs._executor.submit") as submit:
            with self.assertRaises(ValueError):
                jobs.queue_videos([QueueVideo(**entry(1)), QueueVideo(url="https://youtube.com/@chefwang/videos")], "best")
        self.assertEqual(jobs._jobs, {})
        submit.assert_not_called()

    def test_concurrent_requests_reserve_video_ids_atomically(self):
        videos = [QueueVideo(**entry(n)) for n in range(1, 21)]
        with patch("app.jobs.history.available_video_ids", return_value=set()):
            with patch("app.jobs._executor.submit") as submit:
                with ThreadPoolExecutor(max_workers=4) as pool:
                    results = list(pool.map(lambda _: jobs.queue_videos(videos, "best"), range(4)))
        self.assertEqual(sum(len(result[0]) for result in results), 20)
        self.assertEqual(sum(result[2] for result in results), 60)
        self.assertEqual(submit.call_count, 20)

    def test_one_failed_video_does_not_stop_later_jobs(self):
        def directory(job_id):
            path = self.directory / job_id
            path.mkdir()
            return path

        def download(url, quality, dest, hook, site):
            if url == entry(1)["url"]:
                raise RuntimeError("This video is unavailable")
            output = dest / "video.mp4"
            output.write_bytes(b"video")
            return {"title": "Good video"}, [output]

        with patch("app.jobs.history.available_video_ids", return_value=set()):
            with patch("app.jobs.storage.job_dir", side_effect=directory):
                with patch("app.jobs.downloader.download_sync", side_effect=download):
                    with patch("app.jobs.history.append") as append:
                        with ThreadPoolExecutor(max_workers=1) as executor:
                            with patch("app.jobs._executor", executor):
                                created, _, _ = jobs.queue_videos([QueueVideo(**entry(n)) for n in (1, 2)], "best")
        self.assertEqual([job.status for job in created], ["error", "done"])
        self.assertEqual(append.call_count, 1)

    def test_queue_api_validates_bounds_and_returns_individual_snapshots(self):
        client = TestClient(app)
        with patch("app.jobs.history.available_video_ids", return_value=set()):
            with patch("app.jobs._executor.submit") as submit:
                for videos in [[], [entry(1)] * 101]:
                    self.assertEqual(client.post("/api/download-queue", json={"entries": videos}).status_code, 422)
                self.assertEqual(client.post("/api/download-queue", json={"entries": [{"url": "https://example.com/video"}]}).status_code, 400)
                response = client.post("/api/download-queue", json={"entries": [entry(1), entry(2)], "quality": "2160"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body["jobs"]), 2)
        self.assertNotEqual(body["jobs"][0]["id"], body["jobs"][1]["id"])
        self.assertTrue(all(job["status"] == "queued" for job in body["jobs"]))
        self.assertEqual(submit.call_count, 2)


if __name__ == "__main__":
    unittest.main()
