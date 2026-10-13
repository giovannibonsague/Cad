//! RoboDesk core: everything except the window. The Tauri shell (src-tauri) owns one
//! [`Core`] and forwards named commands to [`Core::dispatch`]; unit tests and the
//! headless dev bridge use exactly the same entry point.

pub mod bom;
pub mod cad;
pub mod components;
pub mod dashboard;
pub mod data;
pub mod db;
pub mod diagrams;
pub mod error;
pub mod migrations;
pub mod models3d;
pub mod projects;
pub mod sample;
pub mod settings;
pub mod tasks;
pub mod util;

use error::{ApiError, Error, Result};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use util::*;

#[derive(Debug, Clone)]
pub struct Paths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub backup_dir: PathBuf,
}

pub struct State {
    pub conn: Connection,
    pub paths: Paths,
}

pub struct Core {
    state: Mutex<State>,
    startup_warning: Option<String>,
}

fn ok<T: Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

/// Validate a link before handing it to the operating system's browser.
pub fn checked_url(url: &str) -> Result<String> {
    let u = http_url("url", "Link", url)?;
    if u.is_empty() {
        return Err(Error::validation("url", "There is no link to open."));
    }
    Ok(u)
}

impl Core {
    /// Open the database in the configured data folder, or in `default_data_dir`.
    ///
    /// If a custom folder is configured but cannot be opened (drive unplugged, permissions),
    /// the default folder is used for this session and a warning is exposed through
    /// `app.info`. The saved configuration is left alone so nothing is lost or re-pointed.
    pub fn open(config_dir: PathBuf, default_data_dir: PathBuf) -> Result<Core> {
        let configured = data::read_config(&config_dir);
        let wanted = configured.clone().unwrap_or_else(|| default_data_dir.clone());
        let paths = data::paths_for(&config_dir, &wanted);
        let mut warning = None;
        let (conn, paths) = match db::open(&paths.db_path, &paths.backup_dir) {
            Ok(c) => (c, paths),
            Err(e) if configured.is_some() => {
                warning = Some(format!(
                    "Your data folder \"{}\" could not be opened ({e}). RoboDesk is using the default location for now; \
                     the data in your folder has not been touched. Reconnect the folder and restart, or choose a new location in Settings.",
                    wanted.display()
                ));
                let p = data::paths_for(&config_dir, &default_data_dir);
                (db::open(&p.db_path, &p.backup_dir)?, p)
            }
            Err(e) => return Err(e),
        };
        Ok(Core { state: Mutex::new(State { conn, paths }), startup_warning: warning })
    }

    pub fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Entry point used by the UI: errors are converted to their JSON wire format.
    pub fn dispatch(&self, cmd: &str, args: Value) -> std::result::Result<Value, ApiError> {
        self.call(cmd, args).map_err(ApiError::from)
    }

    pub fn call(&self, cmd: &str, args: Value) -> Result<Value> {
        let mut st = self.state();
        let a = &args;
        match cmd {
            // ---------------------------------------------------------- app
            "app.info" => Ok(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "data_dir": st.paths.data_dir.to_string_lossy(),
                "db_path": st.paths.db_path.to_string_lossy(),
                "backup_dir": st.paths.backup_dir.to_string_lossy(),
                "schema_version": migrations::current_version(&st.conn)?,
                "sample_loaded": sample::is_loaded(&st.conn)?,
                "startup_warning": self.startup_warning,
            })),
            "app.meta" => Ok(json!({
                "project_statuses": PROJECT_STATUSES,
                "task_statuses": TASK_STATUSES,
                "task_priorities": TASK_PRIORITIES,
                "categories": COMPONENT_CATEGORIES,
                "themes": settings::THEMES,
                "reset_confirmation": data::RESET_CONFIRMATION,
            })),
            "dashboard.get" => dashboard::get(&st.conn),

            // ----------------------------------------------------- projects
            "projects.list" => ok(projects::list(
                &st.conn,
                arg_opt::<String>(a, "search")?.as_deref(),
                arg_or(a, "include_archived", false)?,
                arg_or(a, "archived_only", false)?,
            )?),
            "projects.get" => ok(projects::get(&st.conn, arg(a, "id")?)?),
            "projects.create" => ok(projects::create(&st.conn, arg(a, "input")?)?),
            "projects.update" => ok(projects::update(&st.conn, arg(a, "id")?, arg(a, "input")?)?),
            "projects.duplicate" => ok(projects::duplicate(&st.conn, arg(a, "id")?)?),
            "projects.set_archived" => ok(projects::set_archived(&st.conn, arg(a, "id")?, arg(a, "archived")?)?),
            "projects.delete" => {
                projects::delete(&st.conn, arg(a, "id")?)?;
                Ok(json!({ "deleted": true }))
            }

            // --------------------------------------------------- components
            "components.list" => ok(components::list(
                &st.conn,
                arg_opt::<String>(a, "search")?.as_deref(),
                arg_opt::<String>(a, "category")?.as_deref(),
            )?),
            "components.get" => ok(components::get(&st.conn, arg(a, "id")?)?),
            "components.create" => ok(components::create(&st.conn, arg(a, "input")?)?),
            "components.update" => ok(components::update(&st.conn, arg(a, "id")?, arg(a, "input")?)?),
            "components.usage" => ok(components::usage(&st.conn, arg(a, "id")?)?),
            "components.delete" => {
                components::delete(&st.conn, arg(a, "id")?, arg_or(a, "force", false)?)?;
                Ok(json!({ "deleted": true }))
            }
            "components.open_datasheet" => {
                let c = components::get(&st.conn, arg(a, "id")?)?;
                Ok(json!(checked_url(&c.datasheet_url)?))
            }

            // ---------------------------------------------------------- bom
            "bom.get" => ok(bom::get(&st.conn, arg(a, "project_id")?)?),
            "bom.add" => ok(bom::add(&st.conn, arg(a, "project_id")?, arg(a, "component_id")?, arg_or(a, "quantity", 1)?)?),
            "bom.set_quantity" => ok(bom::set_quantity(&st.conn, arg(a, "line_id")?, arg(a, "quantity")?)?),
            "bom.remove" => ok(bom::remove(&st.conn, arg(a, "line_id")?)?),
            "bom.set_costs" => ok(bom::set_costs(&st.conn, arg(a, "project_id")?, arg(a, "tax_bp")?, arg(a, "shipping_cents")?)?),
            "bom.export_csv" => data::export_bom_csv(&st.conn, arg(a, "project_id")?, &arg::<String>(a, "path")?),

            // ---------------------------------------------------------- cad
            "cad.list" => ok(cad::list(&st.conn, arg_opt(a, "project_id")?)?),
            "cad.register" => ok(cad::register(&st.conn, arg(a, "project_id")?, &arg::<Vec<String>>(a, "paths")?)?),
            "cad.update" => ok(cad::update(&st.conn, arg(a, "id")?, &arg::<String>(a, "display_name")?, &arg_or(a, "notes", String::new())?)?),
            "cad.relocate" => ok(cad::relocate(&st.conn, arg(a, "id")?, &arg::<String>(a, "path")?)?),
            "cad.remove" => {
                cad::remove(&st.conn, arg(a, "id")?)?;
                Ok(json!({ "removed": true }))
            }
            "cad.resolve_open" => Ok(json!(cad::resolve_for_open(&st.conn, arg(a, "id")?)?)),

            // ------------------------------------------------------ diagrams
            "diagrams.list" => ok(diagrams::list(&st.conn, arg(a, "project_id")?)?),
            "diagrams.get" => ok(diagrams::get(&st.conn, arg(a, "id")?)?),
            "diagrams.create" => ok(diagrams::create(&st.conn, arg(a, "project_id")?, &arg::<String>(a, "name")?, arg_opt(a, "data")?)?),
            "diagrams.save" => ok(diagrams::save(&st.conn, arg(a, "id")?, &arg::<Value>(a, "data")?, arg_opt::<String>(a, "name")?.as_deref())?),
            "diagrams.delete" => {
                diagrams::delete(&st.conn, arg(a, "id")?)?;
                Ok(json!({ "deleted": true }))
            }

            // -------------------------------------------------------- 3D models
            "models.list" => ok(models3d::list(&st.conn, arg(a, "project_id")?)?),
            "models.get" => ok(models3d::get(&st.conn, arg(a, "id")?)?),
            "models.create" => ok(models3d::create(&st.conn, arg(a, "project_id")?, &arg::<String>(a, "name")?, arg_opt(a, "data")?)?),
            "models.save" => ok(models3d::save(&st.conn, arg(a, "id")?, &arg::<Value>(a, "data")?, arg_opt::<String>(a, "name")?.as_deref())?),
            "models.delete" => {
                models3d::delete(&st.conn, arg(a, "id")?)?;
                Ok(json!({ "deleted": true }))
            }
            "models.export_mesh" => models3d::export_mesh(&arg::<String>(a, "name")?, &arg::<String>(a, "path")?, &arg::<Vec<f64>>(a, "vertices")?),
            "models.export_stl" => models3d::export_stl(&st.conn, arg(a, "id")?, &arg::<String>(a, "path")?),

            // --------------------------------------------------------- tasks
            "tasks.list" => ok(tasks::list(&st.conn, arg(a, "project_id")?)?),
            "tasks.create" => ok(tasks::create(&st.conn, arg(a, "project_id")?, arg(a, "input")?)?),
            "tasks.update" => ok(tasks::update(&st.conn, arg(a, "id")?, arg(a, "input")?)?),
            "tasks.set_status" => ok(tasks::set_status(&st.conn, arg(a, "id")?, &arg::<String>(a, "status")?)?),
            "tasks.delete" => {
                tasks::delete(&st.conn, arg(a, "id")?)?;
                Ok(json!({ "deleted": true }))
            }
            "tasks.reorder" => ok(tasks::reorder(&st.conn, arg(a, "project_id")?, &arg::<Vec<i64>>(a, "ids")?)?),

            // ----------------------------------------------------- settings
            "settings.get" => settings::get_all(&st.conn),
            "settings.set" => settings::set(&st.conn, &arg::<String>(a, "key")?, &arg::<Value>(a, "value")?),

            // ------------------------------------------------ data & safety
            "data.backup" => ok(data::snapshot(&st, "backup")?),
            "data.list_backups" => ok(data::list_backups(&st.paths)?),
            "data.restore_backup" => data::restore_backup(&mut st, &arg::<String>(a, "name")?),
            "data.export_json" => data::export_json_file(&st.conn, &arg::<String>(a, "path")?),
            "data.import_json" => data::import_json_file(&st, &arg::<String>(a, "path")?),
            "data.set_location" => data::set_location(&mut st, &arg::<String>(a, "path")?, arg_or(a, "use_existing", false)?),
            "data.reset_all" => data::reset_all(&st, &arg::<String>(a, "confirm")?),
            "sample.load" => sample::load(&st.conn),
            "sample.remove" => sample::remove(&st.conn),

            other => Err(Error::Unsupported(format!("Unknown command '{other}'."))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_roundtrip_and_error_shape() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("cfg"), dir.path().join("data")).unwrap();

        let p = core.dispatch("projects.create", json!({"input": {"name": "Hexapod", "status": "in_progress"}})).unwrap();
        assert_eq!(p["name"], "Hexapod");
        assert_eq!(p["stats"]["progress_pct"], 0);

        let err = core.dispatch("projects.create", json!({"input": {"name": "  "}})).unwrap_err();
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("name"));

        let err = core.dispatch("nope.nothing", json!({})).unwrap_err();
        assert_eq!(err.code, "unsupported");

        let err = core.dispatch("projects.get", json!({})).unwrap_err();
        assert_eq!(err.code, "validation", "missing argument is a validation error, not a panic");

        let err = core.dispatch("projects.get", json!({"id": 4242})).unwrap_err();
        assert_eq!(err.code, "not_found");
        let err = core.dispatch("projects.get", json!({"id": "abc"})).unwrap_err();
        assert_eq!(err.code, "validation");
    }

    #[test]
    fn data_survives_reopening_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let (cfg, data) = (dir.path().join("cfg"), dir.path().join("data"));
        {
            let core = Core::open(cfg.clone(), data.clone()).unwrap();
            let p = core.call("projects.create", json!({"input": {"name": "Persistent"}})).unwrap();
            let c = core
                .call("components.create", json!({"input": {"name": "Motor", "category": "motor", "quantity": 2, "unit_price_cents": 1999}}))
                .unwrap();
            core.call("bom.add", json!({"project_id": p["id"], "component_id": c["id"], "quantity": 3})).unwrap();
            core.call("settings.set", json!({"key": "theme", "value": "midnight"})).unwrap();
        }
        let core = Core::open(cfg, data).unwrap();
        let bom = core.call("bom.get", json!({"project_id": 1})).unwrap();
        assert_eq!(bom["subtotal_cents"], 5997);
        assert_eq!(core.call("settings.get", json!({})).unwrap()["theme"], "midnight");
        assert_eq!(core.call("app.info", json!({})).unwrap()["schema_version"], migrations::latest_version());
    }

    #[test]
    fn unicode_and_hostile_text_is_stored_verbatim_and_safely() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("cfg"), dir.path().join("data")).unwrap();
        let nasty = "Robot Ω 机器人 '); DROP TABLE projects;-- <script>alert(1)</script>";
        let p = core.call("projects.create", json!({"input": {"name": nasty}})).unwrap();
        assert_eq!(p["name"], nasty);
        assert_eq!(core.call("projects.list", json!({"search": "DROP TABLE"})).unwrap().as_array().unwrap().len(), 1);
    }
}
