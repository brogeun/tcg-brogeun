"""Read-only live verification: official API only, no Chrome or production writes."""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
import sys
import time
import requests
from cert_worker_api import read_psa_api
from cert_worker_cooldown import previous_retry_deadline, latest_retry_deadline


REPORT_PATH = Path(__file__).resolve().parents[1] / "unattended-api-validation.json"
STATE_REPORT_PATH = Path(os.environ.get("CERT_WORKER_STATE_DIR") or (Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "TCGHub" / "CertWorker")) / "unattended-api-validation.json"


def _diagnostic_text(value, token, limit=500):
    text = str(value)
    if token:
        text = text.replace(token, "[redacted]")
    # Never retain reflected request credentials, even under an allowed message key.
    if re.search(r"""\b(?:authorization|(?:set[-_ ]?)?cookie|password|secret|api[-_ ]?key|(?:(?:access|refresh)[-_ ]?)?token)\b["']?\s*[:=]""", text, re.I):
        return "[redacted sensitive diagnostic]"
    text = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]", text)
    text = re.sub(r"\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[redacted]", text)
    return text[:limit]


def _json_diagnostics(payload, token):
    fields = {}
    allowed = {"message", "servermessage", "error", "detail", "code", "status", "statuscode",
               "title", "description", "error_description", "reason", "isvalidrequest"}

    def visit(node, prefix="", depth=0):
        if depth > 2 or len(fields) >= 12:
            return
        if isinstance(node, list):
            for index, item in enumerate(node[:5]):
                visit(item, prefix + str(index) + ".", depth + 1)
        elif isinstance(node, dict):
            for key, value in node.items():
                name = key.lower()
                if name in ("error", "errors") and isinstance(value, (dict, list)):
                    visit(value, prefix + name + ".", depth + 1)
                elif name in allowed and isinstance(value, (str, int, bool)):
                    fields[prefix + name] = _diagnostic_text(value, token)
                if len(fields) >= 12:
                    break

    visit(payload)
    return fields


class VerificationSession(requests.Session):
    def __init__(self, token):
        super().__init__()
        self._token = token
        self.last_response_details = None

    def get(self, *args, **kwargs):
        self.last_response_details = None
        response = super().get(*args, **kwargs)
        details = {"status": response.status_code, "headers": {}, "body_bytes": len(response.content)}
        for name in ("Content-Type", "Retry-After", "Date", "Server", "Via", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset",
                     "CF-Ray", "X-Request-ID", "apim-request-id"):
            value = response.headers.get(name)
            if value is not None:
                details["headers"][name] = _diagnostic_text(value, self._token)
        content_type = response.headers.get("Content-Type", "").lower()
        if "json" in content_type:
            try:
                payload = response.json()
            except ValueError:
                details["json_parse_ok"] = False
            else:
                details["json_parse_ok"] = True
                details["json_root_type"] = type(payload).__name__
                details["diagnostic_fields"] = _json_diagnostics(payload, self._token)
                if isinstance(payload, dict) and isinstance(payload.get("PSACert"), dict):
                    item = payload["PSACert"]
                    details["population_fields"] = {
                        name: {"present": name in item, "is_null": item.get(name) is None}
                        for name in ("TotalPopulation", "PopulationHigher")}
        elif response.status_code != 200 and "html" in content_type:
            title = re.search(r"<title[^>]*>(.*?)</title>", response.text, re.I | re.S)
            if title:
                details["page_title"] = _diagnostic_text(title.group(1), self._token, 300)
        # Unstructured bodies are never written to logs or the verification report.
        self.last_response_details = details
        return response


def main():
    try:
        retry_at = latest_retry_deadline(STATE_REPORT_PATH, REPORT_PATH)
    except (OSError, UnicodeError, ValueError, TypeError, OverflowError):
        print("Saved PSA API verification report could not be read safely. No network request was made; previous report preserved.")
        return 4
    if retry_at is not None and datetime.now(timezone.utc) < retry_at:
        print("PSA API verification is waiting until " + retry_at.isoformat() + ". No network request was made; previous report preserved.")
        return 3
    token = os.environ.get("PSA_API_TOKEN", "").strip()
    if not token:
        print("PSA_API_TOKEN is not configured. No network request was made.")
        return 2
    rows = []
    with VerificationSession(token) as session:
        for cert in ("23483296", "24031556", "127270226"):
            try:
                answer = read_psa_api(session, {"provider": "psa", "cert_number": cert}, token)
            except requests.RequestException:
                answer = {"outcome": "temporary_error", "error_code": "source_network_error"}
            record = answer.get("record", {})
            row = {"cert_number": cert, "outcome": answer["outcome"],
                   "error": answer.get("error_code"), "subject": record.get("subject"),
                   "grade": record.get("grade_text"), "pop": record.get("pop_total"),
                   "higher": record.get("pop_higher"), "source_url": record.get("source_url")}
            row["response_details"] = session.last_response_details
            rows.append(row)
            print(json.dumps(row, ensure_ascii=True), flush=True)
            if answer["outcome"] != "success":
                break
            time.sleep(1)
    passed = len(rows) == 3 and all(row["outcome"] == "success" for row in rows)
    report = {"checked_at": datetime.now(timezone.utc).isoformat(), "passed": passed, "method": "official_psa_api", "human_assisted": False,
              "unattended_verified": passed, "production_writes": False, "records": rows}
    REPORT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
