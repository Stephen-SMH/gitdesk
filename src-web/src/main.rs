//! GitDesk in the browser. Serves the React UI on 127.0.0.1 and answers the
//! same commands as the desktop app, using the desktop app's own git layer.

#[path = "../../src-tauri/src/git.rs"]
mod git;

use axum::{
    Json, Router,
    extract::{Path as UrlPath, Request, State},
    http::{HeaderMap, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use git::{FileChange, GitResult};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

const DEFAULT_PORT: u16 = 4820;
const USAGE: &str = "Usage: gitdesk-web [folder] [--port N] [--no-open]

Opens GitDesk in your browser at http://127.0.0.1:4820 and opens the folder,
if given, as the first repository. Stop it with Ctrl+C.";

/// The built UI from `npm run build`. Release builds embed it; debug builds
/// read it from disk, so a rebuilt UI shows up on reload.
#[derive(RustEmbed)]
#[folder = "../dist"]
#[allow_missing = true]
struct Ui;

struct AppState {
    port: u16,
    /// Folder from the command line, handed to the first page that asks.
    launch: Mutex<Option<String>>,
}

#[derive(Debug, PartialEq)]
struct Args {
    folder: Option<String>,
    port: u16,
    open: bool,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut out = Args { folder: None, port: DEFAULT_PORT, open: true };
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" | "-p" => {
                out.port = args.next().and_then(|p| p.parse().ok()).ok_or("--port needs a port number")?;
            }
            "--no-open" => out.open = false,
            "-h" | "--help" => return Err(String::new()),
            s if s.starts_with('-') => return Err(format!("Unknown option {s}")),
            _ => out.folder = Some(a),
        }
    }
    Ok(out)
}

#[tokio::main]
async fn main() {
    let mut args = parse_args(std::env::args().skip(1)).unwrap_or_else(|msg| {
        if msg.is_empty() {
            println!("{USAGE}");
            std::process::exit(0);
        }
        eprintln!("{msg}\n\n{USAGE}");
        std::process::exit(2);
    });
    if let Some(folder) = &args.folder {
        let path = std::path::absolute(folder).unwrap_or_else(|_| PathBuf::from(folder));
        if !path.is_dir() {
            eprintln!("{folder} is not a folder.");
            std::process::exit(2);
        }
        args.folder = Some(path.to_string_lossy().into_owned());
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", args.port)).await.unwrap_or_else(|e| {
        eprintln!("Could not listen on 127.0.0.1:{}: {e}\nIs GitDesk already running? Choose another port with --port.", args.port);
        std::process::exit(1);
    });
    let state = Arc::new(AppState { port: args.port, launch: Mutex::new(args.folder) });
    let app = Router::new()
        .route("/api/{cmd}", post(api))
        .fallback(ui)
        .layer(middleware::from_fn_with_state(state.clone(), only_own_page))
        .with_state(state);

    let url = format!("http://127.0.0.1:{}/", args.port);
    println!("GitDesk is running at {url}\nPress Ctrl+C to stop.");
    if Ui::get("index.html").is_none() {
        eprintln!("The UI isn't built yet: run `npm run build` in the gitdesk folder.");
    }
    if args.open {
        tokio::task::spawn_blocking(move || system_open(OsStr::new(&url), false));
    }
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("Server stopped: {e}");
        std::process::exit(1);
    }
}

/// Any web page can send requests to 127.0.0.1, so only answer our own page.
/// The Host must be our address, which defeats DNS rebinding, and an Origin,
/// when sent, must be too, which stops other sites. (Their JSON POSTs would
/// also need a CORS preflight, which we never grant.)
fn from_own_page(headers: &HeaderMap, port: u16) -> bool {
    let ours = |authority: &str| ["127.0.0.1", "localhost", "[::1]"].iter().any(|h| authority == format!("{h}:{port}"));
    let get = |name| headers.get(name).and_then(|v| v.to_str().ok());
    get(header::HOST).is_some_and(ours) && get(header::ORIGIN).is_none_or(|o| o.strip_prefix("http://").is_some_and(ours))
}

async fn only_own_page(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    if from_own_page(req.headers(), state.port) {
        next.run(req).await
    } else {
        (StatusCode::FORBIDDEN, "GitDesk only answers its own page.").into_response()
    }
}

async fn api(State(state): State<Arc<AppState>>, UrlPath(cmd): UrlPath<String>, Json(args): Json<Value>) -> Response {
    // Git can be slow (network, big repos), so it runs on a blocking thread,
    // as in the desktop app.
    match tokio::task::spawn_blocking(move || dispatch(&cmd, &args, &state)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(msg)) => (StatusCode::BAD_REQUEST, Json(msg)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(e.to_string())).into_response(),
    }
}

#[derive(Deserialize)]
struct DiscardFile {
    path: String,
    untracked: bool,
}

/// Each command matches the desktop app's Tauri command of the same name
/// (src-tauri/src/lib.rs): same argument names, same JSON result.
fn dispatch(cmd: &str, a: &Value, state: &AppState) -> GitResult<Value> {
    let repo = || arg::<PathBuf>(a, "repo");
    match cmd {
        "repo_info" => json(git::repo_info(&repo()?)),
        "status" => json(git::status(&repo()?)),
        "diff_file" => json(git::diff_file(&repo()?, &arg::<String>(a, "file")?, arg(a, "untracked")?)),
        "commit" => json(git::commit(
            &repo()?,
            &arg::<Vec<String>>(a, "files")?,
            &arg::<String>(a, "summary")?,
            &arg::<String>(a, "description")?,
        )),
        "discard" => {
            let files = arg::<Vec<DiscardFile>>(a, "files")?
                .into_iter()
                .map(|f| FileChange { path: f.path, kind: String::new(), untracked: f.untracked, old_path: None })
                .collect::<Vec<_>>();
            json(git::discard(&repo()?, &files))
        }
        "log" => json(git::log(&repo()?, arg(a, "skip")?, arg(a, "limit")?)),
        "commit_files" => json(git::commit_files(&repo()?, &arg::<String>(a, "sha")?)),
        "commit_diff" => json(git::commit_diff(&repo()?, &arg::<String>(a, "sha")?, &arg::<String>(a, "file")?)),
        "branches" => json(git::branches(&repo()?)),
        "checkout" => json(git::checkout(&repo()?, &arg::<String>(a, "branch")?, arg(a, "remote")?)),
        "create_branch" => json(git::create_branch(&repo()?, &arg::<String>(a, "name")?)),
        "fetch" => json(git::fetch(&repo()?)),
        "pull" => json(git::pull(&repo()?)),
        "push" => json(git::push(&repo()?)),
        "clone_repo" => json(git::clone(&arg::<String>(a, "url")?, &arg::<PathBuf>(a, "parent")?)),
        "init_repo" => json(git::init(&arg::<PathBuf>(a, "path")?)),
        "launch_repo" => json(Ok(state.launch.lock().unwrap().take())),
        // Web only: stand-ins for the desktop app's folder dialog and Finder.
        "list_dir" => json(list_dir(arg(a, "path")?)),
        "reveal" => json(reveal(&arg::<PathBuf>(a, "path")?)),
        _ => Err(format!("Unknown command '{cmd}'.")),
    }
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> GitResult<T> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|e| format!("Bad argument '{key}': {e}"))
}

fn json<T: Serialize>(result: GitResult<T>) -> GitResult<Value> {
    result.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

#[derive(Serialize)]
struct Folder {
    path: String,
    parent: Option<String>,
    repo: bool,
    dirs: Vec<Subfolder>,
}

#[derive(Serialize)]
struct Subfolder {
    name: String,
    path: String,
    repo: bool,
}

/// The visible subfolders of `path`, which defaults to the home folder.
fn list_dir(path: Option<String>) -> GitResult<Folder> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let typed = path.as_deref().map(str::trim).unwrap_or("");
    let dir = match (typed, home) {
        ("" | "~", Some(home)) => home,
        (p, Some(home)) if p.starts_with("~/") => home.join(&p[2..]),
        ("", None) => return Err("Type a folder path to start from.".into()),
        (p, _) => PathBuf::from(p),
    };
    // Resolve `..` by hand: canonicalize would also follow symlinks, and on
    // Windows it returns \\?\ paths.
    let dir = std::path::absolute(&dir).map_err(|e| e.to_string())?.components().fold(PathBuf::new(), |mut p, c| {
        if c == Component::ParentDir {
            p.pop();
        } else {
            p.push(c);
        }
        p
    });
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Can't open {}: {e}", dir.display()))?;
    let mut dirs: Vec<Subfolder> = entries
        .filter_map(Result::ok)
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .map(|p| Subfolder {
            name: p.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            repo: is_repo(&p),
            path: p.to_string_lossy().into_owned(),
        })
        .collect();
    dirs.sort_by_key(|d| d.name.to_lowercase());
    Ok(Folder {
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        repo: is_repo(&dir),
        path: dir.to_string_lossy().into_owned(),
        dirs,
    })
}

fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

fn reveal(path: &Path) -> GitResult<()> {
    if !path.exists() {
        return Err(format!("{} no longer exists.", path.display()));
    }
    system_open(path.as_os_str(), true)
}

/// Open a URL or folder with the OS. `select` shows a path selected in its
/// parent folder (Finder, Explorer); other systems just open the folder.
fn system_open(target: &OsStr, select: bool) -> GitResult<()> {
    let mut cmd;
    if cfg!(target_os = "macos") {
        cmd = Command::new("open");
        if select {
            cmd.arg("-R");
        }
        cmd.arg(target);
    } else if cfg!(windows) {
        cmd = Command::new("explorer");
        if select {
            let mut arg = OsString::from("/select,");
            arg.push(target);
            cmd.arg(arg);
        } else {
            cmd.arg(target);
        }
    } else {
        cmd = Command::new("xdg-open");
        cmd.arg(target);
    }
    // Explorer exits non-zero even when it works, so only a failure to start counts.
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|_| ()).map_err(|e| {
        format!("Could not open {}: {e}", target.to_string_lossy())
    })
}

async fn ui(uri: Uri) -> Response {
    let path = match uri.path().trim_start_matches('/') {
        "" => "index.html",
        p => p,
    };
    match Ui::get(path) {
        Some(file) => {
            // Vite puts a content hash in every asset name, so those never change.
            let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
            ([(header::CONTENT_TYPE, content_type(path)), (header::CACHE_CONTROL, cache)], file.data).into_response()
        }
        None if Ui::get("index.html").is_none() => (
            StatusCode::NOT_FOUND,
            "The GitDesk UI isn't built. Run `npm run build` in the gitdesk folder, then reload.",
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod web_tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde_json::json;
    use std::fs;

    fn headers(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gitdesk-web-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn answers_only_its_own_page() {
        let own = |pairs: &[(header::HeaderName, &str)]| from_own_page(&headers(pairs), 4820);
        assert!(own(&[(header::HOST, "127.0.0.1:4820")]));
        assert!(own(&[(header::HOST, "localhost:4820"), (header::ORIGIN, "http://localhost:4820")]));
        // Another site posting to us.
        assert!(!own(&[(header::HOST, "127.0.0.1:4820"), (header::ORIGIN, "https://evil.example")]));
        assert!(!own(&[(header::HOST, "127.0.0.1:4820"), (header::ORIGIN, "null")]));
        // DNS rebinding: evil.example resolved to 127.0.0.1.
        assert!(!own(&[(header::HOST, "evil.example:4820"), (header::ORIGIN, "http://evil.example:4820")]));
        assert!(!own(&[(header::HOST, "127.0.0.1:9999")]));
        assert!(!own(&[]));
    }

    #[test]
    fn parses_args() {
        let parse = |s: &str| parse_args(s.split_whitespace().map(String::from));
        assert_eq!(parse("").unwrap(), Args { folder: None, port: 4820, open: true });
        assert_eq!(parse("~/code --port 9000 --no-open").unwrap(), Args { folder: Some("~/code".into()), port: 9000, open: false });
        assert!(parse("--port").is_err());
        assert!(parse("--bogus").is_err());
    }

    #[test]
    fn dispatch_runs_git_commands() {
        let dir = temp_dir("dispatch");
        let state = AppState { port: 4820, launch: Mutex::new(Some("/somewhere".into())) };
        let call = |cmd: &str, args: Value| dispatch(cmd, &args, &state);
        call("init_repo", json!({ "path": dir })).unwrap();
        fs::write(dir.join("a.txt"), "a\n").unwrap();

        let status = call("status", json!({ "repo": dir })).unwrap();
        assert_eq!(status, json!([{ "path": "a.txt", "kind": "new", "untracked": true, "old_path": null }]));
        let diff = call("diff_file", json!({ "repo": dir, "file": "a.txt", "untracked": true })).unwrap();
        assert!(diff.as_str().unwrap().contains("+a"));
        assert_eq!(call("repo_info", json!({ "repo": dir })).unwrap()["has_commits"], json!(false));

        assert!(call("status", json!({})).unwrap_err().contains("'repo'"));
        assert!(call("rm_rf", json!({})).unwrap_err().contains("Unknown command"));
        // The command-line folder is handed out once, not on every reload.
        assert_eq!(call("launch_repo", json!({})).unwrap(), json!("/somewhere"));
        assert_eq!(call("launch_repo", json!({})).unwrap(), Value::Null);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn lists_visible_subfolders() {
        let dir = temp_dir("list");
        fs::create_dir_all(dir.join("Beta/.git")).unwrap();
        fs::create_dir_all(dir.join("alpha")).unwrap();
        fs::create_dir_all(dir.join(".hidden")).unwrap();
        fs::write(dir.join("file.txt"), "").unwrap();

        let f = list_dir(Some(dir.to_string_lossy().into())).unwrap();
        let names: Vec<_> = f.dirs.iter().map(|d| (d.name.as_str(), d.repo)).collect();
        assert_eq!(names, [("alpha", false), ("Beta", true)]);
        assert!(!f.repo);

        let up = list_dir(Some(dir.join("alpha/..").to_string_lossy().into())).unwrap();
        assert_eq!(up.path, f.path);
        assert!(list_dir(Some(dir.join("missing").to_string_lossy().into())).is_err());
        fs::remove_dir_all(dir).ok();
    }
}
