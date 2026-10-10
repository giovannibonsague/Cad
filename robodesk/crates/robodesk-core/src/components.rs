//! Parts inventory.

use crate::error::{Error, Result};
use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentInput {
    pub name: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default)]
    pub manufacturer: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub quantity: i64,
    #[serde(default)]
    pub unit_price_cents: i64,
    #[serde(default)]
    pub voltage: Option<f64>,
    #[serde(default)]
    pub current: Option<f64>,
    #[serde(default)]
    pub datasheet_url: String,
    #[serde(default)]
    pub notes: String,
}

fn default_category() -> String {
    "other".into()
}

#[derive(Debug, Clone, Serialize)]
pub struct Component {
    pub id: i64,
    pub name: String,
    pub category: String,
    pub manufacturer: String,
    pub model: String,
    pub quantity: i64,
    pub unit_price_cents: i64,
    pub value_cents: i64,
    pub voltage: Option<f64>,
    pub current: Option<f64>,
    pub datasheet_url: String,
    pub notes: String,
    pub is_sample: bool,
    pub used_in_projects: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InventorySummary {
    pub count: i64,
    pub total_units: i64,
    pub total_value_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComponentList {
    pub items: Vec<Component>,
    /// Totals over the rows matching the current filter.
    pub summary: InventorySummary,
}

const SELECT: &str = "SELECT c.id, c.name, c.category, c.manufacturer, c.model, c.quantity, c.unit_price_cents,
        c.voltage, c.current, c.datasheet_url, c.notes, c.is_sample, c.created_at, c.updated_at,
        (SELECT COUNT(DISTINCT b.project_id) FROM bom_items b WHERE b.component_id = c.id) AS used_in
    FROM components c";

fn map_row(r: &Row) -> rusqlite::Result<Component> {
    let quantity: i64 = r.get(5)?;
    let unit: i64 = r.get(6)?;
    Ok(Component {
        id: r.get(0)?,
        name: r.get(1)?,
        category: r.get(2)?,
        manufacturer: r.get(3)?,
        model: r.get(4)?,
        quantity,
        unit_price_cents: unit,
        value_cents: quantity * unit,
        voltage: r.get(7)?,
        current: r.get(8)?,
        datasheet_url: r.get(9)?,
        notes: r.get(10)?,
        is_sample: r.get::<_, i64>(11)? != 0,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
        used_in_projects: r.get(14)?,
    })
}

pub fn validate(input: &ComponentInput) -> Result<ComponentInput> {
    Ok(ComponentInput {
        name: text("name", "Name", &input.name, 1, 120)?,
        category: one_of("category", "Category", &input.category, &COMPONENT_CATEGORIES)?,
        manufacturer: text("manufacturer", "Manufacturer", &input.manufacturer, 0, 120)?,
        model: text("model", "Model", &input.model, 0, 120)?,
        quantity: int_range("quantity", "Quantity", input.quantity, 0, 1_000_000)?,
        unit_price_cents: int_range("unit_price_cents", "Unit price", input.unit_price_cents, 0, 100_000_000)?,
        voltage: opt_float_range("voltage", "Voltage", input.voltage, 0.0, 1000.0)?,
        current: opt_float_range("current", "Current", input.current, 0.0, 1000.0)?,
        datasheet_url: http_url("datasheet_url", "Datasheet link", &input.datasheet_url)?,
        notes: multiline("notes", "Notes", &input.notes, 5000)?,
    })
}

pub fn get(conn: &Connection, id: i64) -> Result<Component> {
    conn.query_row(&format!("{SELECT} WHERE c.id = ?1"), [id], map_row)
        .optional()?
        .ok_or_else(|| Error::NotFound("Part not found.".into()))
}

pub fn list(conn: &Connection, search: Option<&str>, category: Option<&str>) -> Result<ComponentList> {
    let mut sql = format!("{SELECT} WHERE 1 = 1");
    let mut binds: Vec<String> = Vec::new();
    if let Some(s) = search.map(str::trim).filter(|s| !s.is_empty()) {
        binds.push(like_pattern(s));
        let n = binds.len();
        sql.push_str(&format!(
            " AND (c.name LIKE ?{n} ESCAPE '\\' OR c.manufacturer LIKE ?{n} ESCAPE '\\'
                   OR c.model LIKE ?{n} ESCAPE '\\' OR c.notes LIKE ?{n} ESCAPE '\\')"
        ));
    }
    if let Some(cat) = category.map(str::trim).filter(|c| !c.is_empty() && *c != "all") {
        binds.push(cat.to_string());
        sql.push_str(&format!(" AND c.category = ?{}", binds.len()));
    }
    sql.push_str(" ORDER BY c.name COLLATE NOCASE, c.id");
    let mut stmt = conn.prepare(&sql)?;
    let items: Vec<Component> = stmt
        .query_map(rusqlite::params_from_iter(binds.iter()), map_row)?
        .collect::<std::result::Result<_, _>>()?;
    let summary = InventorySummary {
        count: items.len() as i64,
        total_units: items.iter().map(|c| c.quantity).sum(),
        total_value_cents: items.iter().map(|c| c.value_cents).sum(),
    };
    Ok(ComponentList { items, summary })
}

pub fn create(conn: &Connection, input: ComponentInput) -> Result<Component> {
    let v = validate(&input)?;
    conn.execute(
        "INSERT INTO components (name, category, manufacturer, model, quantity, unit_price_cents,
                                voltage, current, datasheet_url, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![v.name, v.category, v.manufacturer, v.model, v.quantity, v.unit_price_cents, v.voltage, v.current, v.datasheet_url, v.notes],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, input: ComponentInput) -> Result<Component> {
    let v = validate(&input)?;
    let n = conn.execute(
        &format!(
            "UPDATE components SET name=?1, category=?2, manufacturer=?3, model=?4, quantity=?5,
                unit_price_cents=?6, voltage=?7, current=?8, datasheet_url=?9, notes=?10,
                updated_at={NOW_SQL}
             WHERE id=?11"
        ),
        params![v.name, v.category, v.manufacturer, v.model, v.quantity, v.unit_price_cents, v.voltage, v.current, v.datasheet_url, v.notes, id],
    )?;
    if n == 0 {
        return Err(Error::NotFound("Part not found.".into()));
    }
    // Projects using this part now cost something different: mark them modified.
    conn.execute(
        &format!("UPDATE projects SET updated_at = {NOW_SQL} WHERE id IN (SELECT project_id FROM bom_items WHERE component_id = ?1)"),
        [id],
    )?;
    get(conn, id)
}

/// Names of projects whose BOM includes this part.
pub fn usage(conn: &Connection, id: i64) -> Result<Vec<String>> {
    get(conn, id)?;
    let mut stmt = conn.prepare(
        "SELECT p.name FROM bom_items b JOIN projects p ON p.id = b.project_id
         WHERE b.component_id = ?1 ORDER BY p.name COLLATE NOCASE",
    )?;
    let names = stmt.query_map([id], |r| r.get(0))?.collect::<std::result::Result<Vec<String>, _>>()?;
    Ok(names)
}

/// Delete a part. If any project's BOM uses it, `force` must be set (the UI asks first);
/// the part is then removed from those BOMs too.
pub fn delete(conn: &Connection, id: i64, force: bool) -> Result<()> {
    let used = usage(conn, id)?;
    if !used.is_empty() && !force {
        return Err(Error::Conflict(format!(
            "This part is used in {} project(s): {}. Deleting it removes it from their BOMs.",
            used.len(),
            used.join(", ")
        )));
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        &format!("UPDATE projects SET updated_at = {NOW_SQL} WHERE id IN (SELECT project_id FROM bom_items WHERE component_id = ?1)"),
        [id],
    )?;
    tx.execute("DELETE FROM components WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn input(name: &str) -> ComponentInput {
        ComponentInput {
            name: name.into(),
            category: "sensor".into(),
            manufacturer: "Acme".into(),
            model: "X1".into(),
            quantity: 4,
            unit_price_cents: 250,
            voltage: Some(5.0),
            current: Some(0.02),
            datasheet_url: "https://example.com/x1.pdf".into(),
            notes: String::new(),
        }
    }

    #[test]
    fn crud_and_inventory_value() {
        let conn = db::open_memory().unwrap();
        let a = create(&conn, input("Ultrasonic")).unwrap();
        let mut m = input("Servo");
        m.category = "motor".into();
        m.quantity = 2;
        m.unit_price_cents = 1299;
        create(&conn, m).unwrap();

        let all = list(&conn, None, None).unwrap();
        assert_eq!(all.summary.count, 2);
        assert_eq!(all.summary.total_units, 6);
        assert_eq!(all.summary.total_value_cents, 4 * 250 + 2 * 1299);

        let motors = list(&conn, None, Some("motor")).unwrap();
        assert_eq!(motors.items.len(), 1);
        assert_eq!(motors.summary.total_value_cents, 2598);

        let found = list(&conn, Some("ultra"), None).unwrap();
        assert_eq!(found.items.len(), 1);
        let none = list(&conn, Some("100%"), None).unwrap();
        assert!(none.items.is_empty(), "% must be escaped, not treated as a wildcard");

        let mut upd = input("Ultrasonic HC-SR04");
        upd.quantity = 10;
        let u = update(&conn, a.id, upd).unwrap();
        assert_eq!(u.name, "Ultrasonic HC-SR04");
        assert_eq!(u.value_cents, 2500);

        delete(&conn, a.id, false).unwrap();
        assert_eq!(list(&conn, None, None).unwrap().items.len(), 1);
        assert!(matches!(get(&conn, a.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn validation() {
        let conn = db::open_memory().unwrap();
        let mut bad = input("");
        assert_eq!(create(&conn, bad.clone()).unwrap_err().code(), "validation");
        bad = input("ok");
        bad.category = "bogus".into();
        assert!(create(&conn, bad).is_err());
        let mut bad = input("ok");
        bad.quantity = -1;
        assert!(create(&conn, bad).is_err());
        let mut bad = input("ok");
        bad.unit_price_cents = -5;
        assert!(create(&conn, bad).is_err());
        let mut bad = input("ok");
        bad.voltage = Some(f64::NAN);
        assert!(create(&conn, bad).is_err());
        let mut bad = input("ok");
        bad.datasheet_url = "javascript:alert(1)".into();
        assert!(create(&conn, bad).is_err());
    }

    #[test]
    fn deleting_a_used_part_needs_force() {
        let conn = db::open_memory().unwrap();
        conn.execute("INSERT INTO projects (name) VALUES ('Arm')", []).unwrap();
        let pid = conn.last_insert_rowid();
        let c = create(&conn, input("Gripper")).unwrap();
        crate::bom::add(&conn, pid, c.id, 2).unwrap();
        assert_eq!(usage(&conn, c.id).unwrap(), vec!["Arm".to_string()]);
        assert_eq!(delete(&conn, c.id, false).unwrap_err().code(), "conflict");
        delete(&conn, c.id, true).unwrap();
        assert!(crate::bom::get(&conn, pid).unwrap().lines.is_empty());
    }
}
