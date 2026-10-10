//! Robot projects: CRUD, duplication, archiving, and per-project statistics.

use crate::bom;
use crate::error::{Error, Result};
use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

fn default_status() -> String {
    "planning".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub status: String,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub notes: String,
    pub archived: bool,
    pub bom_tax_bp: i64,
    pub bom_shipping_cents: i64,
    pub is_sample: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectStats {
    pub bom_lines: i64,
    pub bom_units: i64,
    pub cost_cents: i64,
    pub tasks_total: i64,
    pub tasks_done: i64,
    pub progress_pct: i64,
    pub cad_files: i64,
    pub diagrams: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectSummary {
    #[serde(flatten)]
    pub project: Project,
    pub stats: ProjectStats,
}

const SELECT: &str = "SELECT p.id, p.name, p.description, p.status, p.start_date, p.due_date, p.notes, p.archived,
        p.bom_tax_bp, p.bom_shipping_cents, p.is_sample, p.created_at, p.updated_at,
        (SELECT COUNT(*) FROM bom_items b WHERE b.project_id = p.id),
        (SELECT COALESCE(SUM(b.quantity), 0) FROM bom_items b WHERE b.project_id = p.id),
        (SELECT COALESCE(SUM(b.quantity * c.unit_price_cents), 0)
           FROM bom_items b JOIN components c ON c.id = b.component_id WHERE b.project_id = p.id),
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id),
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done'),
        (SELECT COUNT(*) FROM cad_files f WHERE f.project_id = p.id),
        (SELECT COUNT(*) FROM diagrams d WHERE d.project_id = p.id)
    FROM projects p";

fn map_row(r: &Row) -> rusqlite::Result<ProjectSummary> {
    let tax_bp: i64 = r.get(8)?;
    let shipping: i64 = r.get(9)?;
    let subtotal: i64 = r.get(15)?;
    let tasks_total: i64 = r.get(16)?;
    let tasks_done: i64 = r.get(17)?;
    Ok(ProjectSummary {
        project: Project {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            status: r.get(3)?,
            start_date: r.get(4)?,
            due_date: r.get(5)?,
            notes: r.get(6)?,
            archived: r.get::<_, i64>(7)? != 0,
            bom_tax_bp: tax_bp,
            bom_shipping_cents: shipping,
            is_sample: r.get::<_, i64>(10)? != 0,
            created_at: r.get(11)?,
            updated_at: r.get(12)?,
        },
        stats: ProjectStats {
            bom_lines: r.get(13)?,
            bom_units: r.get(14)?,
            cost_cents: bom::total_cents(subtotal, tax_bp, shipping),
            tasks_total,
            tasks_done,
            progress_pct: progress_pct(tasks_done, tasks_total),
            cad_files: r.get(18)?,
            diagrams: r.get(19)?,
        },
    })
}

/// Completed share of tasks as a rounded whole percentage (0 when there are no tasks).
pub fn progress_pct(done: i64, total: i64) -> i64 {
    if total <= 0 {
        0
    } else {
        (done * 100 + total / 2) / total
    }
}

pub fn validate(input: &ProjectInput) -> Result<ProjectInput> {
    let start = opt_date("start_date", "Start date", &input.start_date)?;
    let due = opt_date("due_date", "Due date", &input.due_date)?;
    if let (Some(s), Some(d)) = (&start, &due) {
        if d < s {
            return Err(Error::validation("due_date", "Due date cannot be before the start date."));
        }
    }
    Ok(ProjectInput {
        name: text("name", "Project name", &input.name, 1, 120)?,
        description: multiline("description", "Description", &input.description, 2000)?,
        status: one_of("status", "Status", &input.status, &PROJECT_STATUSES)?,
        start_date: start,
        due_date: due,
        notes: multiline("notes", "Notes", &input.notes, 20_000)?,
    })
}

pub fn get(conn: &Connection, id: i64) -> Result<ProjectSummary> {
    conn.query_row(&format!("{SELECT} WHERE p.id = ?1"), [id], map_row)
        .optional()?
        .ok_or_else(|| Error::NotFound("Project not found.".into()))
}

/// `include_archived`: false = active only, true = everything. `archived_only` overrides both.
pub fn list(conn: &Connection, search: Option<&str>, include_archived: bool, archived_only: bool) -> Result<Vec<ProjectSummary>> {
    let mut sql = format!("{SELECT} WHERE 1 = 1");
    let mut binds: Vec<String> = Vec::new();
    if archived_only {
        sql.push_str(" AND p.archived = 1");
    } else if !include_archived {
        sql.push_str(" AND p.archived = 0");
    }
    if let Some(s) = search.map(str::trim).filter(|s| !s.is_empty()) {
        binds.push(like_pattern(s));
        sql.push_str(" AND (p.name LIKE ?1 ESCAPE '\\' OR p.description LIKE ?1 ESCAPE '\\')");
    }
    sql.push_str(" ORDER BY p.updated_at DESC, p.id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(binds.iter()), map_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn create(conn: &Connection, input: ProjectInput) -> Result<ProjectSummary> {
    let v = validate(&input)?;
    conn.execute(
        "INSERT INTO projects (name, description, status, start_date, due_date, notes) VALUES (?1,?2,?3,?4,?5,?6)",
        params![v.name, v.description, v.status, v.start_date, v.due_date, v.notes],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, input: ProjectInput) -> Result<ProjectSummary> {
    let v = validate(&input)?;
    let n = conn.execute(
        &format!(
            "UPDATE projects SET name=?1, description=?2, status=?3, start_date=?4, due_date=?5, notes=?6,
                updated_at={NOW_SQL} WHERE id=?7"
        ),
        params![v.name, v.description, v.status, v.start_date, v.due_date, v.notes, id],
    )?;
    if n == 0 {
        return Err(Error::NotFound("Project not found.".into()));
    }
    get(conn, id)
}

pub fn set_archived(conn: &Connection, id: i64, archived: bool) -> Result<ProjectSummary> {
    let n = conn.execute(
        &format!("UPDATE projects SET archived=?1, updated_at={NOW_SQL} WHERE id=?2"),
        params![archived as i64, id],
    )?;
    if n == 0 {
        return Err(Error::NotFound("Project not found.".into()));
    }
    get(conn, id)
}

/// Copy a project with its BOM, tasks, CAD references and diagrams. Tasks restart as "todo".
pub fn duplicate(conn: &Connection, id: i64) -> Result<ProjectSummary> {
    let src = get(conn, id)?.project;
    let mut name = format!("{} (copy)", src.name);
    if name.chars().count() > 120 {
        name = format!("{}… (copy)", src.name.chars().take(100).collect::<String>());
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO projects (name, description, status, start_date, due_date, notes, bom_tax_bp, bom_shipping_cents)
         SELECT ?1, description, 'planning', start_date, due_date, notes, bom_tax_bp, bom_shipping_cents
         FROM projects WHERE id = ?2",
        params![name, id],
    )?;
    let new_id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO bom_items (project_id, component_id, quantity, position)
         SELECT ?1, component_id, quantity, position FROM bom_items WHERE project_id = ?2",
        params![new_id, id],
    )?;
    tx.execute(
        "INSERT INTO tasks (project_id, title, status, priority, due_date, notes, position)
         SELECT ?1, title, 'todo', priority, due_date, notes, position FROM tasks WHERE project_id = ?2",
        params![new_id, id],
    )?;
    tx.execute(
        "INSERT INTO cad_files (project_id, path, display_name, extension, size_bytes, file_modified_at, notes)
         SELECT ?1, path, display_name, extension, size_bytes, file_modified_at, notes FROM cad_files WHERE project_id = ?2",
        params![new_id, id],
    )?;
    tx.execute(
        "INSERT INTO diagrams (project_id, name, data) SELECT ?1, name, data FROM diagrams WHERE project_id = ?2",
        params![new_id, id],
    )?;
    tx.commit()?;
    get(conn, new_id)
}

/// Permanently delete a project and everything that belongs to it (BOM lines, tasks,
/// diagrams, CAD *references*). Original CAD files on disk are never touched.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    let n = conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(Error::NotFound("Project not found.".into()));
    }
    Ok(())
}

/// Mark a project as modified (used when its children change).
pub fn touch(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(&format!("UPDATE projects SET updated_at = {NOW_SQL} WHERE id = ?1"), [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn input(name: &str) -> ProjectInput {
        ProjectInput {
            name: name.into(),
            description: "d".into(),
            status: "planning".into(),
            start_date: Some("2026-01-10".into()),
            due_date: Some("2026-03-01".into()),
            notes: String::new(),
        }
    }

    #[test]
    fn crud_lifecycle() {
        let conn = db::open_memory().unwrap();
        let p = create(&conn, input("  Line follower ")).unwrap();
        assert_eq!(p.project.name, "Line follower");
        assert_eq!(p.stats.progress_pct, 0);

        let mut upd = input("Line follower v2");
        upd.status = "testing".into();
        let u = update(&conn, p.project.id, upd).unwrap();
        assert_eq!(u.project.status, "testing");

        let a = set_archived(&conn, p.project.id, true).unwrap();
        assert!(a.project.archived);
        assert!(list(&conn, None, false, false).unwrap().is_empty());
        assert_eq!(list(&conn, None, true, false).unwrap().len(), 1);
        assert_eq!(list(&conn, None, false, true).unwrap().len(), 1);

        delete(&conn, p.project.id).unwrap();
        assert!(matches!(get(&conn, p.project.id), Err(Error::NotFound(_))));
        assert!(matches!(delete(&conn, p.project.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn validation_rules() {
        let conn = db::open_memory().unwrap();
        assert!(create(&conn, input("")).is_err());
        let mut bad = input("x");
        bad.status = "weird".into();
        assert!(create(&conn, bad).is_err());
        let mut bad = input("x");
        bad.start_date = Some("2026-02-30".into());
        assert!(create(&conn, bad).is_err());
        let mut bad = input("x");
        bad.due_date = Some("2025-12-31".into());
        assert_eq!(create(&conn, bad).unwrap_err().code(), "validation");
        let mut ok = input("x");
        ok.start_date = Some(String::new());
        assert!(create(&conn, ok).unwrap().project.start_date.is_none());
    }

    #[test]
    fn progress_rounding() {
        assert_eq!(progress_pct(0, 0), 0);
        assert_eq!(progress_pct(1, 3), 33);
        assert_eq!(progress_pct(2, 3), 67);
        assert_eq!(progress_pct(3, 3), 100);
    }

    #[test]
    fn duplicate_copies_children_and_resets_tasks() {
        let conn = db::open_memory().unwrap();
        let p = create(&conn, input("Arm")).unwrap().project.id;
        let c = crate::components::create(
            &conn,
            crate::components::ComponentInput {
                name: "Servo".into(),
                category: "motor".into(),
                manufacturer: String::new(),
                model: String::new(),
                quantity: 5,
                unit_price_cents: 1000,
                voltage: None,
                current: None,
                datasheet_url: String::new(),
                notes: String::new(),
            },
        )
        .unwrap()
        .id;
        bom::add(&conn, p, c, 3).unwrap();
        let t = crate::tasks::create(&conn, p, crate::tasks::TaskInput::titled("Print base")).unwrap();
        crate::tasks::set_status(&conn, t.id, "done").unwrap();

        let copy = duplicate(&conn, p).unwrap();
        assert_ne!(copy.project.id, p);
        assert_eq!(copy.project.name, "Arm (copy)");
        assert_eq!(copy.stats.bom_units, 3);
        assert_eq!(copy.stats.cost_cents, 3000);
        assert_eq!(copy.stats.tasks_total, 1);
        assert_eq!(copy.stats.tasks_done, 0, "duplicated tasks start over");
        // original untouched
        assert_eq!(get(&conn, p).unwrap().stats.tasks_done, 1);
    }

    #[test]
    fn delete_cascades_to_children_but_not_parts() {
        let conn = db::open_memory().unwrap();
        let p = create(&conn, input("Arm")).unwrap().project.id;
        conn.execute("INSERT INTO components (name) VALUES ('Bolt')", []).unwrap();
        let c = conn.last_insert_rowid();
        bom::add(&conn, p, c, 1).unwrap();
        crate::tasks::create(&conn, p, crate::tasks::TaskInput::titled("t")).unwrap();
        delete(&conn, p).unwrap();
        let n = |t: &str| -> i64 { conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)).unwrap() };
        assert_eq!(n("bom_items"), 0);
        assert_eq!(n("tasks"), 0);
        assert_eq!(n("components"), 1);
    }
}
