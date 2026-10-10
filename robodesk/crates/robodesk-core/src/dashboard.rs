//! Aggregates for the dashboard page.

use crate::error::Result;
use crate::projects;
use rusqlite::Connection;
use serde_json::{json, Value};

pub fn get(conn: &Connection) -> Result<Value> {
    let (projects_total, projects_archived): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(archived), 0) FROM projects",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let (components, units, inventory_value): (i64, i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(quantity), 0), COALESCE(SUM(quantity * unit_price_cents), 0) FROM components",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let (open_tasks, overdue_tasks): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN t.due_date IS NOT NULL AND t.due_date < date('now','localtime') THEN 1 ELSE 0 END), 0)
         FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.status != 'done' AND p.archived = 0",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    let active = projects::list(conn, None, false, false)?;
    let estimated_cost: i64 = active.iter().map(|p| p.stats.cost_cents).sum();
    let in_progress = active.iter().filter(|p| p.project.status == "in_progress").count() as i64;
    let recent: Vec<_> = active.into_iter().take(6).collect();

    let mut stmt = conn.prepare(
        "SELECT t.id, t.project_id, p.name, t.title, t.status, t.priority, t.due_date,
                CASE WHEN t.due_date < date('now','localtime') THEN 1 ELSE 0 END
         FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.status != 'done' AND t.due_date IS NOT NULL AND p.archived = 0
         ORDER BY t.due_date, t.id LIMIT 6",
    )?;
    let upcoming = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?, "project_id": r.get::<_, i64>(1)?, "project_name": r.get::<_, String>(2)?,
                "title": r.get::<_, String>(3)?, "status": r.get::<_, String>(4)?, "priority": r.get::<_, String>(5)?,
                "due_date": r.get::<_, String>(6)?, "overdue": r.get::<_, i64>(7)? != 0
            }))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(json!({
        "totals": {
            "projects_total": projects_total,
            "projects_active": projects_total - projects_archived,
            "projects_archived": projects_archived,
            "projects_in_progress": in_progress,
            "components": components,
            "component_units": units,
            "inventory_value_cents": inventory_value,
            "estimated_cost_cents": estimated_cost,
            "open_tasks": open_tasks,
            "overdue_tasks": overdue_tasks,
        },
        "recent_projects": recent,
        "upcoming_tasks": upcoming,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bom, components, db, projects::ProjectInput, tasks};

    #[test]
    fn totals_reflect_data_and_exclude_archived_costs() {
        let conn = db::open_memory().unwrap();
        let mk = |n: &str| {
            projects::create(&conn, ProjectInput { name: n.into(), description: String::new(), status: "in_progress".into(), start_date: None, due_date: None, notes: String::new() })
                .unwrap()
                .project
                .id
        };
        let a = mk("A");
        let b = mk("B");
        let part = components::create(
            &conn,
            components::ComponentInput {
                name: "Motor".into(),
                category: "motor".into(),
                manufacturer: String::new(),
                model: String::new(),
                quantity: 4,
                unit_price_cents: 1000,
                voltage: None,
                current: None,
                datasheet_url: String::new(),
                notes: String::new(),
            },
        )
        .unwrap()
        .id;
        bom::add(&conn, a, part, 2).unwrap();
        bom::add(&conn, b, part, 3).unwrap();
        projects::set_archived(&conn, b, true).unwrap();

        let mut t = tasks::TaskInput::titled("late");
        t.due_date = Some("2000-01-01".into());
        tasks::create(&conn, a, t).unwrap();

        let d = get(&conn).unwrap();
        let t = &d["totals"];
        assert_eq!(t["projects_total"], 2);
        assert_eq!(t["projects_active"], 1);
        assert_eq!(t["components"], 1);
        assert_eq!(t["inventory_value_cents"], 4000);
        assert_eq!(t["estimated_cost_cents"], 2000, "archived project's BOM is not counted");
        assert_eq!(t["overdue_tasks"], 1);
        assert_eq!(d["recent_projects"].as_array().unwrap().len(), 1);
        assert_eq!(d["upcoming_tasks"][0]["overdue"], true);
    }
}
