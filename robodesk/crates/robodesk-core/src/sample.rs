//! Optional sample data. Rows are flagged `is_sample = 1` so they can be removed in one
//! click, and nothing here runs unless the user asks for it.

use crate::error::{Error, Result};
use crate::{bom, components::ComponentInput, diagrams, projects::ProjectInput, tasks::TaskInput};
use crate::{components, projects, tasks};
use rusqlite::Connection;
use serde_json::{json, Value};

pub fn is_loaded(conn: &Connection) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM projects WHERE is_sample = 1) + (SELECT COUNT(*) FROM components WHERE is_sample = 1)",
        [],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn part(name: &str, cat: &str, maker: &str, model: &str, qty: i64, cents: i64, v: Option<f64>, a: Option<f64>, url: &str) -> ComponentInput {
    ComponentInput {
        name: name.into(),
        category: cat.into(),
        manufacturer: maker.into(),
        model: model.into(),
        quantity: qty,
        unit_price_cents: cents,
        voltage: v,
        current: a,
        datasheet_url: url.into(),
        notes: String::new(),
    }
}

fn pin(id: &str, name: &str, side: &str) -> Value {
    json!({ "id": id, "name": name, "side": side })
}

pub fn load(conn: &Connection) -> Result<Value> {
    if is_loaded(conn)? {
        return Err(Error::Conflict("Sample data is already loaded. Remove it first to load it again.".into()));
    }
    let tx = conn.unchecked_transaction()?;

    let specs = [
        part("Arduino Nano", "controller", "Arduino", "A000005", 3, 2400, Some(5.0), Some(0.02), ""),
        part("TB6612FNG Motor Driver", "driver", "Pololu", "713", 4, 995, Some(12.0), Some(1.2), ""),
        part("N20 Gear Motor 6V 100RPM", "motor", "Generic", "N20-100", 8, 450, Some(6.0), Some(0.25), ""),
        part("HC-SR04 Ultrasonic Sensor", "sensor", "Generic", "HC-SR04", 5, 275, Some(5.0), Some(0.015), ""),
        part("QTR-8A Reflectance Array", "sensor", "Pololu", "960", 2, 1295, Some(5.0), Some(0.1), ""),
        part("18650 Li-ion Cell 3000mAh", "battery", "Samsung", "30Q", 6, 599, Some(3.7), None, ""),
        part("2S 18650 Battery Holder", "battery", "Generic", "BH-2S", 3, 249, None, None, ""),
        part("Aluminium Extrusion 2020 (300 mm)", "structural", "Misumi", "HFS5-2020-300", 12, 410, None, None, ""),
        part("M3 x 8 mm Socket Screws (100 pk)", "fastener", "Generic", "M3x8", 4, 699, None, None, ""),
        part("SG90 Micro Servo", "motor", "TowerPro", "SG90", 6, 350, Some(5.0), Some(0.5), ""),
    ];
    let mut ids = Vec::new();
    for s in specs {
        let c = components::create(&tx, s)?;
        tx.execute("UPDATE components SET is_sample = 1 WHERE id = ?1", [c.id])?;
        ids.push(c.id);
    }

    let mk = |name: &str, desc: &str, status: &str, start: &str, due: &str| -> Result<i64> {
        let p = projects::create(
            &tx,
            ProjectInput {
                name: name.into(),
                description: desc.into(),
                status: status.into(),
                start_date: Some(start.into()),
                due_date: Some(due.into()),
                notes: String::new(),
            },
        )?;
        tx.execute("UPDATE projects SET is_sample = 1 WHERE id = ?1", [p.project.id])?;
        Ok(p.project.id)
    };

    // Project 1: line follower
    let lf = mk("Line Follower Mk1", "Two-wheel differential-drive robot following a black line with an 8-channel reflectance array.", "in_progress", "2026-09-01", "2026-11-15")?;
    for (idx, qty) in [(0usize, 1i64), (1, 1), (2, 2), (4, 1), (5, 2), (6, 1), (8, 1)] {
        bom::add(&tx, lf, ids[idx], qty)?;
    }
    bom::set_costs(&tx, lf, 825, 499)?;
    let items = [
        ("Design and print chassis", "done", "high", None),
        ("Wire motors to driver", "done", "medium", None),
        ("Calibrate reflectance array", "in_progress", "high", Some("2026-10-20")),
        ("Tune PID line-following loop", "todo", "high", Some("2026-11-01")),
        ("Race-day checklist", "todo", "low", Some("2026-11-14")),
    ];
    for (title, status, prio, due) in items {
        let mut t = TaskInput::titled(title);
        t.status = status.into();
        t.priority = prio.into();
        t.due_date = due.map(String::from);
        tasks::create(&tx, lf, t)?;
    }
    let doc = json!({
        "version": 1,
        "view": { "x": 40, "y": 40, "zoom": 1 },
        "nodes": [
            { "id": "n_bat", "label": "2S Battery", "kind": "battery", "x": 40, "y": 220,
              "pins": [pin("p1", "+7.4V", "right"), pin("p2", "GND", "right")] },
            { "id": "n_mcu", "label": "Arduino Nano", "kind": "controller", "x": 360, "y": 60,
              "pins": [pin("p1", "VIN", "left"), pin("p2", "GND", "left"), pin("p3", "D5 PWMA", "right"), pin("p4", "D6 PWMB", "right"), pin("p5", "A0", "bottom")] },
            { "id": "n_drv", "label": "TB6612FNG", "kind": "driver", "x": 700, "y": 60,
              "pins": [pin("p1", "VM", "left"), pin("p2", "GND", "left"), pin("p3", "PWMA", "left"), pin("p4", "PWMB", "left"), pin("p5", "AO1/AO2", "right"), pin("p6", "BO1/BO2", "right")] },
            { "id": "n_ml", "label": "Left Motor", "kind": "motor", "x": 1040, "y": 40, "pins": [pin("p1", "M+", "left"), pin("p2", "M-", "left")] },
            { "id": "n_mr", "label": "Right Motor", "kind": "motor", "x": 1040, "y": 220, "pins": [pin("p1", "M+", "left"), pin("p2", "M-", "left")] }
        ],
        "wires": [
            { "id": "w1", "from": { "node": "n_bat", "pin": "p1" }, "to": { "node": "n_mcu", "pin": "p1" }, "color": "#e5484d", "label": "7.4V" },
            { "id": "w2", "from": { "node": "n_bat", "pin": "p2" }, "to": { "node": "n_mcu", "pin": "p2" }, "color": "#8b95a7", "label": "" },
            { "id": "w3", "from": { "node": "n_mcu", "pin": "p3" }, "to": { "node": "n_drv", "pin": "p3" }, "color": "#f5c542", "label": "PWM" },
            { "id": "w4", "from": { "node": "n_mcu", "pin": "p4" }, "to": { "node": "n_drv", "pin": "p4" }, "color": "#f5c542", "label": "PWM" },
            { "id": "w5", "from": { "node": "n_drv", "pin": "p5" }, "to": { "node": "n_ml", "pin": "p1" }, "color": "#3b82f6", "label": "" },
            { "id": "w6", "from": { "node": "n_drv", "pin": "p6" }, "to": { "node": "n_mr", "pin": "p1" }, "color": "#3b82f6", "label": "" }
        ]
    });
    diagrams::create(&tx, lf, "Drive train wiring", Some(doc))?;
    let plate = |id: &str, name: &str, shape: &str, pos: [f64; 3], size: [f64; 3], color: &str| {
        serde_json::json!({"id": id, "name": name, "shape": shape, "position": pos, "rotation": [0, 0, 0], "size": size, "color": color, "visible": true})
    };
    let chassis = serde_json::json!({"version": 1, "units": "mm", "objects": [
        plate("o1", "Chassis plate", "box", [0.0, 0.0, 2.0], [120.0, 80.0, 4.0], "#9aa7b8"),
        plate("o2", "Left wheel", "cylinder", [0.0, 0.0, 0.0], [32.0, 32.0, 8.0], "#e5484d"),
        plate("o3", "Caster", "sphere", [50.0, 0.0, 0.0], [12.0, 12.0, 12.0], "#e6edf7"),
    ]});
    let mut chassis = chassis;
    chassis["objects"][1]["position"] = serde_json::json!([-30.0, 44.0, 16.0]);
    chassis["objects"][1]["rotation"] = serde_json::json!([90.0, 0.0, 0.0]);
    chassis["objects"][2]["position"] = serde_json::json!([50.0, 0.0, -4.0]);
    crate::models3d::create(&tx, lf, "Chassis", Some(chassis))?;

    // Project 2: arm
    let arm = mk("Desktop Servo Arm", "Three-axis servo arm for pick-and-place experiments.", "planning", "2026-10-05", "2027-01-31")?;
    for (idx, qty) in [(0usize, 1i64), (9, 4), (7, 3), (8, 1)] {
        bom::add(&tx, arm, ids[idx], qty)?;
    }
    for (title, prio) in [("Model links in CAD", "high"), ("Order servo brackets", "medium"), ("Write inverse kinematics", "medium")] {
        let mut t = TaskInput::titled(title);
        t.priority = prio.into();
        tasks::create(&tx, arm, t)?;
    }

    tx.commit()?;
    Ok(json!({ "projects": 2, "components": 10 }))
}

/// Delete every row flagged as sample data (and, via cascades, what hangs off it).
pub fn remove(conn: &Connection) -> Result<Value> {
    let tx = conn.unchecked_transaction()?;
    let p = tx.execute("DELETE FROM projects WHERE is_sample = 1", [])?;
    let c = tx.execute("DELETE FROM components WHERE is_sample = 1", [])?;
    tx.commit()?;
    Ok(json!({ "projects": p, "components": c }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn load_and_remove_leaves_user_data_alone() {
        let conn = db::open_memory().unwrap();
        let mine = projects::create(
            &conn,
            ProjectInput { name: "Mine".into(), description: String::new(), status: "planning".into(), start_date: None, due_date: None, notes: String::new() },
        )
        .unwrap();
        assert!(!is_loaded(&conn).unwrap());
        load(&conn).unwrap();
        assert!(is_loaded(&conn).unwrap());
        assert!(load(&conn).is_err(), "cannot load twice");
        assert_eq!(projects::list(&conn, None, true, false).unwrap().len(), 3);

        let line = projects::list(&conn, Some("Line Follower"), false, false).unwrap().remove(0);
        assert!(line.stats.cost_cents > 0);
        assert_eq!(line.stats.diagrams, 1);
        assert_eq!(line.stats.progress_pct, 40);

        let gone = remove(&conn).unwrap();
        assert_eq!(gone["projects"], 2);
        assert_eq!(gone["components"], 10);
        assert!(!is_loaded(&conn).unwrap());
        let left = projects::list(&conn, None, true, false).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].project.id, mine.project.id);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM bom_items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }
}
