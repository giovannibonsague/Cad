//! Development/test bridge (NOT part of the shipped app).
//!
//! Serves the `src/` frontend over HTTP on 127.0.0.1 and exposes `Core::dispatch` at
//! `POST /api` so a headless browser can exercise the real UI against the real Rust
//! data layer. The desktop build does not use this; it goes through Tauri IPC.
//!
//!   cargo run -p robodesk-core --example devbridge -- <port> <static_dir> <data_dir>

use robodesk_core::Core;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &[u8]) {
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

fn handle(mut stream: TcpStream, core: Arc<Core>, root: Arc<PathBuf>) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
    }
    let path = target.split(['?', '#']).next().unwrap_or("/");

    if method == "POST" && path == "/api" {
        let mut body = vec![0u8; content_length];
        if reader.read_exact(&mut body).is_err() {
            return respond(&mut stream, "400 Bad Request", "text/plain", b"bad body");
        }
        let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let cmd = req.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
        let args = req.get("args").cloned().unwrap_or(Value::Null);
        return match core.dispatch(&cmd, args) {
            Ok(v) => respond(&mut stream, "200 OK", "application/json", v.to_string().as_bytes()),
            Err(e) => {
                let v = json!({ "code": e.code, "message": e.message, "field": e.field });
                respond(&mut stream, "422 Unprocessable Entity", "application/json", v.to_string().as_bytes())
            }
        };
    }
    if method != "GET" {
        return respond(&mut stream, "405 Method Not Allowed", "text/plain", b"method");
    }
    let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
    if rel.split('/').any(|seg| seg == ".." || seg.contains('\\')) {
        return respond(&mut stream, "400 Bad Request", "text/plain", b"bad path");
    }
    let file = root.join(rel);
    match std::fs::read(&file) {
        Ok(bytes) => respond(&mut stream, "200 OK", mime(&file), &bytes),
        Err(_) => respond(&mut stream, "404 Not Found", "text/plain", b"not found"),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: devbridge <port> <static_dir> <data_dir>");
        std::process::exit(2);
    }
    let port: u16 = args[1].parse().expect("port");
    let root = Arc::new(PathBuf::from(&args[2]));
    let data = PathBuf::from(&args[3]);
    let core = Arc::new(Core::open(data.join("config"), data.join("data")).expect("open core"));
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    println!("READY http://127.0.0.1:{port}/");
    let _ = std::io::stdout().flush();
    for stream in listener.incoming().flatten() {
        let (core, root) = (core.clone(), root.clone());
        std::thread::spawn(move || handle(stream, core, root));
    }
}
