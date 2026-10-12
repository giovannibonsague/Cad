//! 3D models: simple parametric solids (box, cylinder, cone, sphere) that can be placed,
//! rotated, scaled and exported as binary STL. Stored as a JSON document:
//!
//! ```json
//! { "version": 1, "units": "mm",
//!   "objects": [ { "id": "o1", "name": "Base plate", "shape": "box",
//!                  "position": [0, 0, 5], "rotation": [0, 0, 0], "size": [100, 60, 10],
//!                  "color": "#4c8dff", "visible": true } ] }
//! ```
//!
//! Z is up. `size` is the bounding-box extent along each axis (a cylinder with size
//! `[20, 20, 40]` is 20 mm in diameter and 40 mm tall). `rotation` is in degrees (XYZ order).
//! The backend validates the document so a corrupt model can never be saved, and generates the STL
//! itself so exports do not depend on the UI.

use crate::error::{Error, Result};
use crate::projects;
use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

pub const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_OBJECTS: usize = 1000;
pub const SHAPES: [&str; 4] = ["box", "cylinder", "cone", "sphere"];

#[derive(Debug, Clone, Serialize)]
pub struct ModelMeta {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub objects: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Model {
    #[serde(flatten)]
    pub meta: ModelMeta,
    pub data: Value,
}

pub fn empty_document() -> Value {
    json!({ "version": 1, "units": "mm", "objects": [] })
}

fn is_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn triple(o: &Value, key: &str, min: f64, max: f64) -> Result<[f64; 3]> {
    let bad = || Error::validation("data", format!("Model is invalid: '{key}' must be three numbers between {min} and {max}."));
    let a = o.get(key).and_then(Value::as_array).filter(|a| a.len() == 3).ok_or_else(bad)?;
    let mut out = [0.0; 3];
    for (i, v) in a.iter().enumerate() {
        let n = v.as_f64().filter(|n| n.is_finite() && *n >= min && *n <= max).ok_or_else(bad)?;
        out[i] = n;
    }
    Ok(out)
}

/// Validate a model document; returns the object count.
pub fn validate_document(doc: &Value) -> Result<usize> {
    let bad = |m: &str| Error::validation("data", format!("Model is invalid: {m}"));
    if serde_json::to_vec(doc)?.len() > MAX_BYTES {
        return Err(bad("it is too large."));
    }
    let objects = doc.get("objects").and_then(Value::as_array).ok_or_else(|| bad("'objects' must be a list."))?;
    if objects.len() > MAX_OBJECTS {
        return Err(bad("too many objects."));
    }
    let mut ids = HashSet::new();
    for o in objects {
        let id = o.get("id").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 64).ok_or_else(|| bad("an object has no id."))?;
        if !ids.insert(id) {
            return Err(bad("duplicate object id."));
        }
        let name = o.get("name").and_then(Value::as_str).ok_or_else(|| bad("an object has no name."))?;
        if name.chars().count() > 120 || name.chars().any(|c| c.is_control()) {
            return Err(bad("an object name is too long or has invalid characters."));
        }
        let shape = o.get("shape").and_then(Value::as_str).unwrap_or("");
        if !SHAPES.contains(&shape) {
            return Err(bad("shape must be box, cylinder, cone or sphere."));
        }
        triple(o, "position", -1.0e5, 1.0e5)?;
        triple(o, "rotation", -3600.0, 3600.0)?;
        triple(o, "size", 0.001, 1.0e5)?;
        if !is_color(o.get("color").and_then(Value::as_str).unwrap_or("")) {
            return Err(bad("colour must look like #rrggbb."));
        }
        if let Some(v) = o.get("visible") {
            if !v.is_boolean() {
                return Err(bad("'visible' must be true or false."));
            }
        }
    }
    Ok(objects.len())
}

fn map_meta(r: &Row) -> rusqlite::Result<(ModelMeta, String)> {
    let data: String = r.get(5)?;
    let n = serde_json::from_str::<Value>(&data).ok().and_then(|v| v.get("objects").and_then(Value::as_array).map(|a| a.len())).unwrap_or(0) as i64;
    Ok((ModelMeta { id: r.get(0)?, project_id: r.get(1)?, name: r.get(2)?, created_at: r.get(3)?, updated_at: r.get(4)?, objects: n }, data))
}

const SELECT: &str = "SELECT id, project_id, name, created_at, updated_at, data FROM models3d";

pub fn list(conn: &Connection, project_id: i64) -> Result<Vec<ModelMeta>> {
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE project_id = ?1 ORDER BY name COLLATE NOCASE, id"))?;
    let rows = stmt.query_map([project_id], map_meta)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().map(|(m, _)| m).collect())
}

pub fn get(conn: &Connection, id: i64) -> Result<Model> {
    let (meta, data) = conn
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], map_meta)
        .optional()?
        .ok_or_else(|| Error::NotFound("Model not found.".into()))?;
    Ok(Model { meta, data: serde_json::from_str(&data)? })
}

pub fn create(conn: &Connection, project_id: i64, name: &str, data: Option<Value>) -> Result<Model> {
    let name = text("name", "Model name", name, 1, 120)?;
    projects::get(conn, project_id)?;
    let doc = data.unwrap_or_else(empty_document);
    validate_document(&doc)?;
    conn.execute("INSERT INTO models3d (project_id, name, data) VALUES (?1, ?2, ?3)", params![project_id, name, serde_json::to_string(&doc)?])?;
    let id = conn.last_insert_rowid();
    projects::touch(conn, project_id)?;
    get(conn, id)
}

pub fn save(conn: &Connection, id: i64, data: &Value, name: Option<&str>) -> Result<ModelMeta> {
    validate_document(data)?;
    let existing = get(conn, id)?;
    let name = match name {
        Some(n) => text("name", "Model name", n, 1, 120)?,
        None => existing.meta.name.clone(),
    };
    conn.execute(&format!("UPDATE models3d SET name = ?1, data = ?2, updated_at = {NOW_SQL} WHERE id = ?3"), params![name, serde_json::to_string(data)?, id])?;
    projects::touch(conn, existing.meta.project_id)?;
    Ok(get(conn, id)?.meta)
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    let existing = get(conn, id)?;
    conn.execute("DELETE FROM models3d WHERE id = ?1", [id])?;
    projects::touch(conn, existing.meta.project_id)?;
    Ok(())
}

// ------------------------------------------------------------------ geometry / STL

type V3 = [f64; 3];
type Tri = [V3; 3];

const CYL_SEGMENTS: usize = 48;
const SPHERE_SEGMENTS: usize = 32;
const SPHERE_RINGS: usize = 16;

/// Unit-size solid centred on the origin, spanning [-0.5, 0.5] on each axis, outward-facing (CCW) triangles.
fn unit_mesh(shape: &str) -> Vec<Tri> {
    let mut t: Vec<Tri> = Vec::new();
    match shape {
        "box" => {
            let c = |x: f64, y: f64, z: f64| [x - 0.5, y - 0.5, z - 0.5];
            let quads: [[V3; 4]; 6] = [
                [c(0., 0., 0.), c(0., 1., 0.), c(0., 1., 1.), c(0., 0., 1.)], // -x
                [c(1., 0., 0.), c(1., 0., 1.), c(1., 1., 1.), c(1., 1., 0.)], // +x
                [c(0., 0., 0.), c(0., 0., 1.), c(1., 0., 1.), c(1., 0., 0.)], // -y
                [c(0., 1., 0.), c(1., 1., 0.), c(1., 1., 1.), c(0., 1., 1.)], // +y
                [c(0., 0., 0.), c(1., 0., 0.), c(1., 1., 0.), c(0., 1., 0.)], // -z
                [c(0., 0., 1.), c(0., 1., 1.), c(1., 1., 1.), c(1., 0., 1.)], // +z
            ];
            for q in quads {
                t.push([q[0], q[2], q[1]]);
                t.push([q[0], q[3], q[2]]);
            }
        }
        "cylinder" | "cone" => {
            let top_r = if shape == "cone" { 0.0 } else { 0.5 };
            let ring = |i: usize, r: f64, z: f64| {
                let a = std::f64::consts::TAU * (i % CYL_SEGMENTS) as f64 / CYL_SEGMENTS as f64;
                [r * a.cos(), r * a.sin(), z]
            };
            for i in 0..CYL_SEGMENTS {
                let (b0, b1) = (ring(i, 0.5, -0.5), ring(i + 1, 0.5, -0.5));
                let (t0, t1) = (ring(i, top_r, 0.5), ring(i + 1, top_r, 0.5));
                t.push([b0, b1, t1]);
                if top_r > 0.0 {
                    t.push([b0, t1, t0]);
                    t.push([[0.0, 0.0, 0.5], t0, t1]);
                }
                t.push([[0.0, 0.0, -0.5], b1, b0]);
            }
            if top_r == 0.0 {
                // side triangles of a cone are [b0, b1, apex]; replace the degenerate quad half above
                t.retain(|tri| !(tri[2][2] == 0.5 && tri[2][0] == tri[1][0] && tri[2][0].abs() < 1e-12 && tri[1][2] == 0.5));
            }
        }
        _ => {
            let p = |ring: usize, seg: usize| {
                let phi = std::f64::consts::PI * ring as f64 / SPHERE_RINGS as f64; // 0 = north pole (+z)
                let th = std::f64::consts::TAU * (seg % SPHERE_SEGMENTS) as f64 / SPHERE_SEGMENTS as f64;
                [0.5 * phi.sin() * th.cos(), 0.5 * phi.sin() * th.sin(), 0.5 * phi.cos()]
            };
            for r in 0..SPHERE_RINGS {
                for s in 0..SPHERE_SEGMENTS {
                    let (a, b, c, d) = (p(r, s), p(r, s + 1), p(r + 1, s + 1), p(r + 1, s));
                    if r > 0 {
                        t.push([a, d, b]);
                    }
                    if r < SPHERE_RINGS - 1 {
                        t.push([b, d, c]);
                    }
                }
            }
        }
    }
    t
}

fn rot_matrix(deg: V3) -> [[f64; 3]; 3] {
    let [rx, ry, rz] = [deg[0].to_radians(), deg[1].to_radians(), deg[2].to_radians()];
    let (sx, cx, sy, cy, sz, cz) = (rx.sin(), rx.cos(), ry.sin(), ry.cos(), rz.sin(), rz.cos());
    // R = Rz * Ry * Rx (intrinsic XYZ in three.js terms is the same matrix order)
    [
        [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
        [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
        [-sy, cy * sx, cy * cx],
    ]
}

/// All visible objects as world-space triangles (millimetres).
pub fn triangles(doc: &Value) -> Result<Vec<Tri>> {
    validate_document(doc)?;
    let mut out = Vec::new();
    for o in doc["objects"].as_array().into_iter().flatten() {
        if o.get("visible").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let shape = o["shape"].as_str().unwrap_or("box");
        let pos = triple(o, "position", -1.0e5, 1.0e5)?;
        let rot = rot_matrix(triple(o, "rotation", -3600.0, 3600.0)?);
        let size = triple(o, "size", 0.001, 1.0e5)?;
        let tf = |v: V3| {
            let s = [v[0] * size[0], v[1] * size[1], v[2] * size[2]];
            [
                rot[0][0] * s[0] + rot[0][1] * s[1] + rot[0][2] * s[2] + pos[0],
                rot[1][0] * s[0] + rot[1][1] * s[1] + rot[1][2] * s[2] + pos[1],
                rot[2][0] * s[0] + rot[2][1] * s[1] + rot[2][2] * s[2] + pos[2],
            ]
        };
        for tri in unit_mesh(shape) {
            out.push([tf(tri[0]), tf(tri[1]), tf(tri[2])]);
        }
    }
    Ok(out)
}

pub fn volume_of(tris: &[Tri]) -> f64 {
    tris.iter()
        .map(|t| {
            let c = [t[1][1] * t[2][2] - t[1][2] * t[2][1], t[1][2] * t[2][0] - t[1][0] * t[2][2], t[1][0] * t[2][1] - t[1][1] * t[2][0]];
            (t[0][0] * c[0] + t[0][1] * c[1] + t[0][2] * c[2]) / 6.0
        })
        .sum()
}

pub fn to_binary_stl(tris: &[Tri], title: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(84 + tris.len() * 50);
    let mut header = [0u8; 80];
    let label = format!("RoboDesk {title}");
    let n = label.len().min(80);
    header[..n].copy_from_slice(&label.as_bytes()[..n]);
    out.extend_from_slice(&header);
    out.extend_from_slice(&(tris.len() as u32).to_le_bytes());
    for t in tris {
        let u = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
        let v = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
        let mut n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len > 0.0 {
            n = [n[0] / len, n[1] / len, n[2] / len];
        }
        for c in n.iter().chain(t[0].iter()).chain(t[1].iter()).chain(t[2].iter()) {
            out.extend_from_slice(&(*c as f32).to_le_bytes());
        }
        out.extend_from_slice(&[0, 0]);
    }
    out
}

/// Export a saved model as binary STL (millimetres, Z up). Hidden objects are skipped.
pub fn export_stl(conn: &Connection, id: i64, path: &str) -> Result<Value> {
    let p = crate::data::require_file_ext(path, "stl")?;
    let model = get(conn, id)?;
    let tris = triangles(&model.data)?;
    if tris.is_empty() {
        return Err(Error::validation("data", "Nothing to export: the model has no visible objects."));
    }
    crate::data::write_atomic(&p, &to_binary_stl(&tris, &model.meta.name))?;
    Ok(json!({ "path": path, "triangles": tris.len(), "volume_mm3": volume_of(&tris) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, projects::ProjectInput};

    fn project(conn: &Connection) -> i64 {
        projects::create(conn, ProjectInput { name: "P".into(), description: String::new(), status: "planning".into(), start_date: None, due_date: None, notes: String::new() }).unwrap().project.id
    }

    fn obj(id: &str, shape: &str, pos: V3, rot: V3, size: V3) -> Value {
        json!({"id": id, "name": id, "shape": shape, "position": pos, "rotation": rot, "size": size, "color": "#4c8dff", "visible": true})
    }

    fn doc(objects: Vec<Value>) -> Value {
        json!({"version": 1, "units": "mm", "objects": objects})
    }

    #[test]
    fn save_and_reload_roundtrip() {
        let conn = db::open_memory().unwrap();
        let p = project(&conn);
        let m = create(&conn, p, "Chassis", None).unwrap();
        assert_eq!(m.meta.objects, 0);
        let d = doc(vec![obj("a", "box", [0., 0., 5.], [0., 0., 0.], [100., 60., 10.])]);
        let meta = save(&conn, m.meta.id, &d, Some("Chassis v2")).unwrap();
        assert_eq!((meta.objects, meta.name.as_str()), (1, "Chassis v2"));
        assert_eq!(get(&conn, m.meta.id).unwrap().data, d);
        assert_eq!(list(&conn, p).unwrap().len(), 1);
        delete(&conn, m.meta.id).unwrap();
        assert!(list(&conn, p).unwrap().is_empty());
    }

    #[test]
    fn rejects_corrupt_documents() {
        let ok = obj("a", "box", [0., 0., 0.], [0., 0., 0.], [1., 1., 1.]);
        assert!(validate_document(&doc(vec![ok.clone()])).is_ok());
        let mut b = ok.clone();
        b["shape"] = json!("torus");
        assert!(validate_document(&doc(vec![b])).is_err());
        let mut b = ok.clone();
        b["size"] = json!([0, 1, 1]);
        assert!(validate_document(&doc(vec![b])).is_err(), "zero size");
        let mut b = ok.clone();
        b["color"] = json!("blue");
        assert!(validate_document(&doc(vec![b])).is_err());
        let mut b = ok.clone();
        b["position"] = json!([1, 2]);
        assert!(validate_document(&doc(vec![b])).is_err());
        assert!(validate_document(&doc(vec![ok.clone(), ok.clone()])).is_err(), "duplicate id");
        assert!(validate_document(&json!({"objects": 3})).is_err());
    }

    #[test]
    fn tessellation_has_the_right_volume_and_is_outward_facing() {
        let box_v = volume_of(&triangles(&doc(vec![obj("a", "box", [10., 20., 30.], [0., 0., 0.], [2., 3., 4.])])).unwrap());
        assert!((box_v - 24.0).abs() < 1e-9, "box volume {box_v}");
        // rotation and translation do not change volume
        let rot_v = volume_of(&triangles(&doc(vec![obj("a", "box", [1., 2., 3.], [30., 45., 60.], [2., 3., 4.])])).unwrap());
        assert!((rot_v - 24.0).abs() < 1e-9, "rotated volume {rot_v}");
        let n = CYL_SEGMENTS as f64;
        let poly = 0.5 * n * (std::f64::consts::TAU / n).sin() * 0.25; // area of unit-diameter n-gon
        let cyl = volume_of(&triangles(&doc(vec![obj("c", "cylinder", [0.; 3], [0.; 3], [1., 1., 1.])])).unwrap());
        assert!((cyl - poly).abs() < 1e-9, "cylinder volume {cyl} vs {poly}");
        let cone = volume_of(&triangles(&doc(vec![obj("c", "cone", [0.; 3], [0.; 3], [1., 1., 1.])])).unwrap());
        assert!((cone - poly / 3.0).abs() < 1e-9, "cone volume {cone} vs {}", poly / 3.0);
        let sphere = volume_of(&triangles(&doc(vec![obj("s", "sphere", [0.; 3], [0.; 3], [2., 2., 2.])])).unwrap());
        let exact = 4.0 / 3.0 * std::f64::consts::PI;
        assert!(sphere > 0.0 && (sphere - exact).abs() / exact < 0.03, "sphere volume {sphere} vs {exact}");
    }

    #[test]
    fn stl_export_writes_a_valid_binary_file_and_skips_hidden() {
        let conn = db::open_memory().unwrap();
        let p = project(&conn);
        let mut hidden = obj("h", "sphere", [0.; 3], [0.; 3], [5., 5., 5.]);
        hidden["visible"] = json!(false);
        let d = doc(vec![obj("a", "box", [0.; 3], [0.; 3], [10., 10., 10.]), hidden]);
        let m = create(&conn, p, "T", Some(d)).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.stl");
        let res = export_stl(&conn, m.meta.id, path.to_str().unwrap()).unwrap();
        assert_eq!(res["triangles"], 12);
        assert!((res["volume_mm3"].as_f64().unwrap() - 1000.0).abs() < 1e-6);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 84 + 12 * 50);
        assert_eq!(u32::from_le_bytes(bytes[80..84].try_into().unwrap()), 12);
        assert!(export_stl(&conn, m.meta.id, dir.path().join("x.txt").to_str().unwrap()).is_err());
        let empty = create(&conn, p, "Empty", None).unwrap();
        assert!(export_stl(&conn, empty.meta.id, path.to_str().unwrap()).is_err());
    }
}
