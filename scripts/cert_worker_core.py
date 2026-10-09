"""Pure, dependency-free validation for the operator-owned certificate worker."""
import re
import math
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

PSA_LABELS = ("Cert Number", "Item Grade", "Label Type", "Reverse Cert/Barcode", "Year", "Brand/Title", "Subject", "Card Number", "Category", "Variety/Pedigree")
BLOCK_MARKERS = ("just a moment", "verify you are human", "checking your browser", "attention required", "access denied", "captcha", "security verification")


def retry_after_seconds(value):
    """Respect both delta-seconds and HTTP-date Retry-After formats."""
    text = str(value or "").strip()
    if text.isdigit():
        return int(text)
    try:
        deadline = parsedate_to_datetime(text)
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        return max(0, math.ceil((deadline - datetime.now(timezone.utc)).total_seconds()))
    except (ValueError, TypeError, OverflowError):
        return 0


def digits(value):
    value = str(value or "").strip()
    return value if re.fullmatch(r"[0-9]{6,20}", value) else None


def result(outcome, error_code=None, record=None, retry_after_seconds=None):
    data = {"outcome": outcome}
    if error_code:
        data["error_code"] = error_code
    if record is not None:
        data["record"] = record
    if retry_after_seconds is not None:
        data["retry_after_seconds"] = retry_after_seconds
    return data


def int_or_none(value):
    try:
        text = str(value).replace(",", "").strip()
        return int(text) if re.fullmatch(r"\d+", text) else None
    except (TypeError, ValueError):
        return None


def grade_value(text):
    text = str(text or "").strip()
    values = re.findall(r"(?<![\d.])(?:10|[1-9])(?:\.5|\.0)?(?![\d.])", text)
    if len(values) != 1:
        return None
    grade = float(values[0])
    return grade if 1 <= grade <= 10 else None


def extract_psa_fields(main_text):
    """Only Item Information, never related-sales cert numbers or the request URL."""
    text = str(main_text or "").replace("\r\n", "\n").replace("\xa0", " ")
    heading = re.search(r"\bItem Information\b", text, re.I)
    if not heading:
        return {}
    section = text[heading.end():]
    end = re.search(r"\b(?:Sales of Similar Items|Set Registry|Sales History|Additional Information)\b", section, re.I)
    if end:
        section = section[:end.start()]
    pattern = re.compile(r"(?<![A-Za-z])(" + "|".join(re.escape(x) for x in PSA_LABELS) + r")\s*:?\s*", re.I)
    matches = list(pattern.finditer(section))
    canonical = {x.lower(): x for x in PSA_LABELS}
    fields = {}
    for i, match in enumerate(matches):
        key = canonical[match.group(1).lower()]
        value = section[match.end():matches[i + 1].start() if i + 1 < len(matches) else len(section)].strip()
        # Duplicate identity labels mean the scope is ambiguous: do not certify.
        if key in fields:
            return {}
        fields[key] = re.sub(r"\s+", " ", value)
    return fields


def classify_psa(main_text, expected_cert, source_url, status=200, page_title=""):
    text = str(main_text or "")
    low = (str(page_title) + "\n" + text).lower()
    host = (urlparse(source_url).hostname or "").lower()
    if host not in ("www.psacard.com", "psacard.com"):
        return result("blocked", "unexpected_redirect", retry_after_seconds=1800)
    if status in (401, 403, 429) or any(x in low for x in BLOCK_MARKERS):
        return result("blocked", "source_access_restricted", retry_after_seconds=1800)
    if status >= 500 or "down for maintenance" in low:
        return result("temporary_error", "source_unavailable", retry_after_seconds=900)
    fields = extract_psa_fields(text)
    actual = digits(fields.get("Cert Number"))
    if not actual:
        # Only a clear not-found statement tied to the requested cert is accepted.
        missing = re.search(r"(?:certification|cert)\s*(?:number|#)?\s*" + re.escape(expected_cert) + r"\s*(?:was |is )?(?:not found|does not exist)", text, re.I)
        if missing:
            return result("not_found", "source_record_not_found")
        return result("parse_error", "missing_cert_identity")
    if actual != expected_cert:
        return result("parse_error", "cert_number_mismatch")
    grade = fields.get("Item Grade", "")
    if grade_value(grade) is None or not fields.get("Subject") or not fields.get("Brand/Title"):
        return result("parse_error", "incomplete_card_record")
    record = {
        "cert_number": actual, "grade_text": grade,
        "subject": fields["Subject"], "brand": fields["Brand/Title"],
        "year": fields.get("Year", ""), "card_number": fields.get("Card Number", ""),
        "variety": fields.get("Variety/Pedigree", ""), "label": fields.get("Label Type", ""),
        "source_url": source_url,
    }
    # Optional information; absence is unknown, never zero.
    for label, key in (("PSA Population", "pop_total"), ("PSA Pop Higher", "pop_higher")):
        m = re.search(re.escape(label) + r"\s+([\d,]+)\b", text, re.I)
        record[key] = int_or_none(m.group(1)) if m else None
    return result("success", record=record)


def classify_bgs(payload, expected_cert, source_url, status=200, content_type="application/json"):
    host = (urlparse(source_url).hostname or "").lower()
    if host not in ("www.beckett.com", "beckett.com"):
        return result("temporary_error", "maintenance_or_redirect", retry_after_seconds=1800)
    if status in (401, 403, 429):
        return result("blocked", "source_access_restricted", retry_after_seconds=1800)
    if "json" not in content_type.lower():
        return result("temporary_error", "unexpected_content_type", retry_after_seconds=900)
    if status >= 500:
        return result("temporary_error", "source_unavailable", retry_after_seconds=900)
    if not isinstance(payload, dict):
        return result("parse_error", "invalid_response_schema")
    message = str(payload.get("message", "")).strip().lower().rstrip(".")
    if status == 404 and message in ("no record found", "record not found", "no data found"):
        return result("not_found", "source_record_not_found")
    if status != 200:
        return result("temporary_error", "source_http_error", retry_after_seconds=900)
    # Keep leading zeroes. A numeric/mismatched item_id needs review, not guessing.
    actual = digits(payload.get("item_id"))
    if actual != expected_cert:
        return result("parse_error", "cert_number_mismatch" if actual else "missing_cert_identity")
    grade = str(payload.get("final_grade") or "").strip()
    if grade_value(grade) is None or not payload.get("player_name") or not payload.get("set_name"):
        return result("parse_error", "incomplete_card_record")
    record = {
        "cert_number": actual, "grade_text": grade,
        "subject": str(payload["player_name"]), "brand": str(payload["set_name"]),
        "year": str(payload.get("year") or ""), "card_number": str(payload.get("card_key") or ""),
        "variety": str(payload.get("variety") or ""), "label": str(payload.get("label") or ""),
        "subgrades": {key: payload.get(field) for key, field in (("centering", "center_grade"), ("corners", "corners_grade"), ("edges", "edges_grade"), ("surface", "surface_grade"), ("autograph", "autograph_grade"))},
        "pop_total": int_or_none(payload.get("pop_report")), "pop_higher": int_or_none(payload.get("pop_higher")),
        "source_url": source_url,
    }
    return result("success", record=record)


def validate_job(job):
    if not isinstance(job, dict) or job.get("provider") not in ("psa", "bgs") or not digits(job.get("cert_number")):
        return False
    if not all(isinstance(job.get(k), str) and job[k] for k in ("id", "lease_token", "lookup_url")):
        return False
    url = urlparse(job["lookup_url"])
    hosts = ("www.psacard.com", "psacard.com") if job["provider"] == "psa" else ("www.beckett.com", "beckett.com")
    return url.scheme == "https" and url.hostname in hosts and not url.username and not url.password
