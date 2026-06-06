def parse(value):
    try:
        return int(value)
    except ValueError:
        return 0
