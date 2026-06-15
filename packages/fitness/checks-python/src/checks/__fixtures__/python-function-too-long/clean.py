def add(a, b):
    return a + b


def subtract(a, b):
    return a - b


def process(data):
    total = 0
    for item in data:
        total = add(total, item)
    return total
