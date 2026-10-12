//! Data safety: backups, restore, JSON export/import, data-location changes and reset.
//!
//! Every operation that can replace or destroy user data first writes a restorable
//! snapshot into the `backups` folder next to the database.

use crate::bom::MAX_LINE_QTY;
use crate::components::{self, ComponentInput};
use crate::db;
use crate::diagrams;
use crate::models3d;
use crate::error::{Error, Result};
use crate::migrations;
use crate::projects::{self, ProjectInput};
use crate::settings;
use crate::tasks::{self, TaskInput};
use crate::util::*;
use crate::{Paths, State};
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub const EXPORT_FORMAT: &str = "robodesk-export";
pub const EXPORT_VERSION: i64 = 1;
const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ROWS: usize = 200_000;
pub const RESET_CONFIRMATION: &str = "DELETE ALL DATA";
const BACKUP_KINDS: [&str; 5] = ["backup", "preimport", "prerestore", "prereset", "premigrate"];

// ------------------------------------------------------------------ backups

#[derive(Debug, Clone, Serialize)]
pub struct BackupInfo {
    pub name: String,
    pub kind: String,
    pub size_bytes: i64,
    pub modified_at: String,
}

fn stamp(conn: &Connection) -> Result<String> {
    Ok(conn.query_row("SELECT strftime('%Y%m%d-%H%M%S','now')", [], |r| r.get(0))?)
}

fn info_for(path: &Path) -> Option<BackupInfo> {
    let name = path.file_name()?.to_str()?.to_string();
    let kind = BACKUP_KINDS.iter().find(|k| name.starts_with(&format!("robodesk-{k}-")))?;
    if !name.ends_with(".db") {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    Some(BackupInfo {
        name,
        kind: kind.to_string(),
        size_bytes: meta.len() as i64,
        modified_at: meta.modified().ok().map(iso_from_system_time).unwrap_or_default(),
    })
}

pub fn list_backups(paths: &Paths) -> Result<Vec<BackupInfo>> {
    let mut out = Vec::new();
    if paths.backup_dir.exists() {
        for entry in std::fs::read_dir(&paths.backup_dir)? {
            if let Some(i) = info_for(&entry?.path()) {
                out.push(i);
            }
        }
    }
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(b.name.cmp(&a.name)));
    Ok(out)
}

fn prune(paths: &Paths, kind: &str, keep: usize) -> Result<()> {
    let mut mine: Vec<BackupInfo> = list_backups(paths)?.into_iter().filter(|b| b.kind == kind).collect();
    mine.sort_by(|a, b| b.name.cmp(&a.name));
    for old in mine.into_iter().skip(keep) {
        let _ = std::fs::remove_file(paths.backup_dir.join(old.name));
    }
    Ok(())
}

/// Write a consistent snapshot of the live database. `kind` is one of `BACKUP_KINDS`.
pub fn snapshot(state: &State, kind: &str) -> Result<BackupInfo> {
    debug_assert!(BACKUP_KINDS.contains(&kind));
    std::fs::create_dir_all(&state.paths.backup_dir)?;
    let stamp = stamp(&state.conn)?;
    // The zero-padded sequence keeps names in chronological order even for same-second snapshots,
    // which pruning (sorted by name) relies on. Use highest-existing + 1 (not first free slot):
    // a pruned low number must never be reused, or the newest snapshot would sort as the oldest.
    let prefix = format!("robodesk-{kind}-{stamp}-");
    let mut n = 0u32;
    for entry in std::fs::read_dir(&state.paths.backup_dir)? {
        let name = entry?.file_name().to_string_lossy().to_string();
        if let Some(rest) = name.strip_prefix(&prefix).and_then(|r| r.strip_suffix(".db")) {
            n = n.max(rest.parse::<u32>().unwrap_or(0));
        }
    }
    let target = state.paths.backup_dir.join(format!("{prefix}{:02}.db", n + 1));
    db::copy_database(&state.conn, &target)?;
    let keep = if kind == "backup" { settings::get_i64(&state.conn, "backup_keep")?.max(1) as usize } else { 5 };
    prune(&state.paths, kind, keep)?;
    info_for(&target).ok_or_else(|| Error::Unsupported("Backup was written but could not be read back.".into()))
}

fn valid_backup_name(name: &str) -> bool {
    name.len() < 100
        && name.starts_with("robodesk-")
        && name.ends_with(".db")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
        && !name.contains("..")
}

/// Replace the live database with a snapshot from the backups folder (by file name).
pub fn restore_backup(state: &mut State, name: &str) -> Result<Value> {
    if !valid_backup_name(name) {
        return Err(Error::validation("name", "That is not a RoboDesk backup file name."));
    }
    let path = state.paths.backup_dir.join(name);
    if !path.is_file() {
        return Err(Error::NotFound("That backup no longer exists.".into()));
    }
    let src = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let check: String = src.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(Error::Unsupported("That backup file is damaged and cannot be restored.".into()));
    }
    let v = migrations::current_version(&src)?;
    if v < 1 || v > migrations::latest_version() {
        return Err(Error::Unsupported("That backup was made by an incompatible version of RoboDesk.".into()));
    }
    let safety = snapshot(state, "prerestore")?;
    {
        let b = rusqlite::backup::Backup::new(&src, &mut state.conn)?;
        b.run_to_completion(256, std::time::Duration::ZERO, None)?;
    }
    migrations::migrate(&state.conn)?;
    state.conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
    Ok(json!({ "restored": name, "safety_backup": safety.name }))
}

// ------------------------------------------------------------------- export

fn table_json(conn: &Connection, table: &str, order: &str) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt
        .query_map([], |r| {
            let mut m = Map::new();
            for (i, n) in names.iter().enumerate() {
                let v = match r.get_ref(i)? {
                    ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                    ValueRef::Integer(x) => json!(x),
                    ValueRef::Real(f) => json!(f),
                    ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                };
                m.insert(n.clone(), v);
            }
            Ok(Value::Object(m))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn export_value(conn: &Connection) -> Result<Value> {
    let exported_at: String = conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| r.get(0))?;
    let mut diagrams_json = table_json(conn, "diagrams", "id")?;
    for d in &mut diagrams_json {
        if let Some(Value::String(s)) = d.get("data") {
            let parsed: Value = serde_json::from_str(s)?;
            d["data"] = parsed;
        }
    }
    let mut models_json = table_json(conn, "models3d", "id")?;
    for d in &mut models_json {
        if let Some(Value::String(s)) = d.get("data") {
            let parsed: Value = serde_json::from_str(s)?;
            d["data"] = parsed;
        }
    }
    let mut settings_map = Map::new();
    for row in table_json(conn, "settings", "key")? {
        if let (Some(Value::String(k)), Some(Value::String(v))) = (row.get("key"), row.get("value")) {
            settings_map.insert(k.clone(), serde_json::from_str(v).unwrap_or(Value::Null));
        }
    }
    Ok(json!({
        "format": EXPORT_FORMAT,
        "version": EXPORT_VERSION,
        "app_version": env!("CARGO_PKG_VERSION"),
        "exported_at": exported_at,
        "projects": table_json(conn, "projects", "id")?,
        "components": table_json(conn, "components", "id")?,
        "bom_items": table_json(conn, "bom_items", "id")?,
        "cad_files": table_json(conn, "cad_files", "id")?,
        "diagrams": diagrams_json,
        "models": models_json,
        "tasks": table_json(conn, "tasks", "id")?,
        "settings": Value::Object(settings_map),
    }))
}

pub(crate) fn require_file_ext(path: &str, ext: &str) -> Result<PathBuf> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(Error::validation("path", "Path must be absolute."));
    }
    let ok = p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case(ext)).unwrap_or(false);
    if !ok {
        return Err(Error::validation("path", format!("The file must have a .{ext} extension.")));
    }
    match p.parent() {
        Some(parent) if parent.is_dir() => Ok(p),
        _ => Err(Error::validation("path", "The destination folder does not exist.")),
    }
}

/// Write a file via a temporary sibling then rename, so a failed write never leaves a truncated file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", path.extension().and_then(|e| e.to_str()).unwrap_or("")));
    std::fs::write(&tmp, bytes)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

pub fn export_json_file(conn: &Connection, path: &str) -> Result<Value> {
    let p = require_file_ext(path, "json")?;
    let v = export_value(conn)?;
    write_atomic(&p, serde_json::to_string_pretty(&v)?.as_bytes())?;
    Ok(json!({ "path": path, "projects": v["projects"].as_array().map_or(0, |a| a.len()), "components": v["components"].as_array().map_or(0, |a| a.len()) }))
}

pub fn export_bom_csv(conn: &Connection, project_id: i64, path: &str) -> Result<Value> {
    let p = require_file_ext(path, "csv")?;
    let view = crate::bom::get(conn, project_id)?;
    write_atomic(&p, crate::bom::to_csv(&view).as_bytes())?;
    Ok(json!({ "path": path, "lines": view.lines.len(), "total_cents": view.total_cents }))
}

// ------------------------------------------------------------------- import

struct Rec<'a> {
    v: &'a Value,
    ctx: String,
}

impl<'a> Rec<'a> {
    fn new(v: &'a Value, table: &str, i: usize) -> Result<Self> {
        let r = Rec { v, ctx: format!("{table}[{i}]") };
        if !v.is_object() {
            return Err(r.err("must be an object"));
        }
        Ok(r)
    }
    fn err(&self, msg: &str) -> Error {
        Error::validation("file", format!("Import failed at {}: {msg}", self.ctx))
    }
    fn wrap<T>(&self, r: Result<T>) -> Result<T> {
        r.map_err(|e| self.err(&e.to_string()))
    }
    fn int(&self, key: &str) -> Result<i64> {
        self.v.get(key).and_then(Value::as_i64).ok_or_else(|| self.err(&format!("'{key}' must be a whole number")))
    }
    fn int_or(&self, key: &str, default: i64) -> Result<i64> {
        match self.v.get(key) {
            None | Some(Value::Null) => Ok(default),
            Some(_) => self.int(key),
        }
    }
    fn id(&self) -> Result<i64> {
        let id = self.int("id")?;
        if id < 1 {
            return Err(self.err("'id' must be positive"));
        }
        Ok(id)
    }
    fn flag(&self, key: &str) -> Result<i64> {
        match self.v.get(key) {
            None | Some(Value::Null) => Ok(0),
            Some(Value::Bool(b)) => Ok(*b as i64),
            Some(Value::Number(n)) if n.as_i64() == Some(0) || n.as_i64() == Some(1) => Ok(n.as_i64().unwrap()),
            _ => Err(self.err(&format!("'{key}' must be true or false"))),
        }
    }
    fn stamp(&self, key: &str) -> Result<Option<String>> {
        match self.v.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) if s.len() <= 40 && !s.chars().any(|c| c.is_control()) => Ok(Some(s.clone())),
            _ => Err(self.err(&format!("'{key}' must be a timestamp string"))),
        }
    }
    fn opt_text(&self, key: &str, max: usize) -> Result<Option<String>> {
        match self.v.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(self.wrap(text(key, key, s, 0, max))?)),
            _ => Err(self.err(&format!("'{key}' must be text"))),
        }
    }
    fn parse<T: serde::de::DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_value(self.v.clone()).map_err(|e| self.err(&e.to_string()))
    }
}

fn rows<'a>(root: &'a Value, key: &str) -> Result<&'a [Value]> {
    let arr: &[Value] = match root.get(key) {
        None | Some(Value::Null) => &[],
        Some(Value::Array(a)) => a,
        Some(_) => return Err(Error::validation("file", format!("'{key}' must be a list."))),
    };
    if arr.len() > MAX_ROWS {
        return Err(Error::validation("file", format!("'{key}' has too many entries.")));
    }
    Ok(arr)
}

fn check_header(root: &Value) -> Result<()> {
    if root.get("format").and_then(Value::as_str) != Some(EXPORT_FORMAT) {
        return Err(Error::validation("file", "This is not a RoboDesk export file."));
    }
    match root.get("version").and_then(Value::as_i64) {
        Some(v) if (1..=EXPORT_VERSION).contains(&v) => Ok(()),
        _ => Err(Error::Unsupported("This export was made by a newer version of RoboDesk and cannot be imported.".into())),
    }
}

/// Validate `root` and replace all data in `conn` with it, atomically.
fn apply_import(conn: &Connection, root: &Value) -> Result<Value> {
    check_header(root)?;
    let tx = conn.unchecked_transaction()?;
    for t in ["tasks", "models3d", "diagrams", "cad_files", "bom_items", "components", "projects", "settings"] {
        tx.execute(&format!("DELETE FROM {t}"), [])?;
    }
    let now = NOW_SQL;

    let mut n_projects = 0;
    for (i, v) in rows(root, "projects")?.iter().enumerate() {
        let r = Rec::new(v, "projects", i)?;
        let input: ProjectInput = r.parse()?;
        let p = r.wrap(projects::validate(&input))?;
        tx.execute(
            &format!(
                "INSERT INTO projects (id, name, description, status, start_date, due_date, notes, archived,
                    bom_tax_bp, bom_shipping_cents, is_sample, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11, COALESCE(?12, {now}), COALESCE(?13, {now}))"
            ),
            rusqlite::params![
                r.id()?, p.name, p.description, p.status, p.start_date, p.due_date, p.notes, r.flag("archived")?,
                r.wrap(int_range("bom_tax_bp", "Tax rate", r.int_or("bom_tax_bp", 0)?, 0, 10_000))?,
                r.wrap(int_range("bom_shipping_cents", "Shipping", r.int_or("bom_shipping_cents", 0)?, 0, 100_000_000))?,
                r.flag("is_sample")?, r.stamp("created_at")?, r.stamp("updated_at")?
            ],
        )
        .map_err(|e| r.err(&Error::from(e).to_string()))?;
        n_projects += 1;
    }

    let mut n_components = 0;
    for (i, v) in rows(root, "components")?.iter().enumerate() {
        let r = Rec::new(v, "components", i)?;
        let input: ComponentInput = r.parse()?;
        let c = r.wrap(components::validate(&input))?;
        tx.execute(
            &format!(
                "INSERT INTO components (id, name, category, manufacturer, model, quantity, unit_price_cents, voltage, current,
                    datasheet_url, notes, is_sample, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12, COALESCE(?13, {now}), COALESCE(?14, {now}))"
            ),
            rusqlite::params![
                r.id()?, c.name, c.category, c.manufacturer, c.model, c.quantity, c.unit_price_cents, c.voltage, c.current,
                c.datasheet_url, c.notes, r.flag("is_sample")?, r.stamp("created_at")?, r.stamp("updated_at")?
            ],
        )
        .map_err(|e| r.err(&Error::from(e).to_string()))?;
        n_components += 1;
    }

    for (i, v) in rows(root, "bom_items")?.iter().enumerate() {
        let r = Rec::new(v, "bom_items", i)?;
        let qty = r.wrap(int_range("quantity", "Quantity", r.int("quantity")?, 1, MAX_LINE_QTY))?;
        tx.execute(
            "INSERT INTO bom_items (id, project_id, component_id, quantity, position) VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![r.id()?, r.int("project_id")?, r.int("component_id")?, qty, r.int_or("position", i as i64)?],
        )
        .map_err(|e| r.err(&Error::from(e).to_string()))?;
    }

    for (i, v) in rows(root, "cad_files")?.iter().enumerate() {
        let r = Rec::new(v, "cad_files", i)?;
        let path = r.opt_text("path", 1024)?.filter(|p| !p.is_empty()).ok_or_else(|| r.err("'path' is required"))?;
        let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !crate::cad::ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
            return Err(r.err("only .f3d and .f3z files are supported"));
        }
        let display = r.opt_text("display_name", 200)?.filter(|p| !p.is_empty()).unwrap_or_else(|| path.rsplit(['/', '\\']).next().unwrap_or("file").to_string());
        let notes = match r.v.get("notes") {
            Some(Value::String(s)) => r.wrap(multiline("notes", "Notes", s, 5000))?,
            _ => String::new(),
        };
        tx.execute(
            &format!(
                "INSERT INTO cad_files (id, project_id, path, display_name, extension, size_bytes, file_modified_at, notes, added_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8, COALESCE(?9, {now}))"
            ),
            rusqlite::params![
                r.id()?, r.int("project_id")?, path, display, ext, r.v.get("size_bytes").and_then(Value::as_i64),
                r.stamp("file_modified_at")?, notes, r.stamp("added_at")?
            ],
        )
        .map_err(|e| r.err(&Error::from(e).to_string()))?;
    }

    for (i, v) in rows(root, "diagrams")?.iter().enumerate() {
        let r = Rec::new(v, "diagrams", i)?;
        let name = r.wrap(text("name", "Diagram name", r.v.get("name").and_then(Value::as_str).unwrap_or(""), 1, 120))?;
        let doc: Value = match r.v.get("data") {
            Some(Value::String(s)) => serde_json::from_str(s).map_err(|e| r.err(&e.to_string()))?,
            Some(other) => other.clone(),
            None => return Err(r.err("'data' is required")),
        };
        r.wrap(diagrams::validate_document(&doc))?;
        tx.execute(
            &format!(
                "INSERT INTO diagrams (id, project_id, name, data, created_at, updated_at)
                 VALUES (?1,?2,?3,?4, COALESCE(?5, {now}), COALESCE(?6, {now}))"
            ),
            rusqlite::params![r.id()?, r.int("project_id")?, name, serde_json::to_string(&doc)?, r.stamp("created_at")?, r.stamp("updated_at")?],
        )
        .map_err(|e| r.err(&Error::from(e).to_string()))?;
    }

    for (i, v) in rows(root, "models")?.iter().enumerate() {
        let r = Rec::new(v, "models", i)?;
        let name = r.wrap(text("name", "Model name", r.v.get("name").and_then(Value::as_str).unwrap_or(""), 1, 120))?;
        let doc: Value = match r.v.get("data") {
            Some(Value::String(s)) => serde_json::from_str(s).map_err(|e| r.err(&e.to_string()))?,
            Some(other) => other.clone(),
            None => return Err(r.err("'data' is required")),
        };
        r.wrap(models3d::validate_document(&doc))?;
        tx.execute(
            &format!(
                "INSERT INTO models3d (id, project_id, name, data, created_at, updated_at)
                 VALUES (?1,?2,?3,?4, COALESCE(?5, {now}), COALESCE(?6, {now}))"
            ),
            rusqlite::params![r.id()?, r.int("project_id")?, name, serde_json::to_string(&doc)?, r.stamp("created_at")?, r.stamp("updated_at")?],
        )
        .map_err(|e| r.err(&Error::from(e).to_string()))?;
    }

    for (i, v) in rows(root, "tasks")?.iter().enumerate() {
        let r = Rec::new(v, "tasks", i)?;
        let input: TaskInput = r.parse()?;
        let t = r.wrap(tasks::validate(&input))?;
        tx.execute(
            &format!(
                "INSERT INTO tasks (id, project_id, title, status, priority, due_date, notes, position, completed_at, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, COALESCE(?10, {now}), COALESCE(?11, {now}))"
            ),
            rusqlite::params![
                r.id()?, r.int("project_id")?, t.title, t.status, t.priority, t.due_date, t.notes, r.int_or("position", i as i64)?,
                r.stamp("completed_at")?, r.stamp("created_at")?, r.stamp("updated_at")?
            ],
        )
        .map_err(|e| r.err(&Error::from(e).to_string()))?;
    }

    if let Some(Value::Object(map)) = root.get("settings") {
        for (k, v) in map {
            if let Ok(ok) = settings::validate(k, v) {
                tx.execute("INSERT INTO settings (key, value) VALUES (?1, ?2)", rusqlite::params![k, serde_json::to_string(&ok)?])?;
            }
        }
    }

    let counts = json!({
        "projects": n_projects,
        "components": n_components,
        "bom_items": tx.query_row("SELECT COUNT(*) FROM bom_items", [], |r| r.get::<_, i64>(0))?,
        "tasks": tx.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0))?,
    });
    tx.commit()?;
    Ok(counts)
}

pub fn import_json_file(state: &State, path: &str) -> Result<Value> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(Error::validation("path", "Path must be absolute."));
    }
    let meta = std::fs::metadata(&p).map_err(|_| Error::NotFound("That file could not be opened.".into()))?;
    if !meta.is_file() || meta.len() > MAX_IMPORT_BYTES {
        return Err(Error::validation("path", "That file is not a valid RoboDesk export (or is too large)."));
    }
    let root: Value = serde_json::from_slice(&std::fs::read(&p)?).map_err(|_| Error::validation("file", "That file is not valid JSON."))?;

    // 1) Dry run on a scratch database: catches every validation, reference and uniqueness problem
    //    before the user's real data is touched.
    let scratch = db::open_memory()?;
    apply_import(&scratch, &root)?;

    // 2) Snapshot, then do it for real.
    let safety = snapshot(state, "preimport")?;
    let counts = apply_import(&state.conn, &root)?;
    Ok(json!({ "imported": counts, "safety_backup": safety.name }))
}

// ------------------------------------------------- location, reset, helpers

pub fn read_config(config_dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(config_dir.join("config.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let dir = PathBuf::from(v.get("data_dir")?.as_str()?);
    dir.is_absolute().then_some(dir)
}

fn write_config(config_dir: &Path, data_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let body = serde_json::to_string_pretty(&json!({ "data_dir": data_dir.to_string_lossy() }))?;
    write_atomic(&config_dir.join("config.json"), body.as_bytes())
}

pub fn paths_for(config_dir: &Path, data_dir: &Path) -> Paths {
    Paths {
        config_dir: config_dir.to_path_buf(),
        data_dir: data_dir.to_path_buf(),
        db_path: db::db_path_in(data_dir),
        backup_dir: data_dir.join("backups"),
    }
}

/// Move to a new data folder: copies the current database there and switches over.
/// The old database is left in place as an extra copy. Refuses to overwrite an existing
/// database unless `use_existing` is set (then the existing one is opened as-is).
pub fn set_location(state: &mut State, path: &str, use_existing: bool) -> Result<Value> {
    let dir = PathBuf::from(path);
    if !dir.is_absolute() {
        return Err(Error::validation("path", "Choose an absolute folder path."));
    }
    if dir == state.paths.data_dir {
        return Ok(json!({ "data_dir": path, "changed": false }));
    }
    std::fs::create_dir_all(&dir).map_err(|e| Error::validation("path", format!("That folder cannot be created or used: {e}")))?;
    let new_paths = paths_for(&state.paths.config_dir, &dir);
    let exists = new_paths.db_path.exists();
    if exists && !use_existing {
        return Err(Error::Conflict("A RoboDesk database already exists in that folder. Choose \"use existing data\" to switch to it, or pick another folder.".into()));
    }
    if !exists {
        db::copy_database(&state.conn, &new_paths.db_path)?;
    }
    let new_conn = db::open(&new_paths.db_path, &new_paths.backup_dir)?;
    write_config(&state.paths.config_dir, &dir)?;
    state.conn = new_conn;
    state.paths = new_paths;
    Ok(json!({ "data_dir": path, "changed": true, "used_existing": exists }))
}

/// Erase all projects, parts and everything attached to them. Requires the exact confirmation text.
pub fn reset_all(state: &State, confirm: &str) -> Result<Value> {
    if confirm != RESET_CONFIRMATION {
        return Err(Error::validation("confirm", format!("Type {RESET_CONFIRMATION} to confirm.")));
    }
    let safety = snapshot(state, "prereset")?;
    let tx = state.conn.unchecked_transaction()?;
    tx.execute("DELETE FROM projects", [])?;
    tx.execute("DELETE FROM components", [])?;
    tx.commit()?;
    state.conn.execute_batch("VACUUM")?;
    Ok(json!({ "safety_backup": safety.name }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bom, sample, Core};

    fn core(dir: &Path) -> Core {
        Core::open(dir.join("config"), dir.join("data")).unwrap()
    }

    #[test]
    fn backup_restore_roundtrip_with_safety_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.call("projects.create", json!({"input": {"name": "Keep me"}})).unwrap();
        let b = core.call("data.backup", json!({})).unwrap();
        let name = b["name"].as_str().unwrap().to_string();

        core.call("projects.create", json!({"input": {"name": "Added later"}})).unwrap();
        assert_eq!(core.call("projects.list", json!({})).unwrap().as_array().unwrap().len(), 2);

        let r = core.call("data.restore_backup", json!({"name": name})).unwrap();
        assert!(r["safety_backup"].as_str().unwrap().starts_with("robodesk-prerestore-"));
        let list = core.call("projects.list", json!({})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["name"], "Keep me");

        // the app keeps working on the restored database
        core.call("projects.create", json!({"input": {"name": "After restore"}})).unwrap();
        assert!(core.call("data.restore_backup", json!({"name": "../../etc/passwd"})).is_err());
        assert!(core.call("data.restore_backup", json!({"name": "robodesk-backup-19990101-000000.db"})).is_err());
    }

    #[test]
    fn backups_are_pruned_to_keep_setting() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.call("settings.set", json!({"key": "backup_keep", "value": 2})).unwrap();
        for _ in 0..4 {
            core.call("data.backup", json!({})).unwrap();
        }
        let list = core.call("data.list_backups", json!({})).unwrap();
        assert_eq!(list.as_array().unwrap().iter().filter(|b| b["kind"] == "backup").count(), 2);
    }

    #[test]
    fn export_then_import_reproduces_everything() {
        let dir = tempfile::tempdir().unwrap();
        let a = core(&dir.path().join("a"));
        {
            let st = a.state();
            sample::load(&st.conn).unwrap();
            bom::set_costs(&st.conn, 1, 825, 123).unwrap();
        }
        let file = dir.path().join("export.json");
        a.call("data.export_json", json!({"path": file.to_string_lossy()})).unwrap();

        let b = core(&dir.path().join("b"));
        b.call("projects.create", json!({"input": {"name": "Will be replaced"}})).unwrap();
        let res = b.call("data.import_json", json!({"path": file.to_string_lossy()})).unwrap();
        assert_eq!(res["imported"]["projects"], 2);
        assert_eq!(res["imported"]["components"], 10);
        assert!(res["safety_backup"].as_str().unwrap().starts_with("robodesk-preimport-"));

        // Same content: a second export of b equals the first export (apart from timestamp).
        let mut ea = export_value(&a.state().conn).unwrap();
        let mut eb = export_value(&b.state().conn).unwrap();
        ea["exported_at"] = Value::Null;
        eb["exported_at"] = Value::Null;
        assert_eq!(ea, eb);
        let costs = b.call("bom.get", json!({"project_id": 1})).unwrap();
        assert_eq!(costs["shipping_cents"], 123);
        assert!(!b.call("projects.list", json!({})).unwrap().to_string().contains("Will be replaced"));
    }

    #[test]
    fn bad_import_leaves_data_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.call("projects.create", json!({"input": {"name": "Precious"}})).unwrap();

        let cases = [
            json!({"format": "something-else"}),
            json!({"format": EXPORT_FORMAT, "version": 99}),
            json!({"format": EXPORT_FORMAT, "version": 1, "projects": [{"id": 1, "name": ""}]}),
            json!({"format": EXPORT_FORMAT, "version": 1, "projects": [{"id": 1, "name": "A", "status": "bogus"}]}),
            // dangling reference
            json!({"format": EXPORT_FORMAT, "version": 1, "projects": [{"id": 1, "name": "A"}], "tasks": [{"id": 1, "project_id": 77, "title": "x"}]}),
            // duplicate ids
            json!({"format": EXPORT_FORMAT, "version": 1, "projects": [{"id": 1, "name": "A"}, {"id": 1, "name": "B"}]}),
        ];
        for (i, c) in cases.iter().enumerate() {
            let f = dir.path().join(format!("bad{i}.json"));
            std::fs::write(&f, c.to_string()).unwrap();
            assert!(core.call("data.import_json", json!({"path": f.to_string_lossy()})).is_err(), "case {i} should fail");
        }
        let notjson = dir.path().join("x.json");
        std::fs::write(&notjson, "{{{").unwrap();
        assert!(core.call("data.import_json", json!({"path": notjson.to_string_lossy()})).is_err());

        let list = core.call("projects.list", json!({})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["name"], "Precious");
    }

    #[test]
    fn location_change_copies_data_and_persists_config() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config");
        let def = dir.path().join("default");
        let target = dir.path().join("elsewhere");
        {
            let core = Core::open(cfg.clone(), def.clone()).unwrap();
            core.call("projects.create", json!({"input": {"name": "Moves along"}})).unwrap();
            let r = core.call("data.set_location", json!({"path": target.to_string_lossy()})).unwrap();
            assert_eq!(r["changed"], true);
            core.call("projects.create", json!({"input": {"name": "Written after move"}})).unwrap();
            // moving onto an existing database needs explicit consent, and a refusal changes nothing
            let refused = core.call("data.set_location", json!({"path": def.to_string_lossy()}));
            assert_eq!(refused.unwrap_err().code(), "conflict");
            core.call("projects.create", json!({"input": {"name": "Still on the new location"}})).unwrap();
        }
        // reopening picks up the configured location
        let core = Core::open(cfg, def).unwrap();
        let list = core.call("projects.list", json!({})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 3);
        assert!(target.join("robodesk.db").exists());
        let info = core.call("app.info", json!({})).unwrap();
        assert_eq!(info["data_dir"], target.to_string_lossy().to_string());
    }

    #[test]
    fn unavailable_location_falls_back_without_touching_config() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config");
        std::fs::create_dir_all(&cfg).unwrap();
        // point config at a path that cannot be created (a file is in the way)
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let bad = blocker.join("sub");
        write_config(&cfg, &bad).unwrap();
        let core = Core::open(cfg.clone(), dir.path().join("default")).unwrap();
        let info = core.call("app.info", json!({})).unwrap();
        assert!(info["startup_warning"].as_str().unwrap().contains("could not be opened"));
        assert_eq!(read_config(&cfg), Some(bad));
    }

    #[test]
    fn reset_requires_confirmation_and_takes_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        core.call("projects.create", json!({"input": {"name": "Doomed"}})).unwrap();
        assert!(core.call("data.reset_all", json!({"confirm": "yes"})).is_err());
        assert_eq!(core.call("projects.list", json!({})).unwrap().as_array().unwrap().len(), 1);
        let r = core.call("data.reset_all", json!({"confirm": RESET_CONFIRMATION})).unwrap();
        assert_eq!(core.call("projects.list", json!({})).unwrap().as_array().unwrap().len(), 0);
        // and the snapshot can bring it back
        core.call("data.restore_backup", json!({"name": r["safety_backup"]})).unwrap();
        assert_eq!(core.call("projects.list", json!({})).unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn export_paths_are_validated() {
        let dir = tempfile::tempdir().unwrap();
        let core = core(dir.path());
        assert!(core.call("data.export_json", json!({"path": "relative.json"})).is_err());
        assert!(core.call("data.export_json", json!({"path": dir.path().join("x.txt").to_string_lossy()})).is_err());
        assert!(core.call("data.export_json", json!({"path": dir.path().join("nope").join("x.json").to_string_lossy()})).is_err());
    }
}
