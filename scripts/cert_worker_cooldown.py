"""Saved Retry-After parsing without credentials, network, or report writes."""
import json
import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime


def _utc_timestamp(value, http_date=False):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        timestamp = parsedate_to_datetime(value) if http_date else datetime.fromisoformat(value.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        return timestamp.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def previous_retry_deadline(report_path):
    """Honor a saved Retry-After before reading credentials or creating a session."""
    if not report_path.exists():
        return None
    report = json.loads(report_path.read_text(encoding="utf-8-sig"))
    if not isinstance(report, dict) or not isinstance(report.get("records", []), list):
        raise ValueError("invalid_verification_report")
    checked_at = _utc_timestamp(report.get("checked_at"))
    deadlines = []
    for row in report.get("records", []):
        if not isinstance(row, dict):
            raise ValueError("invalid_verification_record")
        details = row.get("response_details")
        if details is None:
            continue  # Older reports may have no response metadata.
        if not isinstance(details, dict) or not isinstance(details.get("headers", {}), dict):
            raise ValueError("invalid_response_headers")
        headers = {name.lower(): value for name, value in details.get("headers", {}).items()}
        value = headers.get("retry-after")
        if value is None or value == "":
            continue
        value = str(value).strip()
        if re.fullmatch(r"[0-9]+", value):
            delay = int(value)
            if delay == 0:
                continue
            response_date = _utc_timestamp(headers.get("date"), http_date=True)
            anchors = [timestamp for timestamp in (response_date, checked_at) if timestamp is not None]
            if not anchors:
                raise ValueError("retry_after_anchor_missing")
            # The report is recorded after the response; do not shorten its wait
            # if the server's Date header is slightly older than checked_at.
            deadline = max(anchors) + timedelta(seconds=delay)
        else:
            deadline = _utc_timestamp(value, http_date=True)
            if deadline is None:
                raise ValueError("invalid_retry_after")
        deadlines.append(deadline)
    return max(deadlines) if deadlines else None


def latest_retry_deadline(*report_paths):
    """Keep the strongest saved wait while old and new report locations coexist."""
    deadlines = []
    for report_path in report_paths:
        deadline = previous_retry_deadline(report_path)
        if deadline is not None:
            deadlines.append(deadline)
    return max(deadlines) if deadlines else None
