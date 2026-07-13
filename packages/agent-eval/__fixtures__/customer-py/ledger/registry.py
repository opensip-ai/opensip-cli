from collections.abc import Callable, Iterable

from ledger import g

Handler = Callable[[Iterable[int]], int]

HANDLERS: dict[str, Handler] = {
    "ledger.total": g,
}


def dispatch_operation(name: str, amounts: Iterable[int]) -> int:
    """Name-based dispatch deliberately obscures the concrete target."""
    handler = HANDLERS[name]
    return handler(amounts)
