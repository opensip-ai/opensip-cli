# Sample Python source for multi-language fitness checks.
def safe_parse(value):
    try:
        return int(value)
    except:
        return None
