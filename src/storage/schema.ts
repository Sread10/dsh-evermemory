/**
 * Database schema and migrations.
 *
 * `PRAGMA user_version` is the migration counter — SQLite's own, so no bookkeeping table is
 * needed and a half-applied migration cannot leave the counter out of step with the file.
 *
 * Tables are `STRICT` on purpose. The columns here hold text a language model produced, and
 * a non-STRICT SQLite table would happily store the number `3` in a TEXT column or `"null"`
 * in one meant to be nullable. The failure would surface much later, as a row nothing can
 * read, so it is worth refusing at write time.
 */
import type { DatabaseSync } from 'node:sqlite'

/** DDL for schema version 1, applied in one transaction. */
const V1 = `
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  project_key TEXT,
  project_path TEXT,
  sub_id TEXT,
  tags TEXT,
  source TEXT DEFAULT 'auto',
  source_platform TEXT,
  pinned INTEGER DEFAULT 0,
  importance INTEGER DEFAULT 0,
  last_used_at TEXT,
  -- Millisecond precision, and identical for both columns. datetime('now') yields
  -- '2026-10-03 13:41:25' while the millisecond form yields '....25.123', and those two
  -- SHAPES do not compare correctly as strings: at equal seconds the shorter one sorts
  -- first, so ordering by COALESCE(last_used_at, created_at) silently misranks a row whose
  -- last_used_at carries milliseconds against one whose created_at does not. The repository
  -- always supplies these values explicitly; the defaults are for a row inserted by hand.
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  status TEXT NOT NULL DEFAULT 'active'
) STRICT;

CREATE TABLE tags (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (memory_id, tag)
) STRICT;

CREATE TABLE import_ledger (
  hash TEXT PRIMARY KEY,
  memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_memories_scope_project ON memories(scope, project_key, status);
CREATE INDEX idx_memories_last_used ON memories(last_used_at);

-- Full-text search over title and body.
--
-- The tokenizer is \`trigram\`, not \`unicode61\`, and choosing it is the single most
-- consequential decision in this file. Measured on a document reading
-- "索引优化减少Token消耗的句子", \`unicode61\` indexes the whole CJK run as ONE token — its
-- vocabulary is literally ["索引优化减少token消耗的句子"] — so a query for 索引优化 or even
-- 索引 returns nothing. \`trigram\` matches on three-character windows and therefore covers
-- Chinese and English with one index, which is why there is no second, bigram table here:
-- a second table only adds a "which one do I query" guess, and a wrong guess is a silent
-- zero-hit rather than an error.
--
-- The floor that comes with it is exactly three characters, and it fails SILENTLY below
-- that. Queries shorter than three characters must go to retrieval/like.ts instead; see
-- retrieval/tokenize.ts for the router.
--
-- \`detail\` stays at its default of \`full\`. Both \`none\` and \`column\` throw
-- "fts5: phrase queries are not supported" for every quoted query, and every query this
-- plugin issues is a quoted phrase.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  title,
  text,
  content='memories',
  content_rowid='id',
  tokenize='trigram'
);

-- Keep the index in step with the table.
--
-- External-content FTS5 does not observe writes, so these three triggers are the only thing
-- making \`memories_fts\` mean anything. They are \`AFTER\` triggers rather than a scheduled
-- rebuild so that a crash between a write and a reindex cannot leave a row unsearchable.
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;

CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
END;

CREATE TRIGGER memories_fts_update AFTER UPDATE OF title, text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
  INSERT INTO memories_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;
`

/**
 * Every migration, in order. Never edit a released entry — append.
 *
 * The array index plus one IS the schema version, so appending is the whole update
 * procedure and there is no second registry to forget.
 */
export const MIGRATIONS: readonly string[] = [V1]

/** Schema version a freshly-migrated database reports. */
export const SCHEMA_VERSION = MIGRATIONS.length

/**
 * Bring a database up to {@link SCHEMA_VERSION}.
 *
 * Each migration runs in its own transaction together with the `user_version` bump, so an
 * interrupted upgrade leaves the counter describing exactly the DDL that landed.
 *
 * @param db - an open database handle.
 * @returns the versions applied, empty when the database was already current.
 */
export function migrate(db: DatabaseSync): number[] {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const current = Number(row?.user_version ?? 0)
  const applied: number[] = []

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version]
    if (sql === undefined) continue
    db.exec('BEGIN')
    try {
      db.exec(sql)
      // `PRAGMA` does not accept a bound parameter, and `version + 1` is a number this
      // module computed rather than anything a caller supplied.
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    applied.push(version + 1)
  }

  return applied
}
