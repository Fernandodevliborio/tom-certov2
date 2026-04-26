"""
Backend tests for Tom Certo Admin Token Panel v4.2.

Covers the 12 mandatory sections from the review request:
  1. Security on POST /api/admin/tokens
  2. Auto-generated token code (TC-XXXX-XXXX)
  3. Flexible duration (minutes/hours/days/months/years/forever)
  4. Manual custom code + duplicate 409
  5. GET /api/admin/tokens listing
  6. PATCH /api/admin/tokens/{id}
  7. POST /api/admin/tokens/{id}/clear-devices
  8. DELETE /api/admin/tokens/{id}
  9. Expired token blocks /auth/validate
 10. HTML panel (/api/admin, /api/admin-ui, /api/admin-logo)
 11. Auth regression (TEST-DEV2026 validate/revalidate)
 12. /api/analyze-key regression (6s 440Hz mono 16kHz WAV)

All tokens created during the run are deleted at the end.
"""
import io
import re
import sys
import time
import uuid
import wave
import struct
import traceback
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import numpy as np
import requests

BASE = "http://localhost:8001"
API = f"{BASE}/api"
ADMIN_KEY = "tomcerto-admin-2026"
ADMIN_HEADERS = {"X-Admin-Key": ADMIN_KEY}
TEST_DEV_TOKEN = "TEST-DEV2026"

CODE_REGEX = re.compile(r"^TC-[0-9A-F]{4}-[0-9A-F]{4}$")

PASSED: list = []
FAILED: list = []
CREATED_TOKEN_IDS: list = []


def log_pass(name: str, detail: str = ""):
    PASSED.append((name, detail))
    print(f"[PASS] {name} — {detail}" if detail else f"[PASS] {name}")


def log_fail(name: str, detail: str):
    FAILED.append((name, detail))
    print(f"[FAIL] {name} — {detail}")


def _safe_json(resp) -> Dict[str, Any]:
    try:
        return resp.json()
    except Exception:
        return {"_raw": resp.text[:500]}


def _cleanup_token(token_id: str):
    try:
        requests.delete(f"{API}/admin/tokens/{token_id}", headers=ADMIN_HEADERS, timeout=10)
    except Exception:
        pass


# ─────────── 1. Security on POST /api/admin/tokens ───────────
def test_post_security():
    body = {"customer_name": "Sec Probe"}

    # No header
    r = requests.post(f"{API}/admin/tokens", json=body, timeout=10)
    if r.status_code == 401:
        log_pass("1.security.no_header_401")
    else:
        log_fail("1.security.no_header_401", f"got {r.status_code}: {_safe_json(r)}")

    # Wrong header
    r = requests.post(
        f"{API}/admin/tokens",
        json=body,
        headers={"X-Admin-Key": "wrong-key-xyz"},
        timeout=10,
    )
    if r.status_code == 401:
        log_pass("1.security.wrong_header_401")
    else:
        log_fail("1.security.wrong_header_401", f"got {r.status_code}: {_safe_json(r)}")

    # Correct header
    r = requests.post(
        f"{API}/admin/tokens",
        json={"customer_name": "Sec OK Probe"},
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r.status_code == 200:
        data = _safe_json(r)
        tid = data.get("token_id")
        if tid:
            CREATED_TOKEN_IDS.append(tid)
        log_pass("1.security.correct_header_200", f"token_id={tid}")
    else:
        log_fail("1.security.correct_header_200", f"got {r.status_code}: {_safe_json(r)}")


# ─────────── 2. Auto-generated code TC-XXXX-XXXX ───────────
def test_auto_code():
    r = requests.post(
        f"{API}/admin/tokens",
        json={"customer_name": "Auto Test"},
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("2.auto_code.status_200", f"got {r.status_code}: {_safe_json(r)}")
        return
    data = _safe_json(r)
    tid = data.get("token_id")
    if tid:
        CREATED_TOKEN_IDS.append(tid)

    required = ["ok", "token_id", "code", "customer_name", "expires_at", "duration_minutes"]
    missing = [k for k in required if k not in data]
    if missing:
        log_fail("2.auto_code.fields", f"missing keys: {missing}, got {data}")
        return

    code = data.get("code", "")
    if not CODE_REGEX.match(code):
        log_fail("2.auto_code.regex", f"code='{code}' does not match {CODE_REGEX.pattern}")
        return

    if data.get("ok") is not True:
        log_fail("2.auto_code.ok_true", f"ok={data.get('ok')}")
        return
    if data.get("customer_name") != "Auto Test":
        log_fail("2.auto_code.customer_name", f"got {data.get('customer_name')!r}")
        return
    if data.get("expires_at") is not None:
        log_fail("2.auto_code.expires_at_null", f"got {data.get('expires_at')!r}")
        return
    if data.get("duration_minutes") is not None:
        log_fail("2.auto_code.duration_minutes_null", f"got {data.get('duration_minutes')!r}")
        return

    log_pass("2.auto_code.full", f"code={code} token_id={tid}")


# ─────────── 3. Flexible duration ───────────
def _parse_iso(s: str) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def test_durations():
    cases = [
        ("T1", {"customer_name": "T1", "duration_value": 5, "duration_unit": "minutes"}, 5),
        ("T2", {"customer_name": "T2", "duration_value": 2, "duration_unit": "hours"}, 120),
        ("T3", {"customer_name": "T3", "duration_value": 30, "duration_unit": "days"}, 43200),
        ("T4", {"customer_name": "T4", "duration_value": 6, "duration_unit": "months"}, 259200),
        ("T5", {"customer_name": "T5", "duration_value": 1, "duration_unit": "years"}, 525600),
        ("T6", {"customer_name": "T6", "duration_unit": "forever"}, None),
    ]
    for label, body, expected_minutes in cases:
        sent_at = datetime.now(timezone.utc)
        r = requests.post(f"{API}/admin/tokens", json=body, headers=ADMIN_HEADERS, timeout=10)
        if r.status_code != 200:
            log_fail(f"3.duration.{label}.status", f"got {r.status_code}: {_safe_json(r)}")
            continue
        data = _safe_json(r)
        tid = data.get("token_id")
        if tid:
            CREATED_TOKEN_IDS.append(tid)

        got = data.get("duration_minutes")
        if got != expected_minutes:
            log_fail(
                f"3.duration.{label}.duration_minutes",
                f"expected {expected_minutes}, got {got}",
            )
            continue

        if expected_minutes is None:
            if data.get("expires_at") is not None:
                log_fail(f"3.duration.{label}.expires_at_null", f"got {data.get('expires_at')!r}")
                continue
            log_pass(f"3.duration.{label}", f"forever — duration_minutes=None, expires_at=None")
        else:
            exp_str = data.get("expires_at")
            exp_dt = _parse_iso(exp_str)
            if not exp_dt:
                log_fail(f"3.duration.{label}.expires_at_iso", f"unparseable: {exp_str!r}")
                continue
            expected_dt = sent_at + (datetime.fromtimestamp(0, timezone.utc) - datetime.fromtimestamp(0, timezone.utc))
            # delta in seconds
            delta_s = abs((exp_dt - sent_at).total_seconds() - expected_minutes * 60)
            if delta_s > 5:
                log_fail(
                    f"3.duration.{label}.expires_at_match",
                    f"expected ~{expected_minutes*60}s from sent_at, got {delta_s:.2f}s off",
                )
                continue
            log_pass(
                f"3.duration.{label}",
                f"duration_minutes={got}, expires_at={exp_str} (Δ={delta_s:.2f}s)",
            )


# ─────────── 4. Manual code + duplicate ───────────
def test_manual_code():
    custom = "MEU-TESTE-001"
    r = requests.post(
        f"{API}/admin/tokens",
        json={"code": custom, "customer_name": "Pedro"},
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("4.manual.create.status", f"got {r.status_code}: {_safe_json(r)}")
        return
    data = _safe_json(r)
    tid = data.get("token_id")
    if tid:
        CREATED_TOKEN_IDS.append(tid)
    if data.get("code") != custom:
        log_fail("4.manual.create.code_preserved", f"expected '{custom}', got {data.get('code')!r}")
    else:
        log_pass("4.manual.create.code_preserved", f"code={data.get('code')}")
    if data.get("customer_name") != "Pedro":
        log_fail("4.manual.create.customer_name", f"got {data.get('customer_name')!r}")
    else:
        log_pass("4.manual.create.customer_name")

    # Duplicate
    r2 = requests.post(
        f"{API}/admin/tokens",
        json={"code": custom, "customer_name": "Outro"},
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r2.status_code == 409:
        log_pass("4.manual.duplicate.409")
    else:
        log_fail("4.manual.duplicate.409", f"got {r2.status_code}: {_safe_json(r2)}")


# ─────────── 5. GET /api/admin/tokens ───────────
def test_list_tokens():
    r = requests.get(f"{API}/admin/tokens", headers=ADMIN_HEADERS, timeout=10)
    if r.status_code != 200:
        log_fail("5.list.status_200", f"got {r.status_code}: {_safe_json(r)}")
        return
    data = _safe_json(r)
    if not isinstance(data, dict) or "tokens" not in data or "total" not in data or "active" not in data:
        log_fail("5.list.shape", f"missing keys, got {list(data.keys()) if isinstance(data, dict) else type(data)}")
        return
    tokens = data["tokens"]
    if not isinstance(tokens, list):
        log_fail("5.list.tokens_is_list", f"got {type(tokens)}")
        return
    log_pass("5.list.shape", f"total={data['total']} active={data['active']} len={len(tokens)}")

    if not tokens:
        log_fail("5.list.token_fields", "tokens list empty, cannot verify fields")
        return

    required_fields = [
        "_id", "code", "customer_name", "device_limit",
        "active_devices", "active", "created_at", "expires_at", "duration_minutes",
    ]
    sample = tokens[0]
    missing = [k for k in required_fields if k not in sample]
    if missing:
        log_fail("5.list.token_fields", f"sample missing: {missing}, got keys={list(sample.keys())}")
    else:
        log_pass("5.list.token_fields", f"sample code={sample.get('code')}")


# ─────────── 6. PATCH /api/admin/tokens/{id} ───────────
def test_patch_token():
    r = requests.post(
        f"{API}/admin/tokens",
        json={"customer_name": "PATCH Original", "device_limit": 3},
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("6.patch.setup.create", f"got {r.status_code}: {_safe_json(r)}")
        return
    tid = _safe_json(r).get("token_id")
    CREATED_TOKEN_IDS.append(tid)

    # Update name + device_limit + notes
    r = requests.patch(
        f"{API}/admin/tokens/{tid}",
        json={"customer_name": "PATCH Updated", "device_limit": 7, "notes": "edited via test"},
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("6.patch.update_fields.status", f"got {r.status_code}: {_safe_json(r)}")
        return
    log_pass("6.patch.update_fields.status_200")

    # Verify via GET
    r = requests.get(f"{API}/admin/tokens", headers=ADMIN_HEADERS, timeout=10)
    tokens = _safe_json(r).get("tokens", [])
    target = next((t for t in tokens if t["_id"] == tid), None)
    if not target:
        log_fail("6.patch.verify.lookup", f"token {tid} not found in list")
        return
    if (target.get("customer_name") == "PATCH Updated"
            and target.get("device_limit") == 7
            and target.get("notes") == "edited via test"):
        log_pass("6.patch.verify.persisted")
    else:
        log_fail(
            "6.patch.verify.persisted",
            f"got customer_name={target.get('customer_name')}, device_limit={target.get('device_limit')}, notes={target.get('notes')}",
        )

    # active=False (revoke)
    r = requests.patch(
        f"{API}/admin/tokens/{tid}",
        json={"active": False},
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("6.patch.revoke.status", f"got {r.status_code}: {_safe_json(r)}")
    else:
        r = requests.get(f"{API}/admin/tokens", headers=ADMIN_HEADERS, timeout=10)
        target = next((t for t in _safe_json(r).get("tokens", []) if t["_id"] == tid), None)
        if target and target.get("active") is False:
            log_pass("6.patch.revoke.persisted")
        else:
            log_fail("6.patch.revoke.persisted", f"active={target.get('active') if target else 'missing'}")

    # active=True (reactivate)
    r = requests.patch(
        f"{API}/admin/tokens/{tid}",
        json={"active": True},
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("6.patch.reactivate.status", f"got {r.status_code}: {_safe_json(r)}")
    else:
        r = requests.get(f"{API}/admin/tokens", headers=ADMIN_HEADERS, timeout=10)
        target = next((t for t in _safe_json(r).get("tokens", []) if t["_id"] == tid), None)
        if target and target.get("active") is True:
            log_pass("6.patch.reactivate.persisted")
        else:
            log_fail("6.patch.reactivate.persisted", f"active={target.get('active') if target else 'missing'}")


# ─────────── 7. clear-devices ───────────
def test_clear_devices():
    # Create a token and add a device via /auth/validate
    r = requests.post(
        f"{API}/admin/tokens",
        json={"customer_name": "Clear Devices Test", "device_limit": 5},
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("7.clear.setup.create", f"got {r.status_code}: {_safe_json(r)}")
        return
    data = _safe_json(r)
    tid = data["token_id"]
    code = data["code"]
    CREATED_TOKEN_IDS.append(tid)

    # Validate to add a device
    requests.post(
        f"{API}/auth/validate",
        json={"token": code, "device_id": f"dev-{uuid.uuid4().hex[:8]}"},
        timeout=10,
    )

    r = requests.post(
        f"{API}/admin/tokens/{tid}/clear-devices",
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("7.clear.status", f"got {r.status_code}: {_safe_json(r)}")
        return

    r = requests.get(f"{API}/admin/tokens", headers=ADMIN_HEADERS, timeout=10)
    target = next((t for t in _safe_json(r).get("tokens", []) if t["_id"] == tid), None)
    if target and target.get("active_devices") == []:
        log_pass("7.clear.devices_empty")
    else:
        log_fail(
            "7.clear.devices_empty",
            f"active_devices={target.get('active_devices') if target else 'missing'}",
        )


# ─────────── 8. DELETE ───────────
def test_delete_token():
    r = requests.post(
        f"{API}/admin/tokens",
        json={"customer_name": "Delete Me"},
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("8.delete.setup", f"got {r.status_code}: {_safe_json(r)}")
        return
    tid = _safe_json(r)["token_id"]

    r = requests.delete(f"{API}/admin/tokens/{tid}", headers=ADMIN_HEADERS, timeout=10)
    if r.status_code != 200:
        log_fail("8.delete.status_200", f"got {r.status_code}: {_safe_json(r)}")
        return
    log_pass("8.delete.status_200")

    r = requests.get(f"{API}/admin/tokens", headers=ADMIN_HEADERS, timeout=10)
    found = any(t["_id"] == tid for t in _safe_json(r).get("tokens", []))
    if found:
        log_fail("8.delete.gone", "token still appears in listing")
    else:
        log_pass("8.delete.gone")


# ─────────── 9. Expired token blocks /auth/validate ───────────
def test_expired_token_blocks_validate():
    r = requests.post(
        f"{API}/admin/tokens",
        json={"customer_name": "Expiry Test", "duration_value": 1, "duration_unit": "minutes"},
        headers=ADMIN_HEADERS,
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("9.expired.setup", f"got {r.status_code}: {_safe_json(r)}")
        return
    data = _safe_json(r)
    tid = data["token_id"]
    code = data["code"]
    CREATED_TOKEN_IDS.append(tid)

    device = f"exp-dev-{uuid.uuid4().hex[:8]}"

    # First validate — should pass (valid:true)
    r = requests.post(
        f"{API}/auth/validate",
        json={"token": code, "device_id": device},
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("9.expired.first_validate.status", f"got {r.status_code}: {_safe_json(r)}")
        return
    body = _safe_json(r)
    if body.get("valid") is not True:
        log_fail("9.expired.first_validate.valid_true", f"got {body}")
        return
    log_pass("9.expired.first_validate.valid_true")

    # Wait 65s
    print("    [9] sleeping 65s for token to expire ...")
    time.sleep(65)

    # Second validate — should be valid:false reason=expired
    r = requests.post(
        f"{API}/auth/validate",
        json={"token": code, "device_id": device},
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("9.expired.second_validate.status", f"got {r.status_code}: {_safe_json(r)}")
        return
    body = _safe_json(r)
    if body.get("valid") is False and body.get("reason") == "expired":
        log_pass("9.expired.second_validate.expired", f"body={body}")
    else:
        log_fail("9.expired.second_validate.expired", f"got {body}")


# ─────────── 10. HTML panel ───────────
def test_html_panel():
    # /api/admin
    r = requests.get(f"{API}/admin", timeout=10)
    if r.status_code == 200 and "Tom Certo" in r.text and "Admin" in r.text:
        log_pass("10.html.admin", f"len={len(r.text)}")
    else:
        log_fail(
            "10.html.admin",
            f"status={r.status_code}, contains_tom_certo_admin={'Tom Certo' in r.text and 'Admin' in r.text}",
        )

    # /api/admin-ui (alias)
    r = requests.get(f"{API}/admin-ui", timeout=10)
    if r.status_code == 200:
        log_pass("10.html.admin_ui_alias")
    else:
        log_fail("10.html.admin_ui_alias", f"status={r.status_code}")

    # /api/admin-logo
    r = requests.get(f"{API}/admin-logo", timeout=10)
    ct = r.headers.get("content-type", "")
    if r.status_code == 200 and ct.startswith("image/"):
        log_pass("10.html.admin_logo", f"content-type={ct}")
    else:
        log_fail("10.html.admin_logo", f"status={r.status_code} content-type={ct}")


# ─────────── 11. Auth regression (TEST-DEV2026) ───────────
def test_auth_regression():
    device = f"regr-dev-{uuid.uuid4().hex[:8]}"
    r = requests.post(
        f"{API}/auth/validate",
        json={"token": TEST_DEV_TOKEN, "device_id": device},
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("11.auth.validate.status", f"got {r.status_code}: {_safe_json(r)}")
        return
    body = _safe_json(r)
    if body.get("valid") is not True:
        log_fail("11.auth.validate.valid_true", f"got {body}")
        return
    session = body.get("session")
    if not session or not isinstance(session, str):
        log_fail("11.auth.validate.session_jwt", f"session={session!r}")
        return
    if "customer_name" not in body:
        log_fail("11.auth.validate.customer_name_present", f"keys={list(body.keys())}")
        return
    log_pass("11.auth.validate", f"customer_name={body.get('customer_name')!r} session_len={len(session)}")

    r = requests.post(
        f"{API}/auth/revalidate",
        json={"session": session, "device_id": device},
        timeout=10,
    )
    if r.status_code != 200:
        log_fail("11.auth.revalidate.status", f"got {r.status_code}: {_safe_json(r)}")
        return
    body = _safe_json(r)
    if body.get("valid") is True:
        log_pass("11.auth.revalidate.valid_true", f"customer_name={body.get('customer_name')!r}")
    else:
        log_fail("11.auth.revalidate.valid_true", f"got {body}")


# ─────────── 12. /api/analyze-key regression ───────────
def _make_sine_wav(freq=440.0, dur_s=6.0, sr=16000) -> bytes:
    n = int(dur_s * sr)
    t = np.arange(n) / sr
    sig = (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    pcm16 = (sig * 32767).clip(-32768, 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm16)
    return buf.getvalue()


def test_analyze_key():
    wav = _make_sine_wav()
    r = requests.post(
        f"{API}/analyze-key",
        data=wav,
        headers={"Content-Type": "audio/wav", "X-Device-Id": f"v42-test-{uuid.uuid4().hex[:8]}"},
        timeout=120,
    )
    if r.status_code != 200:
        log_fail("12.analyze_key.status_200", f"got {r.status_code}: {_safe_json(r)}")
        return
    body = _safe_json(r)
    required = ["key_name", "tonic", "quality", "confidence", "top_candidates"]
    missing = [k for k in required if k not in body]
    if missing:
        log_fail("12.analyze_key.fields", f"missing: {missing}, got keys={list(body.keys())}")
        return
    if not isinstance(body["top_candidates"], list) or len(body["top_candidates"]) == 0:
        log_fail("12.analyze_key.top_candidates", f"got {body['top_candidates']}")
        return
    log_pass(
        "12.analyze_key",
        f"key={body.get('key_name')} tonic={body.get('tonic')} quality={body.get('quality')} conf={body.get('confidence')}",
    )


# ─────────── Main ───────────
def main():
    print(f"=== Tom Certo v4.2 Backend Tests against {API} ===\n")

    sections = [
        ("1. POST security", test_post_security),
        ("2. Auto-generated code", test_auto_code),
        ("3. Flexible duration", test_durations),
        ("4. Manual code + duplicate", test_manual_code),
        ("5. GET listing", test_list_tokens),
        ("6. PATCH", test_patch_token),
        ("7. clear-devices", test_clear_devices),
        ("8. DELETE", test_delete_token),
        ("10. HTML panel", test_html_panel),
        ("11. Auth regression", test_auth_regression),
        ("12. analyze-key regression", test_analyze_key),
        ("9. Expired token (60s wait)", test_expired_token_blocks_validate),
    ]
    for label, fn in sections:
        print(f"\n--- {label} ---")
        try:
            fn()
        except Exception as e:
            log_fail(label, f"unexpected exception: {e}\n{traceback.format_exc()}")

    # Cleanup
    print(f"\n--- Cleanup: deleting {len(CREATED_TOKEN_IDS)} created tokens ---")
    for tid in CREATED_TOKEN_IDS:
        if tid:
            _cleanup_token(tid)

    # Summary
    print(f"\n=== Summary ===")
    print(f"PASS: {len(PASSED)}")
    print(f"FAIL: {len(FAILED)}")
    if FAILED:
        print("\nFailures:")
        for n, d in FAILED:
            print(f"  - {n}: {d}")
    sys.exit(0 if not FAILED else 1)


if __name__ == "__main__":
    main()
