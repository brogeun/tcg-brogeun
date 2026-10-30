"""Offline JSON-line SQLite adapter for actual collection endpoint tests only."""
import json
import sqlite3
import sys

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')

db = sqlite3.connect(':memory:', isolation_level=None)
db.row_factory = sqlite3.Row
db.execute('PRAGMA foreign_keys=ON')

def statement(item):
    before = db.total_changes
    cur = db.execute(item['sql'], item.get('params', []))
    rows = [dict(row) for row in cur.fetchall()] if cur.description else []
    return {'success': True, 'results': rows, 'meta': {'changes': db.total_changes-before, 'last_row_id': cur.lastrowid}}

for line in sys.stdin:
    try:
        request = json.loads(line)
        if request['op'] == 'script':
            db.executescript(request['sql'])
            result = {'success': True}
        elif request['op'] == 'batch':
            db.execute('BEGIN')
            try:
                result = [statement(item) for item in request['statements']]
                db.execute('COMMIT')
            except Exception:
                db.execute('ROLLBACK')
                raise
        else:
            result = statement(request)
        print(json.dumps({'id': request['id'], 'result': result}), flush=True)
    except Exception as error:
        print(json.dumps({'id': request.get('id'), 'error': str(error)}), flush=True)
