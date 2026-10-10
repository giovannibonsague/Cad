//! Bill of materials: per-project part lines, exact money math, CSV export.
//!
//! All money is integer cents. Tax is stored in basis points (825 = 8.25 %) and rounded
//! half-up to the nearest cent, so totals are reproducible and never suffer float drift.

use crate::error::{Error, Result};
use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const MAX_LINE_QTY: i64 = 100_000;

#[derive(Debug, Clone, Serialize)]
pub struct BomLine {
    pub id: i64,
    pub component_id: i64,
    pub name: String,
    pub category: String,
    pub manufacturer: String,
    pub model: String,
    pub quantity: i64,
    pub unit_price_cents: i64,
    pub line_total_cents: i64,
    pub in_stock: i64,
    pub shortage: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BomView {
    pub project_id: i64,
    pub project_name: String,
    pub lines: Vec<BomLine>,
    pub total_units: i64,
    pub subtotal_cents: i64,
    pub tax_bp: i64,
    pub tax_cents: i64,
    pub shipping_cents: i64,
    pub total_cents: i64,
    pub shortage_lines: i64,
}

/// `subtotal * tax_bp / 10_000`, rounded half-up. Inputs are non-negative.
pub fn tax_cents(subtotal_cents: i64, tax_bp: i64) -> i64 {
    (subtotal_cents * tax_bp + 5_000) / 10_000
}

pub fn total_cents(subtotal_cents: i64, tax_bp: i64, shipping_cents: i64) -> i64 {
    subtotal_cents + tax_cents(subtotal_cents, tax_bp) + shipping_cents
}

fn project_costs(conn: &Connection, project_id: i64) -> Result<(String, i64, i64)> {
    conn.query_row(
        "SELECT name, bom_tax_bp, bom_shipping_cents FROM projects WHERE id = ?1",
        [project_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()?
    .ok_or_else(|| Error::NotFound("Project not found.".into()))
}

pub fn get(conn: &Connection, project_id: i64) -> Result<BomView> {
    let (project_name, tax_bp, shipping_cents) = project_costs(conn, project_id)?;
    let mut stmt = conn.prepare(
        "SELECT b.id, b.component_id, c.name, c.category, c.manufacturer, c.model,
                b.quantity, c.unit_price_cents, c.quantity
         FROM bom_items b JOIN components c ON c.id = b.component_id
         WHERE b.project_id = ?1
         ORDER BY b.position, b.id",
    )?;
    let lines: Vec<BomLine> = stmt
        .query_map([project_id], |r| {
            let quantity: i64 = r.get(6)?;
            let unit: i64 = r.get(7)?;
            let in_stock: i64 = r.get(8)?;
            Ok(BomLine {
                id: r.get(0)?,
                component_id: r.get(1)?,
                name: r.get(2)?,
                category: r.get(3)?,
                manufacturer: r.get(4)?,
                model: r.get(5)?,
                quantity,
                unit_price_cents: unit,
                line_total_cents: quantity * unit,
                in_stock,
                shortage: (quantity - in_stock).max(0),
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    let subtotal_cents: i64 = lines.iter().map(|l| l.line_total_cents).sum();
    let total_units: i64 = lines.iter().map(|l| l.quantity).sum();
    let tax = tax_cents(subtotal_cents, tax_bp);
    Ok(BomView {
        project_id,
        project_name,
        total_units,
        subtotal_cents,
        tax_bp,
        tax_cents: tax,
        shipping_cents,
        total_cents: subtotal_cents + tax + shipping_cents,
        shortage_lines: lines.iter().filter(|l| l.shortage > 0).count() as i64,
        lines,
    })
}

fn touch(conn: &Connection, project_id: i64) -> Result<()> {
    conn.execute(&format!("UPDATE projects SET updated_at = {NOW_SQL} WHERE id = ?1"), [project_id])?;
    Ok(())
}

/// Add a part to a project's BOM. Adding a part that is already present increases its quantity.
pub fn add(conn: &Connection, project_id: i64, component_id: i64, quantity: i64) -> Result<BomView> {
    int_range("quantity", "Quantity", quantity, 1, MAX_LINE_QTY)?;
    project_costs(conn, project_id)?;
    let exists: Option<i64> = conn
        .query_row("SELECT id FROM components WHERE id = ?1", [component_id], |r| r.get(0))
        .optional()?;
    if exists.is_none() {
        return Err(Error::NotFound("Part not found.".into()));
    }
    conn.execute(
        "INSERT INTO bom_items (project_id, component_id, quantity, position)
         VALUES (?1, ?2, ?3, COALESCE((SELECT MAX(position) + 1 FROM bom_items WHERE project_id = ?1), 0))
         ON CONFLICT(project_id, component_id)
         DO UPDATE SET quantity = MIN(quantity + excluded.quantity, ?4)",
        params![project_id, component_id, quantity, MAX_LINE_QTY],
    )?;
    touch(conn, project_id)?;
    get(conn, project_id)
}

pub fn set_quantity(conn: &Connection, line_id: i64, quantity: i64) -> Result<BomView> {
    int_range("quantity", "Quantity", quantity, 1, MAX_LINE_QTY)?;
    let project_id = line_project(conn, line_id)?;
    conn.execute("UPDATE bom_items SET quantity = ?1 WHERE id = ?2", params![quantity, line_id])?;
    touch(conn, project_id)?;
    get(conn, project_id)
}

pub fn remove(conn: &Connection, line_id: i64) -> Result<BomView> {
    let project_id = line_project(conn, line_id)?;
    conn.execute("DELETE FROM bom_items WHERE id = ?1", [line_id])?;
    touch(conn, project_id)?;
    get(conn, project_id)
}

fn line_project(conn: &Connection, line_id: i64) -> Result<i64> {
    conn.query_row("SELECT project_id FROM bom_items WHERE id = ?1", [line_id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| Error::NotFound("BOM line not found.".into()))
}

pub fn set_costs(conn: &Connection, project_id: i64, tax_bp: i64, shipping_cents: i64) -> Result<BomView> {
    int_range("tax_bp", "Tax rate", tax_bp, 0, 10_000)?;
    int_range("shipping_cents", "Shipping", shipping_cents, 0, 100_000_000)?;
    project_costs(conn, project_id)?;
    conn.execute(
        "UPDATE projects SET bom_tax_bp = ?1, bom_shipping_cents = ?2 WHERE id = ?3",
        params![tax_bp, shipping_cents, project_id],
    )?;
    touch(conn, project_id)?;
    get(conn, project_id)
}

// ---------------------------------------------------------------------- CSV

/// Quote a field per RFC 4180. Text that starts with a spreadsheet formula character is
/// prefixed with an apostrophe so opening the file in Excel can never execute it.
fn csv_field(s: &str) -> String {
    let mut v = s.to_string();
    if matches!(v.chars().next(), Some('=' | '+' | '-' | '@' | '\t' | '\r')) {
        v.insert(0, '\'');
    }
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v
    }
}

fn csv_row(fields: &[String]) -> String {
    let mut row = fields.iter().map(|f| csv_field(f)).collect::<Vec<_>>().join(",");
    row.push_str("\r\n");
    row
}

pub fn to_csv(view: &BomView) -> String {
    let mut out = String::from("\u{FEFF}"); // BOM so Excel detects UTF-8
    out.push_str(&csv_row(&[format!("Bill of Materials: {}", view.project_name)]));
    out.push_str(&csv_row(&[
        "Line".into(),
        "Part".into(),
        "Category".into(),
        "Manufacturer".into(),
        "Model".into(),
        "Quantity".into(),
        "Unit Price".into(),
        "Line Total".into(),
        "In Stock".into(),
        "Shortage".into(),
    ]));
    for (i, l) in view.lines.iter().enumerate() {
        out.push_str(&csv_row(&[
            (i + 1).to_string(),
            l.name.clone(),
            l.category.clone(),
            l.manufacturer.clone(),
            l.model.clone(),
            l.quantity.to_string(),
            fmt_cents(l.unit_price_cents),
            fmt_cents(l.line_total_cents),
            l.in_stock.to_string(),
            l.shortage.to_string(),
        ]));
    }
    let blank = |label: &str, value: String| {
        let mut f = vec![String::new(); 10];
        f[6] = label.to_string();
        f[7] = value;
        csv_row(&f)
    };
    out.push_str(&blank("Subtotal", fmt_cents(view.subtotal_cents)));
    out.push_str(&blank(
        &format!("Tax ({}.{:02}%)", view.tax_bp / 100, view.tax_bp % 100),
        fmt_cents(view.tax_cents),
    ));
    out.push_str(&blank("Shipping", fmt_cents(view.shipping_cents)));
    out.push_str(&blank("Total", fmt_cents(view.total_cents)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{components, db, projects};

    fn setup() -> (Connection, i64) {
        let conn = db::open_memory().unwrap();
        let p = projects::create(
            &conn,
            projects::ProjectInput {
                name: "Rover".into(),
                description: String::new(),
                status: "planning".into(),
                start_date: None,
                due_date: None,
                notes: String::new(),
            },
        )
        .unwrap();
        (conn, p.project.id)
    }

    fn part(conn: &Connection, name: &str, qty: i64, cents: i64) -> i64 {
        components::create(
            conn,
            components::ComponentInput {
                name: name.into(),
                category: "motor".into(),
                manufacturer: String::new(),
                model: String::new(),
                quantity: qty,
                unit_price_cents: cents,
                voltage: None,
                current: None,
                datasheet_url: String::new(),
                notes: String::new(),
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn tax_rounds_half_up() {
        assert_eq!(tax_cents(1000, 825), 83); // 82.5 -> 83
        assert_eq!(tax_cents(999, 825), 82); // 82.4175 -> 82
        assert_eq!(tax_cents(0, 825), 0);
        assert_eq!(tax_cents(12345, 0), 0);
        assert_eq!(tax_cents(10_000, 10_000), 10_000);
    }

    #[test]
    fn totals_are_exact() {
        let (conn, pid) = setup();
        let a = part(&conn, "Motor", 10, 1999); // 19.99
        let b = part(&conn, "Sensor", 0, 333); // 3.33
        add(&conn, pid, a, 3).unwrap();
        let v = add(&conn, pid, b, 7).unwrap();
        // 3*1999 + 7*333 = 5997 + 2331 = 8328
        assert_eq!(v.subtotal_cents, 8328);
        assert_eq!(v.total_units, 10);
        let v = set_costs(&conn, pid, 825, 599).unwrap();
        // tax: 8328*0.0825 = 687.06 -> 687
        assert_eq!(v.tax_cents, 687);
        assert_eq!(v.total_cents, 8328 + 687 + 599);
        // sensors: stock 0, need 7
        let sensor = v.lines.iter().find(|l| l.name == "Sensor").unwrap();
        assert_eq!(sensor.shortage, 7);
        assert_eq!(v.shortage_lines, 1);
    }

    #[test]
    fn adding_twice_merges_and_caps() {
        let (conn, pid) = setup();
        let a = part(&conn, "Motor", 1, 100);
        add(&conn, pid, a, 2).unwrap();
        let v = add(&conn, pid, a, 3).unwrap();
        assert_eq!(v.lines.len(), 1);
        assert_eq!(v.lines[0].quantity, 5);
        let v = add(&conn, pid, a, MAX_LINE_QTY).unwrap();
        assert_eq!(v.lines[0].quantity, MAX_LINE_QTY);
    }

    #[test]
    fn quantity_edit_and_validation() {
        let (conn, pid) = setup();
        let a = part(&conn, "Motor", 1, 250);
        let v = add(&conn, pid, a, 1).unwrap();
        let line = v.lines[0].id;
        let v = set_quantity(&conn, line, 12).unwrap();
        assert_eq!(v.subtotal_cents, 3000);
        assert!(set_quantity(&conn, line, 0).is_err());
        assert!(set_quantity(&conn, line, MAX_LINE_QTY + 1).is_err());
        assert!(set_costs(&conn, pid, 10_001, 0).is_err());
        let v = remove(&conn, line).unwrap();
        assert!(v.lines.is_empty());
        assert_eq!(v.total_cents, 0);
    }

    #[test]
    fn price_change_flows_into_bom() {
        let (conn, pid) = setup();
        let a = part(&conn, "Motor", 1, 1000);
        add(&conn, pid, a, 2).unwrap();
        conn.execute("UPDATE components SET unit_price_cents = 1500 WHERE id = ?1", [a]).unwrap();
        assert_eq!(get(&conn, pid).unwrap().subtotal_cents, 3000);
    }

    #[test]
    fn csv_escapes_and_defuses_formulas() {
        let (conn, pid) = setup();
        let a = part(&conn, "=HYPERLINK(\"x\")", 1, 150);
        let b = part(&conn, "Gear, 20T \"steel\"", 1, 275);
        add(&conn, pid, a, 1).unwrap();
        let v = add(&conn, pid, b, 2).unwrap();
        let csv = to_csv(&v);
        assert!(csv.starts_with('\u{FEFF}'));
        assert!(csv.contains("'=HYPERLINK(\"\"x\"\")") || csv.contains("\"'=HYPERLINK(\"\"x\"\")\""));
        assert!(csv.contains("\"Gear, 20T \"\"steel\"\"\""));
        assert!(csv.contains("Subtotal,7.00") || csv.contains(",Subtotal,7.00"));
        assert!(csv.contains("Total,7.00") || csv.contains(",Total,7.00"));
        assert!(csv.contains("\r\n"));
    }
}
