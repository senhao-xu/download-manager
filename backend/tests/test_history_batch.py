"""History batch operations must isolate records, files and concurrent writers."""
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import history, jobs
from app.config import settings
from app.main import app


class HistoryBatchTests(unittest.TestCase):
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

    def record(self, job_id="batch", filename="one.txt", *, kind="http", exists=True, **extra):
        path = self.downloads / job_id / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        if exists:
            path.write_text(filename, encoding="utf-8")
        record = {"id": job_id, "kind": kind, "filename": filename, "path": str(path),
                  "created": len(history.list_all()) + 1, **extra}
        history.append(record)
        return record

    def delete(self, records, delete_files=False):
        return self.client.post("/api/history/batch-delete", json={
            "keys": [history.record_key(record) for record in records], "delete_files": delete_files,
        })

    def test_old_records_have_distinct_stable_keys_and_restart_safe_downloads(self):
        records = [self.record(filename=name) for name in ["one.txt", "two.txt"]]
        first = self.client.get("/api/history?kind=http").json()
        second = self.client.get("/api/history?kind=http").json()
        self.assertEqual(first, second)
        self.assertEqual(first["total"], 2)
        self.assertEqual(len({item["key"] for item in first["items"]}), 2)
        self.assertEqual({item["id"] for item in first["items"]}, {"batch"})
        self.assertEqual(jobs._jobs, {})
        for item in first["items"]:
            self.assertTrue(item["available"])
            response = self.client.get(item["download_url"])
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.text, item["filename"])
            self.assertEqual(self.client.head(item["download_url"]).status_code, 200)
        self.assertEqual(history.list_all(), list(reversed(records)))
        self.assertNotIn("key", json.loads(history._path().read_text().splitlines()[0]))

    def test_default_delete_keeps_files_and_other_records_in_the_same_job(self):
        first, other = self.record(), self.record(filename="two.txt")
        response = self.delete([first])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"removed": [history.record_key(first)], "missing": [], "failed": []})
        self.assertEqual(history.list_all(), [other])
        self.assertTrue(Path(first["path"]).is_file())
        self.assertTrue(Path(other["path"]).is_file())

    def test_optional_file_cleanup_only_removes_selected_files(self):
        first, other = self.record(), self.record(filename="two.txt")
        self.assertEqual(self.delete([first], True).json()["failed"], [])
        self.assertFalse(Path(first["path"]).exists())
        self.assertTrue(Path(other["path"]).is_file())
        self.assertEqual(history.list_all(), [other])

    def test_expired_and_already_removed_records_are_idempotent(self):
        expired = self.record(exists=False)
        item = self.client.get("/api/history").json()["items"][0]
        self.assertFalse(item["available"])
        self.assertIsNone(item["download_url"])
        url = f"/api/history/files/{history.record_key(expired)}"
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.delete([expired], True).json()["removed"], [history.record_key(expired)])
        self.assertEqual(self.delete([expired]).json()["missing"], [history.record_key(expired)])

    def test_partial_file_failure_preserves_failed_record_and_deletes_successes(self):
        first, second = self.record(), self.record(filename="two.txt")
        unlink = Path.unlink

        def remove(path, *args, **kwargs):
            if path == Path(first["path"]):
                raise PermissionError("locked")
            return unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", remove):
            result = self.delete([first, second], True).json()
        self.assertEqual(result["removed"], [history.record_key(second)])
        self.assertEqual(result["failed"], [{"key": history.record_key(first), "reason": "delete_failed"}])
        self.assertEqual(history.list_all(), [first])
        self.assertTrue(Path(first["path"]).exists())
        self.assertEqual(self.delete([first], True).json()["failed"], [])

    def test_active_job_files_are_protected(self):
        record = self.record()
        jobs._jobs[record["id"]] = jobs.Job(id=record["id"], status="running", kind="http")
        self.assertEqual(self.delete([record], True).json()["failed"], [
            {"key": history.record_key(record), "reason": "active_job"},
        ])
        self.assertTrue(Path(record["path"]).exists())
        self.assertEqual(history.list_all(), [record])

    def test_unselected_record_sharing_a_file_is_protected(self):
        first = self.record()
        second = self.record(title="another reference")
        self.assertEqual(self.delete([first], True).json()["failed"][0]["reason"], "shared_file")
        self.assertTrue(Path(first["path"]).exists())
        self.assertEqual(len(self.delete([first, second], True).json()["removed"]), 2)
        self.assertFalse(Path(first["path"]).exists())

    def test_unsafe_paths_and_symlink_escapes_cannot_be_served_or_deleted(self):
        outside = self.directory / "outside.txt"
        outside.write_text("keep")
        job_dir = self.downloads / "batch"
        job_dir.mkdir()
        (job_dir / "escape.txt").symlink_to(outside)
        for path in [outside, job_dir / "escape.txt", self.downloads / "other" / "file.txt"]:
            record = {"id": "batch", "kind": "http", "path": str(path), "created": 1}
            history.append(record)
            key = history.record_key(record)
            self.assertEqual(self.client.get(f"/api/history/files/{key}").status_code, 404)
            self.assertEqual(self.delete([record], True).json()["failed"][0]["reason"], "invalid_path")
            self.assertEqual(self.delete([record]).json()["removed"], [key])
        self.assertEqual(outside.read_text(), "keep")

    def test_job_directory_symlink_and_invalid_job_ids_are_rejected(self):
        (self.downloads / "escape").symlink_to(self.directory, target_is_directory=True)
        for job_id in ["escape", "..", "../outside", "", "."]:
            with self.subTest(job_id=job_id), self.assertRaises(ValueError):
                history.record_path({"id": job_id, "path": str(self.directory / "file.txt")})

    def test_pagination_order_filters_and_legacy_delete_remain_compatible(self):
        records = [self.record(filename=f"{index}.txt", kind="youtube" if index == 0 else "http")
                   for index in range(12)]
        page = self.client.get("/api/history?kind=http&page=2&page_size=10").json()
        self.assertEqual((page["total"], page["page"], len(page["items"])), (11, 2, 1))
        self.assertEqual(page["items"][0]["filename"], "1.txt")
        self.delete([records[1]])
        self.assertEqual(self.client.get("/api/history?kind=http").json()["total"], 10)
        self.assertEqual(self.client.delete("/api/history/batch").json(), {"ok": True, "deleted_files": False})
        self.assertEqual(history.list_all(), [])
        self.assertEqual(self.client.delete("/api/history/batch").status_code, 404)

    def test_duplicate_keys_and_identical_records_are_one_logical_selection(self):
        record = self.record()
        history.append(record)
        self.assertEqual(self.client.get("/api/history").json()["total"], 1)
        self.assertEqual(self.delete([record, record]).json()["removed"], [history.record_key(record)])
        self.assertEqual(history.list_all(), [])

    def test_batch_request_limits(self):
        for keys in [[], ["key"] * 101]:
            self.assertEqual(self.client.post("/api/history/batch-delete", json={"keys": keys}).status_code, 422)

    def test_atomic_replace_failure_keeps_original_index(self):
        record = self.record()
        original = history._path().read_bytes()
        with patch("app.history.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                history.delete_by_keys([history.record_key(record)])
        self.assertEqual(history._path().read_bytes(), original)
        self.assertEqual(list(self.directory.glob(".history-*")), [])

    def test_deleting_does_not_lose_a_concurrent_append(self):
        record = self.record()
        entered, release = threading.Event(), threading.Event()
        read = history._read_unlocked

        def paused_read():
            result = read()
            entered.set()
            self.assertTrue(release.wait(3))
            return result

        new_record = {"id": "new", "created": 2}
        with ThreadPoolExecutor(max_workers=2) as pool:
            with patch("app.history._read_unlocked", side_effect=paused_read):
                deletion = pool.submit(history.delete_by_keys, [history.record_key(record)])
                self.assertTrue(entered.wait(3))
                append = pool.submit(history.append, new_record)
                release.set()
                deletion.result(timeout=3)
                append.result(timeout=3)
        self.assertEqual(history.list_all(), [new_record])

    def test_concurrent_deletes_preserve_unselected_records_and_order(self):
        records = [self.record(filename=f"{index}.txt") for index in range(5)]
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda record: history.delete_by_keys([history.record_key(record)]), records[:3]))
        self.assertTrue(all(len(result["removed"]) == 1 for result in results))
        self.assertEqual(history.list_all(), list(reversed(records[3:])))
        lines = [json.loads(line) for line in history._path().read_text().splitlines()]
        self.assertEqual(lines, records[3:])


if __name__ == "__main__":
    unittest.main()
