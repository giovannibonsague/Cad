//! Versioned schema migrations, tracked with SQLite's `PRAGMA user_version`.
//!
//! To change the schema: append a new entry to `MIGRATIONS`. Never edit an entry that
//! has shipped. Each migration runs inside its own transaction, so a failure leaves the
//! database at the previous version.
//!
//! Money is stored as integer cents and tax as integer basis points (1/100 of a percent)
//! so that totals are exact. Enumerations (status, category...) are validated in Rust
//! rather than with CHECK constraints so adding a value never needs a table rebuild.

use crate::error::{Error, Result};
use rusqlite::Connection;

pub const MIGRATIONS: &[&str] = &[
    // ---- v1: initial schema
    r#"
    CREATE TABLE projects (
        id                 INTEGER PRIMARY KEY,
        name               TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        description        TEXT    NOT NULL DEFAULT '',
        status             TEXT    NOT NULL DEFAULT 'planning',
        start_date         TEXT,
        due_date           TEXT,
        notes              TEXT    NOT NULL DEFAULT '',
        archived           INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        bom_tax_bp         INTEGER NOT NULL DEFAULT 0 CHECK (bom_tax_bp BETWEEN 0 AND 10000),
        bom_shipping_cents INTEGER NOT NULL DEFAULT 0 CHECK (bom_shipping_cents >= 0),
        is_sample          INTEGER NOT NULL DEFAULT 0 CHECK (is_sample IN (0, 1)),
        created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE components (
        id               INTEGER PRIMARY KEY,
        name             TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        category         TEXT    NOT NULL DEFAULT 'other',
        manufacturer     TEXT    NOT NULL DEFAULT '',
        model            TEXT    NOT NULL DEFAULT '',
        quantity         INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        unit_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
        voltage          REAL    CHECK (voltage IS NULL OR voltage >= 0),
        current          REAL    CHECK (current IS NULL OR current >= 0),
        datasheet_url    TEXT    NOT NULL DEFAULT '',
        notes            TEXT    NOT NULL DEFAULT '',
        is_sample        INTEGER NOT NULL DEFAULT 0 CHECK (is_sample IN (0, 1)),
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_components_category ON components(category);
    CREATE INDEX idx_components_name     ON components(name COLLATE NOCASE);

    CREATE TABLE bom_items (
        id           INTEGER PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
        component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
        quantity     INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
        position     INTEGER NOT NULL DEFAULT 0,
        UNIQUE (project_id, component_id)
    );
    CREATE INDEX idx_bom_project   ON bom_items(project_id);
    CREATE INDEX idx_bom_component ON bom_items(component_id);

    CREATE TABLE cad_files (
        id               INTEGER PRIMARY KEY,
        project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path             TEXT    NOT NULL COLLATE NOCASE,
        display_name     TEXT    NOT NULL,
        extension        TEXT    NOT NULL CHECK (extension IN ('f3d', 'f3z')),
        size_bytes       INTEGER,
        file_modified_at TEXT,
        notes            TEXT    NOT NULL DEFAULT '',
        added_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (project_id, path)
    );
    CREATE INDEX idx_cad_project ON cad_files(project_id);

    CREATE TABLE diagrams (
        id         INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name       TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        data       TEXT    NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_diagrams_project ON diagrams(project_id);

    CREATE TABLE tasks (
        id           INTEGER PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title        TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
        status       TEXT    NOT NULL DEFAULT 'todo',
        priority     TEXT    NOT NULL DEFAULT 'medium',
        due_date     TEXT,
        notes        TEXT    NOT NULL DEFAULT '',
        position     INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX idx_tasks_project ON tasks(project_id, position);

    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
];

pub fn latest_version() -> i64 {
    MIGRATIONS.len() as i64
}

pub fn current_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Apply all migrations newer than the database's `user_version`.
pub fn migrate(conn: &Connection) -> Result<()> {
    migrate_with(conn, MIGRATIONS)
}

pub fn migrate_with(conn: &Connection, migrations: &[&str]) -> Result<()> {
    let current = current_version(conn)?;
    let latest = migrations.len() as i64;
    if current > latest {
        return Err(Error::Unsupported(format!(
            "This database was created by a newer version of RoboDesk (schema v{current}, this app supports v{latest}). \
             Update RoboDesk or choose a different data location."
        )));
    }
    for (i, sql) in migrations.iter().enumerate().skip(current as usize) {
        let version = i as i64 + 1;
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.execute_batch(&format!("PRAGMA user_version = {version}"))?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_reaches_latest() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        assert_eq!(current_version(&conn).unwrap(), latest_version());
        // idempotent
        migrate(&conn).unwrap();
        assert_eq!(current_version(&conn).unwrap(), latest_version());
    }

    #[test]
    fn incremental_upgrade_keeps_data() {
        let conn = Connection::open_in_memory().unwrap();
        let v1 = "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT);";
        let v2 = "ALTER TABLE t ADD COLUMN b TEXT NOT NULL DEFAULT 'x';";
        migrate_with(&conn, &[v1]).unwrap();
        conn.execute("INSERT INTO t (a) VALUES ('hello')", []).unwrap();
        migrate_with(&conn, &[v1, v2]).unwrap();
        let (a, b): (String, String) = conn.query_row("SELECT a, b FROM t", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((a.as_str(), b.as_str()), ("hello", "x"));
        assert_eq!(current_version(&conn).unwrap(), 2);
    }

    #[test]
    fn failed_migration_rolls_back() {
        let conn = Connection::open_in_memory().unwrap();
        let v1 = "CREATE TABLE t (id INTEGER PRIMARY KEY);";
        let bad = "CREATE TABLE u (id INTEGER); THIS IS NOT SQL;";
        migrate_with(&conn, &[v1]).unwrap();
        assert!(migrate_with(&conn, &[v1, bad]).is_err());
        assert_eq!(current_version(&conn).unwrap(), 1);
        assert!(conn.prepare("SELECT * FROM u").is_err(), "partial migration must not persist");
    }

    #[test]
    fn newer_database_is_refused() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 999").unwrap();
        let err = migrate(&conn).unwrap_err();
        assert_eq!(err.code(), "unsupported");
    }
}
