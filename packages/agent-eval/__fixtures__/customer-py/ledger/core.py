from collections.abc import Iterable


def g(amounts: Iterable[int]) -> int:
    """Impact target: total positive ledger amounts in cents."""
    return sum(amount for amount in amounts if amount > 0)
