//! User settings stored in the `settings` table. Unknown keys are rejected so a typo in
//! the frontend can never silently create junk, and every value is range-checked.

use crate::error::{Error, Result};
use rusqlite::Connection;
use serde_json::{json, Map, Value};

pub const THEMES: [&str; 3] = ["navy", "midnight", "light"];

/// (key, default as JSON text)
const DEFAULTS: [(&str, &str); 5] = [
    ("theme", "\"navy\""),
    ("autosave_enabled", "true"),
    ("autosave_interval_secs", "5"),
    ("confirm_destructive", "true"),
    ("backup_keep", "10"),
];

pub fn validate(key: &str, value: &Value) -> Result<Value> {
    match key {
        "theme" => {
            let s = value.as_str().unwrap_or("");
            if THEMES.contains(&s) {
                Ok(json!(s))
            } else {
                Err(Error::validation("theme", format!("Theme must be one of: {}.", THEMES.join(", "))))
            }
        }
        "autosave_enabled" | "confirm_destructive" => {
            value.as_bool().map(|b| json!(b)).ok_or_else(|| Error::validation(key, "Value must be on or off."))
        }
        "autosave_interval_secs" => {
            let n = value.as_i64().filter(|n| (2..=300).contains(n));
            n.map(|n| json!(n)).ok_or_else(|| Error::validation(key, "Autosave interval must be between 2 and 300 seconds."))
        }
        "backup_keep" => {
            let n = value.as_i64().filter(|n| (1..=100).contains(n));
            n.map(|n| json!(n)).ok_or_else(|| Error::validation(key, "Keep between 1 and 100 backups."))
        }
        _ => Err(Error::validation(key, format!("Unknown setting '{key}'."))),
    }
}

pub fn get_all(conn: &Connection) -> Result<Value> {
    let mut map = Map::new();
    for (k, d) in DEFAULTS {
        map.insert(k.to_string(), serde_json::from_str(d)?);
    }
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        // Ignore stored values that are no longer valid rather than failing to start.
        if let Ok(parsed) = serde_json::from_str::<Value>(&v) {
            if let Ok(ok) = validate(&k, &parsed) {
                map.insert(k, ok);
            }
        }
    }
    Ok(Value::Object(map))
}

pub fn set(conn: &Connection, key: &str, value: &Value) -> Result<Value> {
    let v = validate(key, value)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, serde_json::to_string(&v)?],
    )?;
    get_all(conn)
}

pub fn get_i64(conn: &Connection, key: &str) -> Result<i64> {
    Ok(get_all(conn)?.get(key).and_then(Value::as_i64).unwrap_or(10))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn defaults_set_and_validation() {
        let conn = db::open_memory().unwrap();
        let s = get_all(&conn).unwrap();
        assert_eq!(s["theme"], "navy");
        assert_eq!(s["autosave_enabled"], true);

        let s = set(&conn, "theme", &json!("light")).unwrap();
        assert_eq!(s["theme"], "light");
        assert!(set(&conn, "theme", &json!("neon")).is_err());
        assert!(set(&conn, "autosave_interval_secs", &json!(1)).is_err());
        assert!(set(&conn, "autosave_interval_secs", &json!(30)).is_ok());
        assert!(set(&conn, "mystery", &json!(1)).is_err());
        assert!(set(&conn, "backup_keep", &json!("ten")).is_err());
        // persisted
        assert_eq!(get_all(&conn).unwrap()["autosave_interval_secs"], 30);
    }

    #[test]
    fn corrupt_stored_value_falls_back_to_default() {
        let conn = db::open_memory().unwrap();
        conn.execute("INSERT INTO settings VALUES ('theme', '\"banana\"')", []).unwrap();
        conn.execute("INSERT INTO settings VALUES ('backup_keep', 'not json')", []).unwrap();
        let s = get_all(&conn).unwrap();
        assert_eq!(s["theme"], "navy");
        assert_eq!(s["backup_keep"], 10);
    }
}
