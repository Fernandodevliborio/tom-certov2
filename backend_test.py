#!/usr/bin/env python3
"""Tom Certo — Admin Auth (Username/Password + JWT) backend validation."""
import time
import requests
import sys

BASE = "http://localhost:8001/api"

ADMIN_USERNAME = "Admin01"
ADMIN_PASSWORD = "adminfernando"
LEGACY_KEY = "tomcerto-admin-2026"

passed = 0
failed = 0
failures = []

def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  · {label}")
    else:
        failed += 1
        failures.append(f"{label} — {detail}")
        print(f"  FAIL  · {label}  | {detail}")

def section(t):
    print(f"\n=== {t} ===")

# ---------------- 1: Login OK ----------------
section("1) POST /admin/login (correct credentials)")
r = requests.post(f"{BASE}/admin/login",
                  json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
                  timeout=30)
check("status 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
jwt_token = None
try:
    body = r.json()
    check("ok=true", body.get("ok") is True, f"body={body}")
    jwt_token = body.get("token")
    check("token present", isinstance(jwt_token, str) and len(jwt_token) > 20, f"token={jwt_token!r}")
    check("token is JWT (3 parts split by '.')",
          isinstance(jwt_token, str) and len(jwt_token.split(".")) == 3,
          f"token parts={len(jwt_token.split('.')) if isinstance(jwt_token, str) else 'NA'}")
    check("username='Admin01'", body.get("username") == "Admin01", f"got {body.get('username')!r}")
    check("expires_in_hours==168", body.get("expires_in_hours") == 168,
          f"got {body.get('expires_in_hours')!r}")
except Exception as e:
    check("response is JSON", False, str(e))

# ---------------- 2: Login wrong password ----------------
section("2) POST /admin/login (wrong password — anti-brute-force delay)")
t0 = time.monotonic()
r = requests.post(f"{BASE}/admin/login",
                  json={"username": ADMIN_USERNAME, "password": "errada"},
                  timeout=30)
elapsed = time.monotonic() - t0
check("status 401", r.status_code == 401, f"got {r.status_code} body={r.text[:200]}")
try:
    detail = r.json().get("detail")
except Exception:
    detail = None
check("detail='Usuário ou senha inválidos'", detail == "Usuário ou senha inválidos", f"got {detail!r}")
check("delay >= 0.3s (anti-brute-force)", elapsed >= 0.3, f"elapsed={elapsed:.3f}s")

# ---------------- 3: Login wrong username ----------------
section("3) POST /admin/login (wrong username)")
r = requests.post(f"{BASE}/admin/login",
                  json={"username": "hacker", "password": ADMIN_PASSWORD},
                  timeout=30)
check("status 401", r.status_code == 401, f"got {r.status_code}")

# ---------------- 4: GET /admin/me with Bearer ----------------
section("4) GET /admin/me with Bearer token")
if jwt_token:
    r = requests.get(f"{BASE}/admin/me",
                     headers={"Authorization": f"Bearer {jwt_token}"},
                     timeout=30)
    check("status 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    try:
        body = r.json()
        check("username=='Admin01'", body.get("username") == "Admin01", f"got {body.get('username')!r}")
        check("role=='admin'", body.get("role") == "admin", f"got {body.get('role')!r}")
    except Exception as e:
        check("response is JSON", False, str(e))
else:
    check("no jwt to test", False, "step 1 failed")

# ---------------- 5: GET /admin/me without token ----------------
section("5) GET /admin/me without auth")
r = requests.get(f"{BASE}/admin/me", timeout=30)
check("status 401", r.status_code == 401, f"got {r.status_code} body={r.text[:200]}")

# ---------------- 6: GET /admin/stats with Bearer token ----------------
section("6) GET /admin/stats with Bearer token")
if jwt_token:
    r = requests.get(f"{BASE}/admin/stats",
                     headers={"Authorization": f"Bearer {jwt_token}"},
                     timeout=30)
    check("status 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
    try:
        body = r.json()
        check("body has 'total'", "total" in body, f"keys={list(body.keys())}")
        check("body has 'active'", "active" in body, f"keys={list(body.keys())}")
        check("body has 'revoked'", "revoked" in body, f"keys={list(body.keys())}")
    except Exception as e:
        check("response is JSON", False, str(e))

# ---------------- 7: GET /admin/stats with X-Admin-Key (legacy) ----------------
section("7) GET /admin/stats with X-Admin-Key (LEGACY)")
r = requests.get(f"{BASE}/admin/stats",
                 headers={"X-Admin-Key": LEGACY_KEY},
                 timeout=30)
check("status 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
try:
    body = r.json()
    check("body has total/active/revoked",
          all(k in body for k in ("total", "active", "revoked")),
          f"keys={list(body.keys())}")
except Exception as e:
    check("response is JSON", False, str(e))

# ---------------- 8: GET /admin/stats without auth ----------------
section("8) GET /admin/stats without any auth")
r = requests.get(f"{BASE}/admin/stats", timeout=30)
check("status 401", r.status_code == 401, f"got {r.status_code} body={r.text[:200]}")

# ---------------- 9: GET /admin/stats with invalid Bearer ----------------
section("9) GET /admin/stats with INVALID Bearer token")
r = requests.get(f"{BASE}/admin/stats",
                 headers={"Authorization": "Bearer xyz.abc.def"},
                 timeout=30)
check("status 401", r.status_code == 401, f"got {r.status_code} body={r.text[:200]}")

# ---------------- 10: GET /admin (HTML panel) ----------------
section("10) GET /admin (HTML panel public)")
r = requests.get(f"{BASE}/admin", timeout=30)
check("status 200", r.status_code == 200, f"got {r.status_code}")
ctype = r.headers.get("content-type", "")
check("Content-Type is text/html", "text/html" in ctype, f"got {ctype!r}")

# ---------------- 11: GET /health ----------------
section("11) GET /health")
r = requests.get(f"{BASE}/health", timeout=30)
check("status 200", r.status_code == 200, f"got {r.status_code} body={r.text[:200]}")
try:
    body = r.json()
    check("status=='ok'", body.get("status") == "ok", f"got {body.get('status')!r}")
    check("timestamp present", isinstance(body.get("timestamp"), str), f"got {body.get('timestamp')!r}")
except Exception as e:
    check("response is JSON", False, str(e))

# ---------------- Summary ----------------
print(f"\n========== SUMMARY ==========")
print(f"PASSED: {passed}")
print(f"FAILED: {failed}")
if failures:
    print("\nFAILURES:")
    for f in failures:
        print(f"  · {f}")
sys.exit(0 if failed == 0 else 1)
