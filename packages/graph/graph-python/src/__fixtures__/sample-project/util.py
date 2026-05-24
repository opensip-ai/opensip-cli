"""Utility module."""


def helper(value):
    """Concat shim."""
    return f"helper:{value}"


class Greeter:
    """Greeter class with a method."""

    def __init__(self, prefix):
        self.prefix = prefix

    def greet(self, who):
        return f"{self.prefix} {who}"


add_one = lambda n: n + 1
