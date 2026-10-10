//! Build planner tasks.

use crate::error::{Error, Result};
use crate::projects;
use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInput {
    pub title: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub notes: String,
}

fn default_status() -> String {
    "todo".into()
}
fn default_priority() -> String {
    "medium".into()
}

impl TaskInput {
    pub fn titled(title: &str) -> Self {
        TaskInput { title: title.into(), status: default_status(), priority: default_priority(), due_date: None, notes: String::new() }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Task {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub status: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub notes: String,
    pub position: i64,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const SELECT: &str = "SELECT id, project_id, title, status, priority, due_date, notes, position, completed_at, created_at, updated_at FROM tasks";

fn map_row(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        status: r.get(3)?,
        priority: r.get(4)?,
        due_date: r.get(5)?,
        notes: r.get(6)?,
        position: r.get(7)?,
        completed_at: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

pub fn validate(input: &TaskInput) -> Result<TaskInput> {
    Ok(TaskInput {
        title: text("title", "Title", &input.title, 1, 200)?,
        status: one_of("status", "Status", &input.status, &TASK_STATUSES)?,
        priority: one_of("priority", "Priority", &input.priority, &TASK_PRIORITIES)?,
        due_date: opt_date("due_date", "Due date", &input.due_date)?,
        notes: multiline("notes", "Notes", &input.notes, 5000)?,
    })
}

pub fn get(conn: &Connection, id: i64) -> Result<Task> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], map_row)
        .optional()?
        .ok_or_else(|| Error::NotFound("Task not found.".into()))
}

pub fn list(conn: &Connection, project_id: i64) -> Result<Vec<Task>> {
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE project_id = ?1 ORDER BY position, id"))?;
    let rows = stmt.query_map([project_id], map_row)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn ensure_project(conn: &Connection, project_id: i64) -> Result<()> {
    projects::get(conn, project_id).map(|_| ())
}

pub fn create(conn: &Connection, project_id: i64, input: TaskInput) -> Result<Task> {
    let v = validate(&input)?;
    ensure_project(conn, project_id)?;
    let done = v.status == "done";
    conn.execute(
        &format!(
            "INSERT INTO tasks (project_id, title, status, priority, due_date, notes, position, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                     COALESCE((SELECT MAX(position) + 1 FROM tasks WHERE project_id = ?1), 0),
                     CASE WHEN ?7 THEN {NOW_SQL} END)"
        ),
        params![project_id, v.title, v.status, v.priority, v.due_date, v.notes, done],
    )?;
    let id = conn.last_insert_rowid();
    projects::touch(conn, project_id)?;
    get(conn, id)
}

pub fn update(conn: &Connection, id: i64, input: TaskInput) -> Result<Task> {
    let v = validate(&input)?;
    let existing = get(conn, id)?;
    let done = v.status == "done";
    conn.execute(
        &format!(
            "UPDATE tasks SET title=?1, status=?2, priority=?3, due_date=?4, notes=?5,
                completed_at = CASE WHEN ?6 THEN COALESCE(completed_at, {NOW_SQL}) ELSE NULL END,
                updated_at = {NOW_SQL}
             WHERE id = ?7"
        ),
        params![v.title, v.status, v.priority, v.due_date, v.notes, done, id],
    )?;
    projects::touch(conn, existing.project_id)?;
    get(conn, id)
}

pub fn set_status(conn: &Connection, id: i64, status: &str) -> Result<Task> {
    let status = one_of("status", "Status", status, &TASK_STATUSES)?;
    let existing = get(conn, id)?;
    let done = status == "done";
    conn.execute(
        &format!(
            "UPDATE tasks SET status=?1,
                completed_at = CASE WHEN ?2 THEN COALESCE(completed_at, {NOW_SQL}) ELSE NULL END,
                updated_at = {NOW_SQL}
             WHERE id = ?3"
        ),
        params![status, done, id],
    )?;
    projects::touch(conn, existing.project_id)?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    let existing = get(conn, id)?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", [id])?;
    projects::touch(conn, existing.project_id)?;
    Ok(())
}

/// Persist a new task order. `ids` must contain exactly the project's task ids.
pub fn reorder(conn: &Connection, project_id: i64, ids: &[i64]) -> Result<Vec<Task>> {
    let current = list(conn, project_id)?;
    let mut have: Vec<i64> = current.iter().map(|t| t.id).collect();
    let mut want: Vec<i64> = ids.to_vec();
    have.sort_unstable();
    want.sort_unstable();
    if have != want {
        return Err(Error::validation("ids", "The task order does not match this project's tasks. Refresh and try again."));
    }
    let tx = conn.unchecked_transaction()?;
    for (pos, id) in ids.iter().enumerate() {
        tx.execute("UPDATE tasks SET position = ?1 WHERE id = ?2 AND project_id = ?3", params![pos as i64, id, project_id])?;
    }
    tx.commit()?;
    projects::touch(conn, project_id)?;
    list(conn, project_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, projects::ProjectInput};

    fn project(conn: &Connection) -> i64 {
        projects::create(
            conn,
            ProjectInput {
                name: "P".into(),
                description: String::new(),
                status: "planning".into(),
                start_date: None,
                due_date: None,
                notes: String::new(),
            },
        )
        .unwrap()
        .project
        .id
    }

    #[test]
    fn lifecycle_and_progress() {
        let conn = db::open_memory().unwrap();
        let p = project(&conn);
        let a = create(&conn, p, TaskInput::titled("Design chassis")).unwrap();
        let b = create(&conn, p, TaskInput::titled("Wire motors")).unwrap();
        let _c = create(&conn, p, TaskInput::titled("Flash firmware")).unwrap();
        assert_eq!((a.position, b.position), (0, 1));
        assert_eq!(projects::get(&conn, p).unwrap().stats.progress_pct, 0);

        let a = set_status(&conn, a.id, "done").unwrap();
        assert!(a.completed_at.is_some());
        assert_eq!(projects::get(&conn, p).unwrap().stats.progress_pct, 33);
        set_status(&conn, b.id, "done").unwrap();
        assert_eq!(projects::get(&conn, p).unwrap().stats.progress_pct, 67);

        let reopened = set_status(&conn, a.id, "in_progress").unwrap();
        assert!(reopened.completed_at.is_none());
        assert_eq!(projects::get(&conn, p).unwrap().stats.progress_pct, 33);

        let mut edit = TaskInput::titled("Design chassis v2");
        edit.priority = "high".into();
        edit.due_date = Some("2026-05-01".into());
        let e = update(&conn, a.id, edit).unwrap();
        assert_eq!((e.title.as_str(), e.priority.as_str()), ("Design chassis v2", "high"));

        delete(&conn, b.id).unwrap();
        assert_eq!(list(&conn, p).unwrap().len(), 2);
    }

    #[test]
    fn reorder_persists_and_rejects_foreign_ids() {
        let conn = db::open_memory().unwrap();
        let p = project(&conn);
        let q = project(&conn);
        let a = create(&conn, p, TaskInput::titled("a")).unwrap().id;
        let b = create(&conn, p, TaskInput::titled("b")).unwrap().id;
        let c = create(&conn, p, TaskInput::titled("c")).unwrap().id;
        let other = create(&conn, q, TaskInput::titled("x")).unwrap().id;

        let out = reorder(&conn, p, &[c, a, b]).unwrap();
        assert_eq!(out.iter().map(|t| t.id).collect::<Vec<_>>(), vec![c, a, b]);
        assert!(reorder(&conn, p, &[a, b]).is_err(), "missing id");
        assert!(reorder(&conn, p, &[a, b, other]).is_err(), "foreign id");
        // order unchanged after rejected attempts
        assert_eq!(list(&conn, p).unwrap().iter().map(|t| t.id).collect::<Vec<_>>(), vec![c, a, b]);
    }

    #[test]
    fn validation() {
        let conn = db::open_memory().unwrap();
        let p = project(&conn);
        assert!(create(&conn, p, TaskInput::titled("  ")).is_err());
        let mut bad = TaskInput::titled("x");
        bad.priority = "urgent".into();
        assert!(create(&conn, p, bad).is_err());
        let mut bad = TaskInput::titled("x");
        bad.due_date = Some("tomorrow".into());
        assert!(create(&conn, p, bad).is_err());
        assert!(create(&conn, 9999, TaskInput::titled("x")).is_err());
        let t = create(&conn, p, TaskInput::titled("ok")).unwrap();
        assert!(set_status(&conn, t.id, "finished").is_err());
    }
}
