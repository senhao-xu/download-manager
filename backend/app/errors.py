"""Shared exception types for the download workers.

Leaf module (no app imports) so it can be imported by ``jobs``, ``http_dl``,
``bt_dl`` and ``downloader`` without creating circular dependencies.
"""


class JobCancelled(Exception):
    """Raised inside a worker to abort a download the user cancelled.

    Workers catch this and transition the job to the terminal ``cancelled``
    status (distinct from ``error``) without recording a history entry.
    """
    pass
