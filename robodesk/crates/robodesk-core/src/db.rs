//! Opening the database: pragmas, migrations, and a safety backup before upgrades.

use crate::error::Result;
use crate::migrations;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub const DB_FILE_NAME: &str = "robodesk.db";

fn apply_pragmas(conn: &Connection) -> Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;",
    )?;
    Ok(())
}

/// In-memory database with the full schema; used by tests and tooling.
pub fn open_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    migrations::migrate(&conn)?;
    Ok(conn)
}

/// Open (creating if needed) the on-disk database and bring it to the latest schema.
///
/// If an existing database needs upgrading, a copy is written to `backup_dir` first so
/// a bad migration can never cost the user their data.
pub fn open(path: &Path, backup_dir: &Path) -> Result<Connection> {
    open_with(path, backup_dir, migrations::MIGRATIONS)
}

/// Same as [`open`] with an explicit migration list (lets tests exercise real upgrades).
pub fn open_with(path: &Path, backup_dir: &Path, migs: &[&str]) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existed = path.exists();
    let conn = Connection::open(path)?;
    apply_pragmas(&conn)?;

    let version = migrations::current_version(&conn)?;
    let latest = migs.len() as i64;
    if existed && version > 0 && version < latest {
        std::fs::create_dir_all(backup_dir)?;
        let stamp: String = conn.query_row("SELECT strftime('%Y%m%d-%H%M%S','now')", [], |r| r.get(0))?;
        let target = backup_dir.join(format!("robodesk-premigrate-v{version}-{stamp}.db"));
        copy_database(&conn, &target)?;
    }
    migrations::migrate_with(&conn, migs)?;
    restrict_permissions(path);
    Ok(conn)
}

/// Consistent copy of a live database (works with WAL) using `VACUUM INTO`.
pub fn copy_database(conn: &Connection, target: &Path) -> Result<()> {
    if target.exists() {
        std::fs::remove_file(target)?;
    }
    let t = target.to_string_lossy().to_string();
    conn.execute("VACUUM INTO ?1", [t])?;
    restrict_permissions(target);
    Ok(())
}

/// Owner-only permissions on Unix. On Windows the per-user app-data folder inherits
/// an ACL that already limits access to the current user (and administrators).
pub fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

pub fn db_path_in(dir: &Path) -> PathBuf {
    dir.join(DB_FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("robodesk.db");
        let backups = dir.path().join("backups");
        {
            let conn = open(&path, &backups).unwrap();
            conn.execute("INSERT INTO projects (name) VALUES ('Rover')", []).unwrap();
        }
        let conn = open(&path, &backups).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1);
    }

    #[test]
    fn upgrading_an_existing_database_writes_a_premigration_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("robodesk.db");
        let backups = dir.path().join("backups");
        let v1 = "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT);";
        let v2 = "ALTER TABLE t ADD COLUMN b TEXT NOT NULL DEFAULT 'x';";
        {
            let conn = open_with(&path, &backups, &[v1]).unwrap();
            conn.execute("INSERT INTO t (a) VALUES ('keep')", []).unwrap();
        }
        // fresh install of v1 must not create a backup
        assert!(!backups.exists() || std::fs::read_dir(&backups).unwrap().count() == 0);

        let conn = open_with(&path, &backups, &[v1, v2]).unwrap();
        let b: String = conn.query_row("SELECT b FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(b, "x");

        let files: Vec<_> = std::fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(files.len(), 1);
        assert!(files[0].starts_with("robodesk-premigrate-v1-"), "{files:?}");
        // the backup holds the pre-upgrade schema and data
        let old = Connection::open(backups.join(&files[0])).unwrap();
        let a: String = old.query_row("SELECT a FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(a, "keep");
        assert!(old.prepare("SELECT b FROM t").is_err());
    }
}
