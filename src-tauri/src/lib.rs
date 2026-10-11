mod git;

use git::{Branches, Commit, CommitFile, FileChange, GitResult, RepoInfo};
use serde::Deserialize;
use std::path::PathBuf;

/// Git can be slow (network, big repos), so every command runs on a blocking
/// thread instead of the main thread, which would freeze the window.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> GitResult<T> + Send + 'static) -> GitResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
struct DiscardFile {
    path: String,
    untracked: bool,
}

#[tauri::command]
async fn repo_info(repo: PathBuf) -> GitResult<RepoInfo> {
    blocking(move || git::repo_info(&repo)).await
}

#[tauri::command]
async fn status(repo: PathBuf) -> GitResult<Vec<FileChange>> {
    blocking(move || git::status(&repo)).await
}

#[tauri::command]
async fn diff_file(repo: PathBuf, file: String, untracked: bool) -> GitResult<String> {
    blocking(move || git::diff_file(&repo, &file, untracked)).await
}

#[tauri::command]
async fn commit(repo: PathBuf, files: Vec<String>, summary: String, description: String) -> GitResult<String> {
    blocking(move || git::commit(&repo, &files, &summary, &description)).await
}

#[tauri::command]
async fn discard(repo: PathBuf, files: Vec<DiscardFile>) -> GitResult<()> {
    let files = files
        .into_iter()
        .map(|f| FileChange { path: f.path, kind: String::new(), untracked: f.untracked, old_path: None })
        .collect::<Vec<_>>();
    blocking(move || git::discard(&repo, &files)).await
}

#[tauri::command]
async fn log(repo: PathBuf, skip: u32, limit: u32) -> GitResult<Vec<Commit>> {
    blocking(move || git::log(&repo, skip, limit)).await
}

#[tauri::command]
async fn commit_files(repo: PathBuf, sha: String) -> GitResult<Vec<CommitFile>> {
    blocking(move || git::commit_files(&repo, &sha)).await
}

#[tauri::command]
async fn commit_diff(repo: PathBuf, sha: String, file: String) -> GitResult<String> {
    blocking(move || git::commit_diff(&repo, &sha, &file)).await
}

#[tauri::command]
async fn branches(repo: PathBuf) -> GitResult<Branches> {
    blocking(move || git::branches(&repo)).await
}

#[tauri::command]
async fn checkout(repo: PathBuf, branch: String, remote: bool) -> GitResult<()> {
    blocking(move || git::checkout(&repo, &branch, remote)).await
}

#[tauri::command]
async fn create_branch(repo: PathBuf, name: String) -> GitResult<()> {
    blocking(move || git::create_branch(&repo, &name)).await
}

#[tauri::command]
async fn fetch(repo: PathBuf) -> GitResult<()> {
    blocking(move || git::fetch(&repo)).await
}

#[tauri::command]
async fn pull(repo: PathBuf) -> GitResult<()> {
    blocking(move || git::pull(&repo)).await
}

#[tauri::command]
async fn push(repo: PathBuf) -> GitResult<()> {
    blocking(move || git::push(&repo)).await
}

#[tauri::command]
async fn clone_repo(url: String, parent: PathBuf) -> GitResult<String> {
    blocking(move || git::clone(&url, &parent)).await
}

/// A folder passed on the command line (`gitdesk ~/code/project`) opens directly.
#[tauri::command]
fn launch_repo() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir())
}

#[tauri::command]
async fn init_repo(path: PathBuf) -> GitResult<()> {
    blocking(move || git::init(&path)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            repo_info,
            status,
            diff_file,
            commit,
            discard,
            log,
            commit_files,
            commit_diff,
            branches,
            checkout,
            create_branch,
            fetch,
            pull,
            push,
            clone_repo,
            init_repo,
            launch_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
