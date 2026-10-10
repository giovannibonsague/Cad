//! Wiring diagrams. The editor state is stored as a JSON document:
//!
//! ```json
//! { "version": 1,
//!   "view":  { "x": 0, "y": 0, "zoom": 1 },
//!   "nodes": [ { "id": "n1", "label": "Arduino Nano", "kind": "controller", "x": 120, "y": 80,
//!                "pins": [ { "id": "p1", "name": "D3", "side": "right" } ] } ],
//!   "wires": [ { "id": "w1", "from": { "node": "n1", "pin": "p1" },
//!                "to": { "node": "n2", "pin": "p2" }, "color": "#e5484d", "label": "PWM" } ] }
//! ```
//!
//! The backend validates structure and references so a corrupt document can never be saved.

use crate::error::{Error, Result};
use crate::projects;
use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_NODES: usize = 500;
const MAX_WIRES: usize = 2000;
const MAX_PINS: usize = 128;

#[derive(Debug, Clone, Serialize)]
pub struct DiagramMeta {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub nodes: i64,
    pub wires: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Diagram {
    #[serde(flatten)]
    pub meta: DiagramMeta,
    pub data: Value,
}

pub fn empty_document() -> Value {
    json!({ "version": 1, "view": { "x": 0, "y": 0, "zoom": 1 }, "nodes": [], "wires": [] })
}

fn is_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn num(v: &Value, key: &str) -> Result<f64> {
    v.get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && n.abs() < 1.0e6)
        .ok_or_else(|| Error::validation("data", format!("Diagram is invalid: '{key}' must be a number.")))
}

fn string<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let s = v
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::validation("data", format!("Diagram is invalid: '{key}' must be text.")))?;
    if s.chars().count() > max || s.chars().any(|c| c.is_control()) {
        return Err(Error::validation("data", format!("Diagram is invalid: '{key}' is too long or has invalid characters.")));
    }
    Ok(s)
}

/// Validate a diagram document; returns the node/wire counts.
pub fn validate_document(doc: &Value) -> Result<(usize, usize)> {
    let bad = |m: &str| Error::validation("data", format!("Diagram is invalid: {m}"));
    if serde_json::to_vec(doc)?.len() > MAX_BYTES {
        return Err(bad("it is too large."));
    }
    let nodes = doc.get("nodes").and_then(Value::as_array).ok_or_else(|| bad("'nodes' must be a list."))?;
    let wires = doc.get("wires").and_then(Value::as_array).ok_or_else(|| bad("'wires' must be a list."))?;
    if nodes.len() > MAX_NODES || wires.len() > MAX_WIRES {
        return Err(bad("too many components or wires."));
    }
    if let Some(view) = doc.get("view") {
        num(view, "x")?;
        num(view, "y")?;
        let z = num(view, "zoom")?;
        if !(0.05..=10.0).contains(&z) {
            return Err(bad("zoom is out of range."));
        }
    }

    let mut pins_by_node: HashMap<&str, HashSet<&str>> = HashMap::new();
    for n in nodes {
        let id = string(n, "id", 64)?;
        string(n, "label", 120)?;
        num(n, "x")?;
        num(n, "y")?;
        if let Some(k) = n.get("kind") {
            if !k.is_string() {
                return Err(bad("'kind' must be text."));
            }
        }
        let pins = n.get("pins").and_then(Value::as_array).ok_or_else(|| bad("a component has no pin list."))?;
        if pins.len() > MAX_PINS {
            return Err(bad("a component has too many pins."));
        }
        let mut pin_ids = HashSet::new();
        for p in pins {
            let pid = string(p, "id", 64)?;
            string(p, "name", 60)?;
            let side = string(p, "side", 10)?;
            if !["left", "right", "top", "bottom"].contains(&side) {
                return Err(bad("pin side must be left, right, top or bottom."));
            }
            if !pin_ids.insert(pid) {
                return Err(bad("duplicate pin id on a component."));
            }
        }
        if pins_by_node.insert(id, pin_ids).is_some() {
            return Err(bad("duplicate component id."));
        }
    }

    let mut wire_ids = HashSet::new();
    for w in wires {
        let id = string(w, "id", 64)?;
        if !wire_ids.insert(id) {
            return Err(bad("duplicate wire id."));
        }
        let color = string(w, "color", 7)?;
        if !is_color(color) {
            return Err(bad("wire colour must look like #rrggbb."));
        }
        if let Some(l) = w.get("label") {
            let s = l.as_str().ok_or_else(|| bad("wire label must be text."))?;
            if s.chars().count() > 60 || s.chars().any(|c| c.is_control()) {
                return Err(bad("wire label is too long."));
            }
        }
        let mut ends = Vec::new();
        for side in ["from", "to"] {
            let e = w.get(side).ok_or_else(|| bad("a wire is missing an endpoint."))?;
            let node = string(e, "node", 64)?;
            let pin = string(e, "pin", 64)?;
            let ok = pins_by_node.get(node).map(|p| p.contains(pin)).unwrap_or(false);
            if !ok {
                return Err(bad("a wire is connected to a pin that does not exist."));
            }
            ends.push((node, pin));
        }
        if ends[0] == ends[1] {
            return Err(bad("a wire cannot connect a pin to itself."));
        }
    }
    Ok((nodes.len(), wires.len()))
}

fn map_meta(r: &Row) -> rusqlite::Result<(DiagramMeta, String)> {
    let data: String = r.get(5)?;
    let (n, w) = serde_json::from_str::<Value>(&data)
        .map(|v| {
            (
                v.get("nodes").and_then(Value::as_array).map_or(0, |a| a.len()) as i64,
                v.get("wires").and_then(Value::as_array).map_or(0, |a| a.len()) as i64,
            )
        })
        .unwrap_or((0, 0));
    Ok((
        DiagramMeta { id: r.get(0)?, project_id: r.get(1)?, name: r.get(2)?, created_at: r.get(3)?, updated_at: r.get(4)?, nodes: n, wires: w },
        data,
    ))
}

const SELECT: &str = "SELECT id, project_id, name, created_at, updated_at, data FROM diagrams";

pub fn list(conn: &Connection, project_id: i64) -> Result<Vec<DiagramMeta>> {
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE project_id = ?1 ORDER BY name COLLATE NOCASE, id"))?;
    let rows = stmt.query_map([project_id], map_meta)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().map(|(m, _)| m).collect())
}

pub fn get(conn: &Connection, id: i64) -> Result<Diagram> {
    let (meta, data) = conn
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], map_meta)
        .optional()?
        .ok_or_else(|| Error::NotFound("Diagram not found.".into()))?;
    Ok(Diagram { meta, data: serde_json::from_str(&data)? })
}

pub fn create(conn: &Connection, project_id: i64, name: &str, data: Option<Value>) -> Result<Diagram> {
    let name = text("name", "Diagram name", name, 1, 120)?;
    projects::get(conn, project_id)?;
    let doc = data.unwrap_or_else(empty_document);
    validate_document(&doc)?;
    conn.execute(
        "INSERT INTO diagrams (project_id, name, data) VALUES (?1, ?2, ?3)",
        params![project_id, name, serde_json::to_string(&doc)?],
    )?;
    let id = conn.last_insert_rowid();
    projects::touch(conn, project_id)?;
    get(conn, id)
}

/// Save editor state (and optionally rename).
pub fn save(conn: &Connection, id: i64, data: &Value, name: Option<&str>) -> Result<DiagramMeta> {
    validate_document(data)?;
    let existing = get(conn, id)?;
    let name = match name {
        Some(n) => text("name", "Diagram name", n, 1, 120)?,
        None => existing.meta.name.clone(),
    };
    conn.execute(
        &format!("UPDATE diagrams SET name = ?1, data = ?2, updated_at = {NOW_SQL} WHERE id = ?3"),
        params![name, serde_json::to_string(data)?, id],
    )?;
    projects::touch(conn, existing.meta.project_id)?;
    Ok(get(conn, id)?.meta)
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    let existing = get(conn, id)?;
    conn.execute("DELETE FROM diagrams WHERE id = ?1", [id])?;
    projects::touch(conn, existing.meta.project_id)?;
    Ok(())
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

    fn doc() -> Value {
        json!({
            "version": 1, "view": {"x": 10, "y": -5, "zoom": 1.25},
            "nodes": [
                {"id":"n1","label":"MCU","kind":"controller","x":0,"y":0,"pins":[{"id":"p1","name":"D3","side":"right"},{"id":"p2","name":"GND","side":"right"}]},
                {"id":"n2","label":"Driver","kind":"driver","x":300,"y":0,"pins":[{"id":"q1","name":"IN1","side":"left"}]}
            ],
            "wires": [ {"id":"w1","from":{"node":"n1","pin":"p1"},"to":{"node":"n2","pin":"q1"},"color":"#e5484d","label":"PWM"} ]
        })
    }

    #[test]
    fn save_and_reload_roundtrip() {
        let conn = db::open_memory().unwrap();
        let p = project(&conn);
        let d = create(&conn, p, "Main harness", None).unwrap();
        assert_eq!(d.meta.nodes, 0);
        let meta = save(&conn, d.meta.id, &doc(), Some("Power + PWM")).unwrap();
        assert_eq!((meta.nodes, meta.wires, meta.name.as_str()), (2, 1, "Power + PWM"));
        let back = get(&conn, d.meta.id).unwrap();
        assert_eq!(back.data, doc());
        assert_eq!(list(&conn, p).unwrap().len(), 1);
        delete(&conn, d.meta.id).unwrap();
        assert!(list(&conn, p).unwrap().is_empty());
    }

    #[test]
    fn rejects_corrupt_documents() {
        let mut d = doc();
        d["wires"][0]["to"]["pin"] = json!("nope");
        assert!(validate_document(&d).is_err(), "dangling pin");

        let mut d = doc();
        d["wires"][0]["color"] = json!("red");
        assert!(validate_document(&d).is_err(), "bad colour");

        let mut d = doc();
        d["wires"][0]["to"] = json!({"node":"n1","pin":"p1"});
        assert!(validate_document(&d).is_err(), "self wire");

        let mut d = doc();
        d["nodes"][1]["id"] = json!("n1");
        assert!(validate_document(&d).is_err(), "duplicate node id");

        let mut d = doc();
        d["nodes"][0]["pins"][0]["side"] = json!("diagonal");
        assert!(validate_document(&d).is_err(), "bad side");

        let mut d = doc();
        d["view"]["zoom"] = json!(500);
        assert!(validate_document(&d).is_err(), "zoom range");

        assert!(validate_document(&json!({"nodes": 3, "wires": []})).is_err());
        assert!(validate_document(&empty_document()).is_ok());
    }
}
