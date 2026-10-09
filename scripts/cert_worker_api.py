"""Official PSA API reader. No browser, cookies, or human challenge dependency."""
import re
from cert_worker_core import digits, grade_value, int_or_none, result, retry_after_seconds

API_BASE = "https://api.psacard.com/publicapi/cert/GetByCertNumber/"


def _grade(value):
    text = str(value or "").strip()
    if re.search(r"\bauth(?:entic)?\b|altered|trimmed|qualifier|\b(?:OC|ST|PD|OF|MK|MC)\b", text, re.I):
        return None
    return grade_value(text)


def classify_psa_api(payload, expected_cert, source_url, status=200,
                     content_type="application/json", retry_after=""):
    if not isinstance(expected_cert, str) or not re.fullmatch(r"[0-9]{6,12}", expected_cert):
        return result("parse_error", "invalid_cert_number")
    if source_url != API_BASE + expected_cert:
        return result("blocked", "unexpected_redirect", retry_after_seconds=1800)
    delay = retry_after_seconds(retry_after)
    if status in (401, 403):
        return result("blocked", "psa_api_authentication_required" if status == 401 else "psa_api_access_denied",
                      retry_after_seconds=max(1800, delay))
    if status == 429:
        return result("blocked", "psa_api_rate_limited", retry_after_seconds=max(1800, delay or 3600))
    if 300 <= status < 400:
        return result("blocked", "unexpected_redirect", retry_after_seconds=max(1800, delay))
    if status >= 500:
        return result("temporary_error", "psa_api_unavailable", retry_after_seconds=max(900, delay))
    if status != 200:
        return result("temporary_error", "psa_api_http_error", retry_after_seconds=max(900, delay))
    if "json" not in str(content_type).lower():
        return result("temporary_error", "unexpected_content_type", retry_after_seconds=max(900, delay))
    if not isinstance(payload, dict):
        return result("parse_error", "invalid_response_schema")
    valid = payload.get("IsValidRequest")
    message = str(payload.get("ServerMessage", "")).strip().lower().rstrip(".")
    item = payload.get("PSACert")
    if valid is True and message == "no data found" and item is None:
        return result("not_found", "source_record_not_found")
    if valid is False or (valid is not None and valid is not True) or not isinstance(item, dict):
        return result("parse_error", "invalid_response_schema")
    # The official schema defines CertNumber as a string. Never reconstruct lost zeroes.
    observed = digits(item.get("CertNumber")) if isinstance(item.get("CertNumber"), str) else None
    if observed != expected_cert:
        return result("parse_error", "cert_number_mismatch" if observed else "missing_cert_identity")
    description = str(item.get("GradeDescription") or "").strip()
    card_grade = str(item.get("CardGrade") or "").strip()
    grade_text = description or card_grade
    grade = _grade(grade_text)
    if grade is None or (card_grade and _grade(card_grade) != grade):
        return result("parse_error", "unsupported_grade")
    if not all(isinstance(item.get(field), str) and item[field].strip()
               for field in ("Subject", "Brand", "CardNumber")):
        return result("parse_error", "incomplete_card_record")
    # Do not complete an unattended card+POP lookup when the account cannot supply POP.
    population = int_or_none(item.get("TotalPopulation"))
    higher = int_or_none(item.get("PopulationHigher"))
    if population is None or higher is None:
        return result("temporary_error", "psa_api_population_unavailable", retry_after_seconds=900)
    return result("success", record={
        "cert_number": observed, "grade_text": grade_text,
        "subject": item["Subject"].strip(), "brand": item["Brand"].strip(),
        "year": str(item.get("Year") or ""), "card_number": item["CardNumber"].strip(),
        "variety": str(item.get("Variety") or ""), "label": str(item.get("LabelType") or ""),
        "pop_total": population, "pop_higher": higher, "source_url": source_url,
    })


def read_psa_api(session, job, token):
    token = str(token or "").strip()
    if not token:
        return result("blocked", "psa_api_token_missing", retry_after_seconds=1800)
    cert = job.get("cert_number") if isinstance(job, dict) else None
    if not isinstance(cert, str) or not re.fullmatch(r"[0-9]{6,12}", cert):
        return result("parse_error", "invalid_cert_number")
    url = API_BASE + cert
    # This session belongs only to PSA. No redirects or cookies from personal browsers.
    response = session.get(url, headers={"Authorization": "Bearer " + token,
                                        "Accept": "application/json"},
                           allow_redirects=False, timeout=(5, 25))
    content_type = response.headers.get("Content-Type", "")
    payload = None
    if "json" in content_type.lower():
        try:
            payload = response.json()
        except ValueError:
            pass
    return classify_psa_api(payload, cert, response.url, response.status_code,
                            content_type, response.headers.get("Retry-After", ""))
