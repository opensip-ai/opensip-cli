"""Tests for the sample project."""

from util import helper


def test_helper_returns_prefixed_value():
    assert helper("ok") == "helper:ok"
