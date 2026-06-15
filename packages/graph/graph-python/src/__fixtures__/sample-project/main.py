"""Sample project entry module."""

from util import helper, Greeter


def entry(x):
    """Top-level entry point."""
    g = Greeter("hello")
    msg = g.greet(x)
    return helper(msg)


def unused():
    print("orphan")


if __name__ == "__main__":
    entry(7)
