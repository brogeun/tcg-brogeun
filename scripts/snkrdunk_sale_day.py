"""Resolve SNKRDUNK sales-history dates on its market calendar."""
import re
from datetime import date, timedelta, timezone

JST = timezone(timedelta(hours=9))


def sale_day(value, observed_at):
    if not isinstance(value, str) or observed_at.tzinfo is None:
        raise ValueError('Missing SNKRDUNK sale date or observation timezone')
    now = observed_at.astimezone(JST)
    text = value.strip()
    absolute = re.fullmatch(r'(\d{4})[/-](\d{2})[/-](\d{2})(?:\s+\d{2}:\d{2}(?::\d{2})?)?', text)
    if absolute:
        result = date(*map(int, absolute.groups()))
    else:
        ago = re.fullmatch(r'(\d+)\s*(日|時間|分|秒|days?|hours?|minutes?|mins?|seconds?)(?:前|\s+ago)?', text, re.I)
        if not ago:
            raise ValueError('Unknown SNKRDUNK sale date')
        amount, unit = int(ago[1]), ago[2].lower()
        if unit == '日' or unit.startswith('day'):
            elapsed = timedelta(days=amount)
        elif unit == '時間' or unit.startswith('hour'):
            elapsed = timedelta(hours=amount)
        elif unit == '分' or unit.startswith('min'):
            elapsed = timedelta(minutes=amount)
        else:
            elapsed = timedelta(seconds=amount)
        result = (now - elapsed).date()
    if result > now.date():
        raise ValueError('Future SNKRDUNK sale date')
    return result.isoformat()
