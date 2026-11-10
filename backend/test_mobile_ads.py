from types import SimpleNamespace
from unittest.mock import Mock

from app import settings
from mobile_api import PolicyAcceptance, mobile_ads


def test_ads_switch_fails_closed_outside_production_and_per_platform(monkeypatch):
    user, session = SimpleNamespace(id=20), Mock()
    session.get.return_value = SimpleNamespace(version="2026-08-31")
    monkeypatch.setattr(settings, "admob_android_serving", True)
    monkeypatch.setattr(settings, "admob_ios_serving", False)
    monkeypatch.setattr(settings, "environment", "development")
    assert mobile_ads("android", user, session) == {"enabled": False}
    monkeypatch.setattr(settings, "environment", "production")
    assert mobile_ads("ios", user, session) == {"enabled": False}
    session.get.assert_not_called()
    assert mobile_ads("android", user, session) == {"enabled": True}
    session.get.assert_called_once_with(PolicyAcceptance, user.id)


def test_ads_require_an_account_with_the_existing_adult_attestation(monkeypatch):
    user, session = SimpleNamespace(id=20), Mock()
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "admob_ios_serving", True)
    for acceptance in (None, SimpleNamespace(version="unknown")):
        session.get.return_value = acceptance
        assert mobile_ads("ios", user, session) == {"enabled": False}
    session.get.return_value = SimpleNamespace(version="2026-08-31")
    assert mobile_ads("ios", user, session) == {"enabled": True}
