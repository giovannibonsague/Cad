//! Argument extraction and input validation helpers.

use crate::error::{Error, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;

/// SQLite expression producing a UTC ISO-8601 timestamp.
pub const NOW_SQL: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

pub const PROJECT_STATUSES: [&str; 5] = ["planning", "in_progress", "testing", "completed", "on_hold"];
pub const TASK_STATUSES: [&str; 4] = ["todo", "in_progress", "blocked", "done"];
pub const TASK_PRIORITIES: [&str; 4] = ["low", "medium", "high", "critical"];
pub const COMPONENT_CATEGORIES: [&str; 9] = [
    "sensor",
    "motor",
    "controller",
    "driver",
    "battery",
    "structural",
    "fastener",
    "wiring",
    "other",
];

// ---------------------------------------------------------------- arguments

pub fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T> {
    match args.get(key) {
        None | Some(Value::Null) => Err(Error::validation(key, format!("Missing argument '{key}'"))),
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|e| Error::validation(key, format!("Invalid value for '{key}': {e}"))),
    }
}

pub fn arg_opt<T: DeserializeOwned>(args: &Value, key: &str) -> Result<Option<T>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| Error::validation(key, format!("Invalid value for '{key}': {e}"))),
    }
}

pub fn arg_or<T: DeserializeOwned>(args: &Value, key: &str, default: T) -> Result<T> {
    Ok(arg_opt(args, key)?.unwrap_or(default))
}

// --------------------------------------------------------------- validation

/// Trimmed single-line text with length bounds (counted in characters).
pub fn text(field: &str, label: &str, value: &str, min: usize, max: usize) -> Result<String> {
    let t = value.trim();
    let n = t.chars().count();
    if n < min {
        return Err(Error::validation(field, format!("{label} is required.")));
    }
    if n > max {
        return Err(Error::validation(field, format!("{label} must be at most {max} characters.")));
    }
    if t.chars().any(|c| c.is_control()) {
        return Err(Error::validation(field, format!("{label} contains invalid characters.")));
    }
    Ok(t.to_string())
}

/// Multi-line text (newlines and tabs allowed), length-bounded, not trimmed inside.
pub fn multiline(field: &str, label: &str, value: &str, max: usize) -> Result<String> {
    if value.chars().count() > max {
        return Err(Error::validation(field, format!("{label} must be at most {max} characters.")));
    }
    if value.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t') {
        return Err(Error::validation(field, format!("{label} contains invalid characters.")));
    }
    Ok(value.trim_end().to_string())
}

pub fn one_of(field: &str, label: &str, value: &str, allowed: &[&str]) -> Result<String> {
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(Error::validation(field, format!("{label} must be one of: {}.", allowed.join(", "))))
    }
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Strict `YYYY-MM-DD` calendar-date check (no external date crate needed).
pub fn is_valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(|c| c.is_ascii_digit());
    if !(digits(0..4) && digits(5..7) && digits(8..10)) {
        return false;
    }
    let y: i32 = s[0..4].parse().unwrap_or(0);
    let m: u32 = s[5..7].parse().unwrap_or(0);
    let d: u32 = s[8..10].parse().unwrap_or(0);
    if !(1900..=2200).contains(&y) || !(1..=12).contains(&m) || d == 0 {
        return false;
    }
    let dim = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
    };
    d <= dim
}

/// Empty / missing -> `None`; otherwise must be a valid ISO date.
pub fn opt_date(field: &str, label: &str, value: &Option<String>) -> Result<Option<String>> {
    match value.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) if is_valid_date(s) => Ok(Some(s.to_string())),
        Some(_) => Err(Error::validation(field, format!("{label} must be a valid date (YYYY-MM-DD)."))),
    }
}

pub fn int_range(field: &str, label: &str, v: i64, min: i64, max: i64) -> Result<i64> {
    if v < min || v > max {
        Err(Error::validation(field, format!("{label} must be between {min} and {max}.")))
    } else {
        Ok(v)
    }
}

pub fn opt_float_range(field: &str, label: &str, v: Option<f64>, min: f64, max: f64) -> Result<Option<f64>> {
    match v {
        None => Ok(None),
        Some(x) if x.is_finite() && x >= min && x <= max => Ok(Some(x)),
        Some(_) => Err(Error::validation(field, format!("{label} must be a number between {min} and {max}."))),
    }
}

/// http(s) URL with no whitespace; empty is allowed and returned as an empty string.
pub fn http_url(field: &str, label: &str, value: &str) -> Result<String> {
    let t = value.trim();
    if t.is_empty() {
        return Ok(String::new());
    }
    let lower = t.to_ascii_lowercase();
    let ok_scheme = lower.starts_with("http://") || lower.starts_with("https://");
    if !ok_scheme || t.chars().any(|c| c.is_whitespace() || c.is_control()) || t.len() > 2048 || t.len() < 10 {
        return Err(Error::validation(field, format!("{label} must be a valid http(s) link.")));
    }
    Ok(t.to_string())
}

/// Escape a user string for use inside a SQL LIKE pattern with `ESCAPE '\'`.
pub fn like_pattern(s: &str) -> String {
    let mut out = String::from("%");
    for c in s.trim().chars() {
        if c == '%' || c == '_' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// Format integer cents as a plain decimal string, e.g. 1234 -> "12.34".
pub fn fmt_cents(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let a = cents.unsigned_abs();
    format!("{sign}{}.{:02}", a / 100, a % 100)
}

// ------------------------------------------------------------------- time

/// Convert a `SystemTime` to `YYYY-MM-DDTHH:MM:SSZ` (UTC) without a date crate.
pub fn iso_from_system_time(t: std::time::SystemTime) -> String {
    let secs = match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(e) => -(e.duration().as_secs() as i64),
    };
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert!(is_valid_date("2024-02-29"));
        assert!(!is_valid_date("2023-02-29"));
        assert!(!is_valid_date("2023-13-01"));
        assert!(!is_valid_date("2023-1-01"));
        assert!(!is_valid_date("2023-04-31"));
        assert!(!is_valid_date("abcd-ef-gh"));
        assert!(is_valid_date("2000-02-29"));
        assert!(!is_valid_date("1900-02-29"));
    }

    #[test]
    fn cents_format() {
        assert_eq!(fmt_cents(0), "0.00");
        assert_eq!(fmt_cents(5), "0.05");
        assert_eq!(fmt_cents(123456), "1234.56");
    }

    #[test]
    fn time_conversion() {
        use std::time::{Duration, UNIX_EPOCH};
        assert_eq!(iso_from_system_time(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_system_time(UNIX_EPOCH + Duration::from_secs(1_709_210_096)), "2024-02-29T12:34:56Z");
    }

    #[test]
    fn like_escape() {
        assert_eq!(like_pattern(" 50%_a\\ "), "%50\\%\\_a\\\\%");
    }

    #[test]
    fn url_rules() {
        assert!(http_url("u", "Link", "").unwrap().is_empty());
        assert!(http_url("u", "Link", "https://example.com/a.pdf").is_ok());
        assert!(http_url("u", "Link", "javascript:alert(1)").is_err());
        assert!(http_url("u", "Link", "file:///C:/x.pdf").is_err());
        assert!(http_url("u", "Link", "https://exa mple.com").is_err());
    }

    #[test]
    fn text_rules() {
        assert!(text("n", "Name", "   ", 1, 10).is_err());
        assert!(text("n", "Name", "a\u{0007}b", 1, 10).is_err());
        assert_eq!(text("n", "Name", "  hi ", 1, 10).unwrap(), "hi");
        assert!(text("n", "Name", "12345678901", 1, 10).is_err());
    }
}
