//! CAD file *references*. RoboDesk stores where a Fusion 360 file lives (plus a little
//! metadata) and can open it with the associated application. It never reads, renders,
//! modifies, moves or deletes the original file: removing an entry only deletes the
//! database row.

use crate::error::{Error, Result};
use crate::projects;
use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::path::Path;

pub const ALLOWED_EXTENSIONS: [&str; 2] = ["f3d", "f3z"];

#[derive(Debug, Clone, Serialize)]
pub struct CadFile {
    pub id: i64,
    pub project_id: i64,
    pub project_name: String,
    pub path: String,
    pub display_name: String,
    pub extension: String,
    pub notes: String,
    pub added_at: String,
    /// Metadata captured when the file was registered / last relocated.
    pub size_bytes: Option<i64>,
    pub file_modified_at: Option<String>,
    /// Live state of the file on disk right now: "ok", "missing", "not_a_file" or "unreadable".
    pub status: &'static str,
    pub current_size_bytes: Option<i64>,
    pub current_modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegisterResult {
    pub registered: Vec<CadFile>,
    pub skipped: Vec<Skipped>,
}

struct Meta {
    size: i64,
    modified: Option<String>,
}

enum DiskState {
    Ok(Meta),
    Missing,
    NotAFile,
    Unreadable,
}

fn inspect(path: &Path) -> DiskState {
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => DiskState::Ok(Meta { size: m.len() as i64, modified: m.modified().ok().map(iso_from_system_time) }),
        Ok(_) => DiskState::NotAFile,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DiskState::Missing,
        Err(_) => DiskState::Unreadable,
    }
}

fn extension_of(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    ALLOWED_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

const SELECT: &str = "SELECT f.id, f.project_id, p.name, f.path, f.display_name, f.extension, f.notes, f.added_at,
        f.size_bytes, f.file_modified_at FROM cad_files f JOIN projects p ON p.id = f.project_id";

fn map_row(r: &Row) -> rusqlite::Result<CadFile> {
    let path: String = r.get(3)?;
    let (status, cur_size, cur_mod) = match inspect(Path::new(&path)) {
        DiskState::Ok(m) => ("ok", Some(m.size), m.modified),
        DiskState::Missing => ("missing", None, None),
        DiskState::NotAFile => ("not_a_file", None, None),
        DiskState::Unreadable => ("unreadable", None, None),
    };
    Ok(CadFile {
        id: r.get(0)?,
        project_id: r.get(1)?,
        project_name: r.get(2)?,
        path,
        display_name: r.get(4)?,
        extension: r.get(5)?,
        notes: r.get(6)?,
        added_at: r.get(7)?,
        size_bytes: r.get(8)?,
        file_modified_at: r.get(9)?,
        status,
        current_size_bytes: cur_size,
        current_modified_at: cur_mod,
    })
}

pub fn get(conn: &Connection, id: i64) -> Result<CadFile> {
    conn.query_row(&format!("{SELECT} WHERE f.id = ?1"), [id], map_row)
        .optional()?
        .ok_or_else(|| Error::NotFound("CAD entry not found.".into()))
}

/// `project_id = None` lists every project's CAD references.
pub fn list(conn: &Connection, project_id: Option<i64>) -> Result<Vec<CadFile>> {
    let (sql, bind): (String, Option<i64>) = match project_id {
        Some(id) => (format!("{SELECT} WHERE f.project_id = ?1 ORDER BY f.display_name COLLATE NOCASE, f.id"), Some(id)),
        None => (format!("{SELECT} ORDER BY p.name COLLATE NOCASE, f.display_name COLLATE NOCASE, f.id"), None),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = match bind {
        Some(id) => stmt.query_map([id], map_row)?.collect::<std::result::Result<Vec<_>, _>>()?,
        None => stmt.query_map([], map_row)?.collect::<std::result::Result<Vec<_>, _>>()?,
    };
    Ok(rows)
}

/// Register existing files for a project. Each path is checked individually; problems
/// (wrong type, missing, duplicate) are reported in `skipped` and never abort the batch.
pub fn register(conn: &Connection, project_id: i64, paths: &[String]) -> Result<RegisterResult> {
    projects::get(conn, project_id)?;
    if paths.len() > 200 {
        return Err(Error::validation("paths", "Please register at most 200 files at a time."));
    }
    let mut registered = Vec::new();
    let mut skipped = Vec::new();
    for raw in paths {
        let p = Path::new(raw);
        let mut skip = |reason: &str| skipped.push(Skipped { path: raw.clone(), reason: reason.to_string() });
        if !p.is_absolute() {
            skip("Path must be absolute.");
            continue;
        }
        let Some(ext) = extension_of(p) else {
            skip("Only Fusion 360 .f3d and .f3z files can be added.");
            continue;
        };
        let meta = match inspect(p) {
            DiskState::Ok(m) => m,
            DiskState::Missing => {
                skip("The file does not exist.");
                continue;
            }
            DiskState::NotAFile => {
                skip("That path is not a file.");
                continue;
            }
            DiskState::Unreadable => {
                skip("The file could not be accessed (permission problem?).");
                continue;
            }
        };
        let display = p.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
        let res = conn.execute(
            "INSERT INTO cad_files (project_id, path, display_name, extension, size_bytes, file_modified_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![project_id, raw, display, ext, meta.size, meta.modified],
        );
        match res {
            Ok(_) => registered.push(get(conn, conn.last_insert_rowid())?),
            Err(rusqlite::Error::SqliteFailure(f, _)) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                skip("This file is already listed in the project.")
            }
            Err(e) => return Err(e.into()),
        }
    }
    if !registered.is_empty() {
        projects::touch(conn, project_id)?;
    }
    Ok(RegisterResult { registered, skipped })
}

pub fn update(conn: &Connection, id: i64, display_name: &str, notes: &str) -> Result<CadFile> {
    let name = text("display_name", "Name", display_name, 1, 200)?;
    let notes = multiline("notes", "Notes", notes, 5000)?;
    let existing = get(conn, id)?;
    conn.execute("UPDATE cad_files SET display_name = ?1, notes = ?2 WHERE id = ?3", params![name, notes, id])?;
    projects::touch(conn, existing.project_id)?;
    get(conn, id)
}

/// Point an entry (typically a missing one) at a new location and refresh its metadata.
pub fn relocate(conn: &Connection, id: i64, new_path: &str) -> Result<CadFile> {
    let existing = get(conn, id)?;
    let p = Path::new(new_path);
    if !p.is_absolute() {
        return Err(Error::validation("path", "Path must be absolute."));
    }
    let ext = extension_of(p).ok_or_else(|| Error::validation("path", "Only Fusion 360 .f3d and .f3z files can be linked."))?;
    let meta = match inspect(p) {
        DiskState::Ok(m) => m,
        DiskState::Missing => return Err(Error::validation("path", "The file does not exist.")),
        _ => return Err(Error::validation("path", "That path is not an accessible file.")),
    };
    conn.execute(
        "UPDATE cad_files SET path = ?1, extension = ?2, size_bytes = ?3, file_modified_at = ?4 WHERE id = ?5",
        params![new_path, ext, meta.size, meta.modified, id],
    )?;
    projects::touch(conn, existing.project_id)?;
    get(conn, id)
}

/// Remove the *reference* only. The file on disk is not touched.
pub fn remove(conn: &Connection, id: i64) -> Result<()> {
    let existing = get(conn, id)?;
    conn.execute("DELETE FROM cad_files WHERE id = ?1", [id])?;
    projects::touch(conn, existing.project_id)?;
    Ok(())
}

/// Path to hand to the OS "open" handler. Only registered, existing `.f3d`/`.f3z` files qualify,
/// so the frontend cannot use this to launch arbitrary programs or documents.
pub fn resolve_for_open(conn: &Connection, id: i64) -> Result<String> {
    let f = get(conn, id)?;
    if extension_of(Path::new(&f.path)).is_none() {
        return Err(Error::Unsupported("Only Fusion 360 files can be opened from here.".into()));
    }
    match f.status {
        "ok" => Ok(f.path),
        "missing" => Err(Error::NotFound(format!("The file \"{}\" is missing. Use Relocate to point to its new location.", f.display_name))),
        _ => Err(Error::Unsupported("The file cannot be accessed.".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, projects::ProjectInput};

    fn project(conn: &Connection) -> i64 {
        projects::create(
            conn,
            ProjectInput { name: "P".into(), description: String::new(), status: "planning".into(), start_date: None, due_date: None, notes: String::new() },
        )
        .unwrap()
        .project
        .id
    }

    #[test]
    fn register_validate_missing_remove_keeps_file() {
        let conn = db::open_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let p = project(&conn);

        let good = dir.path().join("Chassis v3.F3D");
        std::fs::write(&good, b"fake").unwrap();
        let wrong = dir.path().join("notes.txt");
        std::fs::write(&wrong, b"x").unwrap();
        let ghost = dir.path().join("ghost.f3z");

        let paths: Vec<String> = [&good, &wrong, &ghost].iter().map(|p| p.to_string_lossy().to_string()).collect();
        let res = register(&conn, p, &paths).unwrap();
        assert_eq!(res.registered.len(), 1);
        assert_eq!(res.skipped.len(), 2);
        let f = &res.registered[0];
        assert_eq!(f.extension, "f3d");
        assert_eq!(f.display_name, "Chassis v3.F3D");
        assert_eq!(f.size_bytes, Some(4));
        assert_eq!(f.status, "ok");

        // duplicate registration is skipped, not an error
        let again = register(&conn, p, &[good.to_string_lossy().to_string()]).unwrap();
        assert!(again.registered.is_empty());
        assert_eq!(again.skipped.len(), 1);

        // relative paths rejected
        assert_eq!(register(&conn, p, &["x.f3d".into()]).unwrap().skipped.len(), 1);

        // missing file is reported, not hidden
        std::fs::remove_file(&good).unwrap();
        let listed = list(&conn, Some(p)).unwrap();
        assert_eq!(listed[0].status, "missing");
        assert!(resolve_for_open(&conn, f.id).unwrap_err().to_string().contains("missing"));

        // relocate to a new file
        let moved = dir.path().join("moved.f3d");
        std::fs::write(&moved, b"12345").unwrap();
        let r = relocate(&conn, f.id, &moved.to_string_lossy()).unwrap();
        assert_eq!(r.status, "ok");
        assert_eq!(r.size_bytes, Some(5));
        assert_eq!(resolve_for_open(&conn, f.id).unwrap(), moved.to_string_lossy());
        assert!(relocate(&conn, f.id, &wrong.to_string_lossy()).is_err());

        // removing the entry must never delete the file
        remove(&conn, f.id).unwrap();
        assert!(moved.exists(), "original file must survive removal of its entry");
        assert!(list(&conn, Some(p)).unwrap().is_empty());
        assert!(wrong.exists());
    }

    #[test]
    fn deleting_project_keeps_files_on_disk() {
        let conn = db::open_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let p = project(&conn);
        let f = dir.path().join("a.f3z");
        std::fs::write(&f, b"z").unwrap();
        register(&conn, p, &[f.to_string_lossy().to_string()]).unwrap();
        projects::delete(&conn, p).unwrap();
        assert!(f.exists());
    }
}
