// Local-only D1-compatible SQLite adapter for API tests and the preview server.
import { DatabaseSync } from 'node:sqlite';
export class LocalDB {
  constructor(path = ':memory:') { this.sqlite = new DatabaseSync(path); this.sqlite.exec('PRAGMA foreign_keys=ON'); }
  prepare(sql) {
    const statement = this.sqlite.prepare(sql);
    const bound = params => ({
      bind: (...values) => bound(values),
      first: () => statement.get(...params) || null,
      all: () => ({ results: statement.all(...params) }),
      run: () => ({ meta: statement.run(...params) })
    });
    return bound([]);
  }
  batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const results = statements.map(statement => statement.run()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
