"""
Backend tests for Tom Certo API.
Covers:
  1. Admin HTML Panel (/api/admin-ui, /api/admin)
  2. Admin API endpoints (stats, list/create/patch/clear-devices/delete tokens)
  3. Auth flow (validate/revalidate)
  4. Key Detection (/api/analyze-key) with synthetic sine wave WAV.
"""
import io
import sys
import json
import time
import wave
import uuid
import struct
import traceback
from typing import Any, Dict, Tuple

import numpy as np
import requests

BASE = "http://localhost:8001"
API = f"{BASE}/api"
ADMIN_KEY = "tomcerto-admin-2026"
ADMIN_HEADERS = {"X-Admin-Key": ADMIN_KEY}

PASSED = []
FAILED = []


def _log_pass(name: str, detail: str = ""):
    PASSED.append((name, detail))
    print(f"[PASS] {name} {('— ' + detail) if detail else ''}")


def _log_fail(name: str, detail: str):
    FAILED.append((name, detail))
    print(f"[FAIL] {name} — {detail}")


def _safe_json(resp) -> Dict[str, Any]:
    try:
        return resp.json()
    except Exception:
        return {"_raw": resp.text[:500]}


# ────────────────────────── 1. Admin HTML Panel ──────────────────────────
def test_admin_ui_html():
    for path in ["/admin-ui", "/admin"]:
        url = API + path
        try:
            r = requests.get(url, timeout=10)
            if r.status_code != 200:
                _log_fail(f"GET {path} status", f"expected 200, got {r.status_code}")
                continue
            ctype = r.headers.get("Content-Type", "")
            if "text/html" not in ctype:
                _log_fail(f"GET {path} content-type", f"expected text/html, got {ctype}")
                continue
            if "Tom Certo Admin" not in r.text:
                _log_fail(f"GET {path} body", "does not contain 'Tom Certo Admin'")
                continue
            _log_pass(f"GET {path}", f"200 HTML, contains 'Tom Certo Admin' ({len(r.text)} bytes)")
        except Exception as e:
            _log_fail(f"GET {path}", f"exception: {e}")


def test_admin_ui_no_auth_required():
    # Without X-Admin-Key header, should still return 200 HTML (page self-collects key via form)
    for path in ["/admin-ui", "/admin"]:
        try:
            r = requests.get(API + path, timeout=10)
            if r.status_code == 200 and "Tom Certo Admin" in r.text:
                _log_pass(f"{path} no-auth", "200 without X-Admin-Key")
            else:
                _log_fail(f"{path} no-auth", f"status={r.status_code}")
        except Exception as e:
            _log_fail(f"{path} no-auth", f"exception: {e}")


# ────────────────────────── 2. Admin API endpoints ──────────────────────
def test_admin_stats():
    r = requests.get(f"{API}/admin/stats", headers=ADMIN_HEADERS, timeout=10)
    if r.status_code != 200:
        _log_fail("GET /admin/stats", f"status={r.status_code} body={r.text[:200]}")
        return
    data = _safe_json(r)
    need = {"total", "active", "revoked"}
    if not need.issubset(data.keys()):
        _log_fail("GET /admin/stats keys", f"missing keys, got {list(data.keys())}")
        return
    _log_pass("GET /admin/stats", f"total={data['total']} active={data['active']} revoked={data['revoked']}")


def test_admin_stats_auth_required():
    # No key
    r = requests.get(f"{API}/admin/stats", timeout=10)
    if r.status_code != 401:
        _log_fail("GET /admin/stats no key", f"expected 401, got {r.status_code}")
    else:
        _log_pass("GET /admin/stats no key", "401 as expected")
    # Wrong key
    r = requests.get(f"{API}/admin/stats", headers={"X-Admin-Key": "wrong"}, timeout=10)
    if r.status_code != 401:
        _log_fail("GET /admin/stats wrong key", f"expected 401, got {r.status_code}")
    else:
        _log_pass("GET /admin/stats wrong key", "401 as expected")


def test_admin_tokens_list():
    r = requests.get(f"{API}/admin/tokens", headers=ADMIN_HEADERS, timeout=10)
    if r.status_code != 200:
        _log_fail("GET /admin/tokens", f"status={r.status_code}")
        return
    data = _safe_json(r)
    if not {"tokens", "total", "active"}.issubset(data.keys()):
        _log_fail("GET /admin/tokens keys", f"got {list(data.keys())}")
        return
    _log_pass("GET /admin/tokens", f"total={data['total']} active={data['active']}")

    # Auth check
    r2 = requests.get(f"{API}/admin/tokens", timeout=10)
    if r2.status_code == 401:
        _log_pass("GET /admin/tokens no key", "401 as expected")
    else:
        _log_fail("GET /admin/tokens no key", f"expected 401, got {r2.status_code}")


def test_admin_token_crud() -> str:
    """Create → patch → clear-devices → delete."""
    code = f"PYTEST-{uuid.uuid4().hex[:6].upper()}"
    payload = {"code": code, "customer_name": "Py Test", "device_limit": 2}
    r = requests.post(f"{API}/admin/tokens", json=payload, headers=ADMIN_HEADERS, timeout=10)
    if r.status_code != 200:
        _log_fail("POST /admin/tokens", f"status={r.status_code} body={r.text[:200]}")
        return ""
    data = _safe_json(r)
    token_id = data.get("token_id")
    if not token_id:
        _log_fail("POST /admin/tokens", f"no token_id: {data}")
        return ""
    _log_pass("POST /admin/tokens", f"created id={token_id} code={code}")

    # PATCH (revoke)
    r = requests.patch(f"{API}/admin/tokens/{token_id}", json={"active": False}, headers=ADMIN_HEADERS, timeout=10)
    if r.status_code == 200:
        _log_pass("PATCH /admin/tokens/{id}", "active=false ok")
    else:
        _log_fail("PATCH /admin/tokens/{id}", f"status={r.status_code} body={r.text[:200]}")

    # PATCH auth required
    r2 = requests.patch(f"{API}/admin/tokens/{token_id}", json={"active": True}, timeout=10)
    if r2.status_code == 401:
        _log_pass("PATCH /admin/tokens/{id} no key", "401 as expected")
    else:
        _log_fail("PATCH /admin/tokens/{id} no key", f"expected 401 got {r2.status_code}")

    # Clear devices
    r = requests.post(f"{API}/admin/tokens/{token_id}/clear-devices", headers=ADMIN_HEADERS, timeout=10)
    if r.status_code == 200:
        _log_pass("POST /admin/tokens/{id}/clear-devices", "ok")
    else:
        _log_fail("POST /admin/tokens/{id}/clear-devices", f"status={r.status_code}")

    # Clear devices auth
    r2 = requests.post(f"{API}/admin/tokens/{token_id}/clear-devices", timeout=10)
    if r2.status_code == 401:
        _log_pass("POST clear-devices no key", "401 as expected")
    else:
        _log_fail("POST clear-devices no key", f"expected 401 got {r2.status_code}")

    # DELETE
    r = requests.delete(f"{API}/admin/tokens/{token_id}", headers=ADMIN_HEADERS, timeout=10)
    if r.status_code == 200:
        _log_pass("DELETE /admin/tokens/{id}", "ok")
    else:
        _log_fail("DELETE /admin/tokens/{id}", f"status={r.status_code}")

    # DELETE auth
    r2 = requests.delete(f"{API}/admin/tokens/{token_id}", timeout=10)
    if r2.status_code == 401:
        _log_pass("DELETE /admin/tokens/{id} no key", "401 as expected")
    else:
        _log_fail("DELETE /admin/tokens/{id} no key", f"expected 401 got {r2.status_code}")

    return token_id


# ────────────────────────── 3. Auth flow ────────────────────────────────
def _ensure_test_token():
    r = requests.post(f"{API}/admin/seed-test-token", timeout=10)
    if r.status_code != 200:
        _log_fail("seed-test-token", f"status={r.status_code}")
        return False
    return True


def test_auth_validate_and_revalidate() -> None:
    if not _ensure_test_token():
        return

    device_id = "pytest-device-01"

    # Clear devices for TEST-DEV2026 to avoid device_limit issues across test runs.
    # Find token id first
    lst = requests.get(f"{API}/admin/tokens", headers=ADMIN_HEADERS, timeout=10).json()
    test_tok = next((t for t in lst["tokens"] if t["code"] == "TEST-DEV2026"), None)
    if test_tok:
        requests.post(f"{API}/admin/tokens/{test_tok['_id']}/clear-devices", headers=ADMIN_HEADERS, timeout=10)

    r = requests.post(f"{API}/auth/validate", json={"token": "TEST-DEV2026", "device_id": device_id}, timeout=10)
    if r.status_code != 200:
        _log_fail("POST /auth/validate (valid)", f"status={r.status_code} body={r.text[:200]}")
        return
    data = _safe_json(r)
    if not data.get("valid"):
        _log_fail("POST /auth/validate (valid)", f"valid!=true: {data}")
        return
    session = data.get("session")
    if not session:
        _log_fail("POST /auth/validate (valid)", f"no session in response: {data}")
        return
    _log_pass("POST /auth/validate", f"valid=true, session JWT received (len={len(session)})")

    # Revalidate
    r = requests.post(f"{API}/auth/revalidate", json={"session": session, "device_id": device_id}, timeout=10)
    data = _safe_json(r)
    if r.status_code == 200 and data.get("valid"):
        _log_pass("POST /auth/revalidate", "valid=true")
    else:
        _log_fail("POST /auth/revalidate", f"status={r.status_code} body={data}")

    # Invalid token
    r = requests.post(f"{API}/auth/validate", json={"token": "NOPE-XXXX", "device_id": device_id}, timeout=10)
    data = _safe_json(r)
    if r.status_code == 200 and data.get("valid") is False and data.get("reason") == "not_found":
        _log_pass("POST /auth/validate (invalid)", "valid=false reason=not_found")
    else:
        _log_fail("POST /auth/validate (invalid)", f"status={r.status_code} body={data}")


# ────────────────────────── 4. Key Detection ────────────────────────────
def _sine_wav_bytes(freq_hz: float = 440.0, dur_s: float = 6.0, sr: int = 16000) -> bytes:
    t = np.linspace(0, dur_s, int(sr * dur_s), endpoint=False)
    sig = 0.6 * np.sin(2 * np.pi * freq_hz * t)
    pcm = (sig * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def test_analyze_key_empty():
    r = requests.post(f"{API}/analyze-key", data=b"", headers={"Content-Type": "application/octet-stream"}, timeout=30)
    if r.status_code != 400:
        _log_fail("POST /analyze-key empty", f"expected 400, got {r.status_code} body={r.text[:200]}")
        return
    data = _safe_json(r)
    if data.get("error") == "audio_too_short" and data.get("success") is False:
        _log_pass("POST /analyze-key empty", "400 audio_too_short success:false")
    else:
        _log_fail("POST /analyze-key empty", f"missing error=audio_too_short: {data}")


def test_analyze_key_sine(device_id: str = "pytest-key-device-01"):
    # Reset accumulator first to keep session_clips deterministic for this device
    requests.post(f"{API}/analyze-key/reset", headers={"X-Device-Id": device_id}, timeout=10)

    wav = _sine_wav_bytes(440.0, 6.0, 16000)
    print(f"  [info] sending {len(wav)} bytes WAV (440Hz, 6s, 16kHz mono) dev={device_id}")
    try:
        r = requests.post(
            f"{API}/analyze-key",
            data=wav,
            headers={"Content-Type": "application/octet-stream", "X-Device-Id": device_id},
            timeout=180,
        )
    except Exception as e:
        _log_fail("POST /analyze-key sine", f"request exception: {e}")
        return

    if r.status_code != 200:
        _log_fail("POST /analyze-key sine", f"status={r.status_code} body={r.text[:600]}")
        return
    data = _safe_json(r)

    if not data.get("success"):
        _log_fail("POST /analyze-key sine", f"success!=true: {data}")
        return

    # ── Top-level schema ──
    required = [
        "duration_s", "notes_count", "phrases_count", "session_clips",
        "method", "tonic", "tonic_name", "quality", "key_name", "confidence",
        "top_candidates", "diag", "histogram", "method_version", "flags",
    ]
    missing = [k for k in required if k not in data]
    if missing:
        _log_fail("POST /analyze-key sine schema", f"missing keys: {missing}. got={list(data.keys())}")
        return

    # method must start with "krumhansl-aarden+session-accum"
    if not isinstance(data["method"], str) or not data["method"].startswith("krumhansl-aarden+session-accum"):
        _log_fail("POST /analyze-key sine method",
                  f"expected method starts with 'krumhansl-aarden+session-accum', got {data.get('method')!r}")
        return

    # method_version must be the v6 string
    if data["method_version"] != "krumhansl-aarden-axis-third-final-v6":
        _log_fail("POST /analyze-key sine method_version",
                  f"expected 'krumhansl-aarden-axis-third-final-v6', got {data.get('method_version')!r}")
        return

    # Types
    type_errs = []
    if not isinstance(data["duration_s"], (int, float)):
        type_errs.append(f"duration_s type {type(data['duration_s']).__name__}")
    if not (isinstance(data["duration_s"], (int, float)) and 5.5 <= float(data["duration_s"]) <= 6.5):
        type_errs.append(f"duration_s={data['duration_s']} (expected ~6.0)")
    for k in ("notes_count", "phrases_count", "session_clips"):
        if not isinstance(data[k], int):
            type_errs.append(f"{k} type {type(data[k]).__name__}")
    if not isinstance(data["tonic"], int) or not (0 <= data["tonic"] <= 11):
        type_errs.append(f"tonic={data['tonic']!r}")
    if not isinstance(data["tonic_name"], str):
        type_errs.append(f"tonic_name type {type(data['tonic_name']).__name__}")
    if data["quality"] not in ("major", "minor"):
        type_errs.append(f"quality={data['quality']!r}")
    if not isinstance(data["key_name"], str):
        type_errs.append(f"key_name type {type(data['key_name']).__name__}")
    if not isinstance(data["confidence"], (int, float)) or not (0.0 <= float(data["confidence"]) <= 1.0):
        type_errs.append(f"confidence={data['confidence']!r}")
    if not isinstance(data["flags"], list) or not all(isinstance(x, str) for x in data["flags"]):
        type_errs.append(f"flags not list[str]: {data['flags']!r}")
    if type_errs:
        _log_fail("POST /analyze-key sine types", "; ".join(type_errs))
        return

    # session_clips for fresh session must be 1
    if data["session_clips"] != 1:
        _log_fail("POST /analyze-key sine session_clips",
                  f"expected 1 after reset+single clip, got {data['session_clips']}")
        return

    # top_candidates: list of 5 dicts with NEW schema
    tc = data["top_candidates"]
    if not isinstance(tc, list) or len(tc) != 5:
        _log_fail("POST /analyze-key sine top_candidates len",
                  f"expected list of 5, got {type(tc).__name__} len={len(tc) if hasattr(tc, '__len__') else '?'}")
        return
    expected_tc_keys = {"key", "score", "correlation", "third_diff", "axis", "final_match"}
    for i, c in enumerate(tc):
        if not isinstance(c, dict):
            _log_fail("POST /analyze-key sine top_candidates type",
                      f"candidate[{i}] not a dict: {type(c).__name__}")
            return
        keys = set(c.keys())
        if not expected_tc_keys.issubset(keys):
            _log_fail("POST /analyze-key sine top_candidates schema",
                      f"candidate[{i}] missing keys {expected_tc_keys - keys}; got {sorted(keys)}")
            return
        # Forbid old schema keys to make sure update was applied
        forbidden = {"boost", "alignment", "ks", "cadence"}
        leaked = forbidden & keys
        if leaked:
            _log_fail("POST /analyze-key sine top_candidates legacy",
                      f"candidate[{i}] still has legacy keys {leaked}")
            return

    # diag schema
    diag = data["diag"]
    if not isinstance(diag, dict):
        _log_fail("POST /analyze-key sine diag", f"not a dict: {type(diag).__name__}")
        return
    expected_diag_keys = {
        "pcp_top5_pcs", "pcp_top5_weights", "top_correlation",
        "runner_correlation", "corr_margin", "score_margin",
        "last_note_pc", "last_note_name", "last_note_dur_ms",
    }
    diag_keys = set(diag.keys())
    if not expected_diag_keys.issubset(diag_keys):
        _log_fail("POST /analyze-key sine diag schema",
                  f"missing diag keys {expected_diag_keys - diag_keys}; got {sorted(diag_keys)}")
        return

    # histogram: 12 floats
    hist = data["histogram"]
    if not isinstance(hist, list) or len(hist) != 12 or not all(isinstance(x, (int, float)) for x in hist):
        _log_fail("POST /analyze-key sine histogram",
                  f"not list of 12 numbers: type={type(hist).__name__} len={len(hist) if hasattr(hist,'__len__') else '?'}")
        return

    _log_pass(
        "POST /analyze-key sine",
        f"key={data['key_name']} tonic={data['tonic']} q={data['quality']} "
        f"conf={data['confidence']:.3f} method={data['method']} "
        f"version={data['method_version']} candidates={len(tc)} "
        f"session_clips={data['session_clips']} duration_s={data['duration_s']}"
    )
    # Print diagnostics inline for visibility
    print(f"     top1={tc[0]}")
    print(f"     diag={diag}")


def test_analyze_key_reset_and_session_counter():
    """
    Verifies POST /analyze-key/reset returns {reset:True, device:<short>}
    and that subsequent /analyze-key for the same X-Device-Id starts at session_clips=1.
    """
    device_id = "test-reset-abc"
    # First call (without prior reset) — could be 1 or higher depending on prior runs.
    # Send a clip to establish a session for this device.
    wav = _sine_wav_bytes(440.0, 6.0, 16000)
    requests.post(
        f"{API}/analyze-key",
        data=wav,
        headers={"Content-Type": "application/octet-stream", "X-Device-Id": device_id},
        timeout=180,
    )

    # Now reset
    r = requests.post(f"{API}/analyze-key/reset", headers={"X-Device-Id": device_id}, timeout=10)
    if r.status_code != 200:
        _log_fail("POST /analyze-key/reset", f"status={r.status_code} body={r.text[:200]}")
        return
    data = _safe_json(r)
    if data.get("reset") is not True:
        _log_fail("POST /analyze-key/reset", f"reset!=true: {data}")
        return
    if "device" not in data:
        _log_fail("POST /analyze-key/reset", f"missing 'device' key: {data}")
        return
    # Backend logs/returns device truncated to 8 chars: device_id[:8] = "test-res"
    if data["device"] != device_id[:8]:
        _log_fail("POST /analyze-key/reset device echo",
                  f"expected '{device_id[:8]}', got {data['device']!r}")
        return
    _log_pass("POST /analyze-key/reset", f"reset=true device={data['device']}")

    # Now send another clip — session_clips MUST be 1 again
    r2 = requests.post(
        f"{API}/analyze-key",
        data=wav,
        headers={"Content-Type": "application/octet-stream", "X-Device-Id": device_id},
        timeout=180,
    )
    if r2.status_code != 200:
        _log_fail("POST /analyze-key after reset", f"status={r2.status_code} body={r2.text[:300]}")
        return
    d2 = _safe_json(r2)
    if d2.get("session_clips") != 1:
        _log_fail("POST /analyze-key after reset session_clips",
                  f"expected 1, got {d2.get('session_clips')}")
        return
    _log_pass("POST /analyze-key after reset", f"session_clips=1 (key={d2.get('key_name')})")

    # Send a 2nd clip — session_clips MUST become 2 (proves accumulator works)
    r3 = requests.post(
        f"{API}/analyze-key",
        data=wav,
        headers={"Content-Type": "application/octet-stream", "X-Device-Id": device_id},
        timeout=180,
    )
    d3 = _safe_json(r3)
    if r3.status_code == 200 and d3.get("session_clips") == 2:
        _log_pass("session accumulator increments", "session_clips 1→2 across consecutive clips")
    else:
        _log_fail("session accumulator increments",
                  f"expected session_clips=2, got status={r3.status_code} session_clips={d3.get('session_clips')}")


def test_no_duplicate_reset_handler():
    """
    Sanity-check at code level that /analyze-key/reset has only ONE handler.
    """
    try:
        with open("/app/backend/server.py", "r", encoding="utf-8") as f:
            src = f.read()
    except Exception as e:
        _log_fail("no_duplicate_reset_handler", f"could not read server.py: {e}")
        return
    count = src.count('"/analyze-key/reset"')
    if count == 1:
        _log_pass("no duplicate /analyze-key/reset handler", f"found exactly 1 occurrence in server.py")
    else:
        _log_fail("no duplicate /analyze-key/reset handler",
                  f"expected exactly 1 occurrence of '/analyze-key/reset' route, found {count}")


# ────────────────────────── Runner ─────────────────────────────────────
def main():
    print(f"=== Tom Certo Backend Tests @ {BASE} ===\n")

    print("\n--- 1. Admin HTML Panel ---")
    test_admin_ui_html()
    test_admin_ui_no_auth_required()

    print("\n--- 2. Admin API ---")
    test_admin_stats()
    test_admin_stats_auth_required()
    test_admin_tokens_list()
    test_admin_token_crud()

    print("\n--- 3. Auth flow ---")
    test_auth_validate_and_revalidate()

    print("\n--- 4. Key Detection ---")
    test_no_duplicate_reset_handler()
    test_analyze_key_empty()
    test_analyze_key_sine()
    test_analyze_key_reset_and_session_counter()

    print("\n=== RESULTS ===")
    print(f"PASSED: {len(PASSED)}")
    print(f"FAILED: {len(FAILED)}")
    if FAILED:
        print("\nFAILURES:")
        for name, detail in FAILED:
            print(f"  - {name}: {detail}")
        sys.exit(1)
    else:
        print("ALL GOOD")
        sys.exit(0)


if __name__ == "__main__":
    main()
