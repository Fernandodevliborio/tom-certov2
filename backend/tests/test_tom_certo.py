"""
Tom Certo API - Backend Tests
Tests: health, seed, auth/validate, auth/revalidate, analyze-key
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://credentials-deploy-1.preview.emergentagent.com')
TEST_TOKEN = "TEST-DEV2026"
TEST_DEVICE = "test-device-pytest-001"

SESSION_JWT = None

@pytest.fixture(scope="session")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


class TestHealth:
    """Health check"""

    def test_health(self, session):
        r = session.get(f"{BASE_URL}/api/health")
        assert r.status_code == 200
        data = r.json()
        assert data.get("status") == "ok"
        print(f"Health OK: {data}")


class TestSeed:
    """Seed test token (idempotent)"""

    def test_seed_test_token(self, session):
        r = session.post(f"{BASE_URL}/api/admin/seed-test-token")
        assert r.status_code == 200
        data = r.json()
        assert data.get("ok") is True
        assert data.get("code") == TEST_TOKEN
        print(f"Seed OK: {data}")


class TestAuth:
    """Auth validate and revalidate"""

    def test_validate_token(self, session):
        global SESSION_JWT
        r = session.post(f"{BASE_URL}/api/auth/validate", json={
            "token": TEST_TOKEN,
            "device_id": TEST_DEVICE,
        })
        assert r.status_code == 200
        data = r.json()
        assert data.get("valid") is True, f"Expected valid=true, got: {data}"
        assert "session" in data
        SESSION_JWT = data["session"]
        print(f"Validate OK: customer={data.get('customer_name')}, session len={len(SESSION_JWT)}")

    def test_validate_invalid_token(self, session):
        r = session.post(f"{BASE_URL}/api/auth/validate", json={
            "token": "INVALID-TOKEN-XYZ",
            "device_id": TEST_DEVICE,
        })
        assert r.status_code == 200
        data = r.json()
        assert data.get("valid") is False
        print(f"Invalid token correctly rejected: {data.get('reason')}")

    def test_revalidate_session(self, session):
        global SESSION_JWT
        if not SESSION_JWT:
            pytest.skip("No session JWT from validate test")
        r = session.post(f"{BASE_URL}/api/auth/revalidate", json={
            "session": SESSION_JWT,
            "device_id": TEST_DEVICE,
        })
        assert r.status_code == 200
        data = r.json()
        assert data.get("valid") is True, f"Revalidate failed: {data}"
        print(f"Revalidate OK: {data.get('customer_name')}")

    def test_revalidate_wrong_device(self, session):
        global SESSION_JWT
        if not SESSION_JWT:
            pytest.skip("No session JWT")
        r = session.post(f"{BASE_URL}/api/auth/revalidate", json={
            "session": SESSION_JWT,
            "device_id": "wrong-device-id",
        })
        assert r.status_code == 200
        data = r.json()
        assert data.get("valid") is False
        assert data.get("reason") == "device_mismatch"
        print(f"Device mismatch correctly rejected")


class TestAnalyzeKey:
    """Analyze key endpoint"""

    def test_analyze_empty_body(self, session):
        """Empty body should return audio_too_short error"""
        r = session.post(f"{BASE_URL}/api/analyze-key",
                         data=b"", headers={"Content-Type": "application/octet-stream"})
        assert r.status_code == 400
        data = r.json()
        assert data.get("error") == "audio_too_short"
        print(f"Empty audio correctly rejected: {data.get('error')}")

    def test_analyze_short_audio(self, session):
        """Short audio (< 1000 bytes) should return audio_too_short"""
        r = session.post(f"{BASE_URL}/api/analyze-key",
                         data=b"\x00" * 500, headers={"Content-Type": "application/octet-stream"})
        assert r.status_code == 400
        data = r.json()
        assert data.get("error") == "audio_too_short"
        print(f"Short audio correctly rejected: {data.get('error')}")
