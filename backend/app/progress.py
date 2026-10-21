"""Transfer telemetry shared by video, HTTP and torrent workers.

Bytes describe the current item, including its audio/video streams. Batch
progress remains item-weighted; batch totals are only known at completion.
"""
import math


def _positive(value):
    return value if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else None


class TransferProgress:
    def __init__(self):
        self.streams: dict[str, dict] = {}

    @staticmethod
    def _size(info):
        exact = _positive(info.get("total_bytes")) or _positive(info.get("filesize"))
        estimate = _positive(info.get("total_bytes_estimate")) or _positive(info.get("filesize_approx"))
        return (int(exact or estimate) if exact or estimate else None, not bool(exact) and bool(estimate))

    def update(self, event: dict) -> dict:
        status = event.get("status")
        if status == "metadata":
            info = event["info_dict"]
            self.streams = {}
            for index, fmt in enumerate(info.get("requested_formats") or [info]):
                size, estimated = self._size(fmt)
                key = str(fmt.get("format_id") or index)
                self.streams[key] = {"done": 0, "total": size, "estimated": estimated, "finished": False}
        elif status in ("downloading", "finished"):
            info = event.get("info_dict") or {}
            key = str(info.get("format_id") or event.get("filename") or "0")
            # A single unnamed stream can use the actual filename once known.
            if key not in self.streams and set(self.streams) == {"0"}:
                self.streams[key] = self.streams.pop("0")
            stream = self.streams.setdefault(key, {"done": 0, "total": None, "estimated": False, "finished": False})
            size, estimated = self._size(event)
            if size is not None:
                stream.update(total=size, estimated=estimated)
            done = _positive(event.get("downloaded_bytes"))
            if done is not None:
                stream["done"] = max(stream["done"], int(done))
            if status == "finished":
                stream["finished"] = True
                # A finished stream's byte count is authoritative even when
                # the server never supplied Content-Length.
                if stream["done"]:
                    stream.update(total=stream["done"], estimated=False)

        downloaded = sum(s["done"] for s in self.streams.values())
        known = bool(self.streams) and all(s["total"] is not None for s in self.streams.values())
        total = sum(max(s["total"], s["done"]) for s in self.streams.values()) if known else None
        speed = event.get("speed") if status == "downloading" else None
        if not isinstance(speed, (int, float)) or not math.isfinite(speed) or speed < 0:
            speed = None
        eta = max(0, (total - downloaded) / speed) if total is not None and speed else None
        if eta is None and len(self.streams) == 1 and status == "downloading":
            candidate = event.get("eta")
            if isinstance(candidate, (int, float)) and math.isfinite(candidate) and candidate >= 0:
                eta = candidate
        return {
            "downloaded_bytes": downloaded,
            "total_bytes": total,
            "total_bytes_estimated": known and any(s["estimated"] for s in self.streams.values()),
            "speed": speed,
            "eta": eta,
        }

    @property
    def fraction(self) -> float:
        if not self.streams or any(s["total"] is None for s in self.streams.values()):
            return 0.0
        total = sum(max(s["total"], s["done"]) for s in self.streams.values())
        return min(1.0, sum(s["done"] for s in self.streams.values()) / total) if total else 0.0

    @property
    def finished(self) -> bool:
        return bool(self.streams) and all(s["finished"] for s in self.streams.values())
