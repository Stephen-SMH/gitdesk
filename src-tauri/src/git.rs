//! Thin wrapper over the system `git` binary. Shelling out (like GitHub Desktop
//! does) means we reuse the user's config, hooks and credential helpers.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

pub type GitResult<T> = Result<T, String>;

/// Run git in `repo` and return stdout. Non-zero exit is an error unless the
/// code is listed in `ok_codes` (e.g. `diff --no-index` exits 1 on changes).
fn run_with(repo: &Path, args: &[&str], ok_codes: &[i32]) -> GitResult<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        // Never block on an interactive username/password prompt.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .output()
        .map_err(|e| format!("Could not run git: {e}. Is git installed and on PATH?"))?;
    let code = out.status.code().unwrap_or(-1);
    if out.status.success() || ok_codes.contains(&code) {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("git {} failed ({code})", args[0]) } else { err })
    }
}

fn run(repo: &Path, args: &[&str]) -> GitResult<String> {
    run_with(repo, args, &[])
}

fn has_head(repo: &Path) -> bool {
    run(repo, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

#[derive(Serialize)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub remote_url: Option<String>,
    pub has_commits: bool,
}

pub fn repo_info(path: &Path) -> GitResult<RepoInfo> {
    let top = run(path, &["rev-parse", "--show-toplevel"])
        .map_err(|_| "This folder is not a git repository.".to_string())?;
    let top = top.trim().to_string();
    let root = Path::new(&top);
    let branch = run(root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "(detached HEAD)".into());
    let upstream = run(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let (mut ahead, mut behind) = (0, 0);
    if upstream.is_some() {
        if let Ok(s) = run(root, &["rev-list", "--left-right", "--count", "HEAD...@{u}"]) {
            let mut it = s.split_whitespace().map(|n| n.parse().unwrap_or(0));
            ahead = it.next().unwrap_or(0);
            behind = it.next().unwrap_or(0);
        }
    }
    let remote_url = run(root, &["remote", "get-url", "origin"])
        .ok()
        .map(|s| s.trim().to_string());
    Ok(RepoInfo {
        name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| top.clone()),
        path: top.clone(),
        branch,
        upstream,
        ahead,
        behind,
        remote_url,
        has_commits: has_head(root),
    })
}

#[derive(Serialize)]
pub struct FileChange {
    pub path: String,
    /// One of: new, modified, deleted, renamed, conflicted.
    pub kind: String,
    pub untracked: bool,
    pub old_path: Option<String>,
}

pub fn status(repo: &Path) -> GitResult<Vec<FileChange>> {
    let out = run(repo, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let mut parts = out.split('\0').filter(|s| !s.is_empty());
    let mut changes = Vec::new();
    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            continue;
        }
        let (x, y) = (entry.as_bytes()[0] as char, entry.as_bytes()[1] as char);
        let path = entry[3..].to_string();
        let mut old_path = None;
        let kind = match (x, y) {
            ('?', '?') => "new",
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => "conflicted",
            ('R', _) | (_, 'R') => {
                old_path = parts.next().map(str::to_string);
                "renamed"
            }
            ('A', _) => "new",
            ('D', _) | (_, 'D') => "deleted",
            _ => "modified",
        };
        changes.push(FileChange { path, kind: kind.into(), untracked: x == '?', old_path });
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(changes)
}

/// Diff of a working-tree file against HEAD (staged and unstaged together).
pub fn diff_file(repo: &Path, file: &str, untracked: bool) -> GitResult<String> {
    if untracked || !has_head(repo) {
        return run_with(repo, &["diff", "--no-color", "--no-index", "--", "/dev/null", file], &[1]);
    }
    run(repo, &["diff", "--no-color", "HEAD", "--", file])
}

/// Commit exactly `files`, leaving any other staged or unstaged work alone.
pub fn commit(repo: &Path, files: &[String], summary: &str, description: &str) -> GitResult<String> {
    if files.is_empty() {
        return Err("Select at least one file to commit.".into());
    }
    if summary.trim().is_empty() {
        return Err("A commit summary is required.".into());
    }
    let mut add = vec!["add", "-A", "--"];
    add.extend(files.iter().map(String::as_str));
    run(repo, &add)?;
    let mut args = vec!["commit", "-m", summary.trim()];
    if !description.trim().is_empty() {
        args.extend(["-m", description.trim()]);
    }
    args.push("--");
    args.extend(files.iter().map(String::as_str));
    run(repo, &args)
}

pub fn discard(repo: &Path, files: &[FileChange]) -> GitResult<()> {
    let untracked: Vec<&str> = files.iter().filter(|f| f.untracked).map(|f| f.path.as_str()).collect();
    let tracked: Vec<&str> = files.iter().filter(|f| !f.untracked).map(|f| f.path.as_str()).collect();
    if !tracked.is_empty() {
        let mut args = vec!["restore", "--staged", "--worktree", "--source=HEAD", "--"];
        args.extend(&tracked);
        run(repo, &args)?;
    }
    if !untracked.is_empty() {
        let mut args = vec!["clean", "-f", "--"];
        args.extend(&untracked);
        run(repo, &args)?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub summary: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub date: String,
}

pub fn log(repo: &Path, skip: u32, limit: u32) -> GitResult<Vec<Commit>> {
    if !has_head(repo) {
        return Ok(Vec::new());
    }
    let skip = format!("--skip={skip}");
    let limit = format!("-n{limit}");
    let out = run(repo, &["log", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%b%x1e", &skip, &limit])?;
    Ok(out
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            (f.len() >= 7).then(|| Commit {
                sha: f[0].into(),
                short: f[1].into(),
                summary: f[2].into(),
                author: f[3].into(),
                email: f[4].into(),
                date: f[5].into(),
                body: f[6].trim().into(),
            })
        })
        .collect())
}

#[derive(Serialize)]
pub struct CommitFile {
    pub path: String,
    pub kind: String,
}

pub fn commit_files(repo: &Path, sha: &str) -> GitResult<Vec<CommitFile>> {
    let out = run(repo, &["show", "--no-color", "--name-status", "--format=", "-z", "-M", sha])?;
    let mut parts = out.split('\0').map(|s| s.trim_start_matches('\n')).filter(|s| !s.is_empty());
    let mut files = Vec::new();
    while let Some(code) = parts.next() {
        let kind = match code.chars().next() {
            Some('A') => "new",
            Some('D') => "deleted",
            Some('R') | Some('C') => {
                parts.next(); // old path
                "renamed"
            }
            _ => "modified",
        };
        if let Some(path) = parts.next() {
            files.push(CommitFile { path: path.into(), kind: kind.into() });
        }
    }
    Ok(files)
}

pub fn commit_diff(repo: &Path, sha: &str, file: &str) -> GitResult<String> {
    run(repo, &["show", "--no-color", "--format=", "-M", sha, "--", file])
}

#[derive(Serialize)]
pub struct Branches {
    pub current: String,
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

pub fn branches(repo: &Path) -> GitResult<Branches> {
    let list = |pattern: &str| -> GitResult<Vec<String>> {
        Ok(run(repo, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", pattern])?
            .lines()
            .map(str::to_string)
            .collect())
    };
    let local = list("refs/heads")?;
    let remote = list("refs/remotes")?
        .into_iter()
        // `origin/HEAD` shortens to `origin`; skip it and anything already local.
        .filter(|r| r.contains('/') && !r.ends_with("/HEAD"))
        .filter(|r| {
            let short = r.split_once('/').map(|(_, b)| b).unwrap_or(r);
            !local.iter().any(|l| l == short)
        })
        .collect();
    let current = run(repo, &["symbolic-ref", "--short", "-q", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
    Ok(Branches { current, local, remote })
}

pub fn checkout(repo: &Path, branch: &str, remote: bool) -> GitResult<()> {
    if remote {
        // origin/feature -> local feature tracking origin/feature
        run(repo, &["switch", "--track", branch])?;
    } else {
        run(repo, &["switch", branch])?;
    }
    Ok(())
}

pub fn create_branch(repo: &Path, name: &str) -> GitResult<()> {
    let name = name.trim();
    run(repo, &["check-ref-format", "--branch", name]).map_err(|_| format!("'{name}' is not a valid branch name."))?;
    run(repo, &["switch", "-c", name])?;
    Ok(())
}

pub fn fetch(repo: &Path) -> GitResult<()> {
    run(repo, &["fetch", "--all", "--prune"])?;
    Ok(())
}

pub fn pull(repo: &Path) -> GitResult<()> {
    run(repo, &["pull", "--no-rebase", "--no-edit"])?;
    Ok(())
}

pub fn push(repo: &Path) -> GitResult<()> {
    let info = repo_info(repo)?;
    if info.upstream.is_some() {
        run(repo, &["push"])?;
    } else {
        if info.remote_url.is_none() {
            return Err("This repository has no 'origin' remote to publish to.".into());
        }
        run(repo, &["push", "-u", "origin", &info.branch])?;
    }
    Ok(())
}

pub fn clone(url: &str, parent: &Path) -> GitResult<String> {
    let name = url
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("repo")
        .trim_end_matches(".git")
        .to_string();
    if name.is_empty() {
        return Err("Could not work out a folder name from that URL.".into());
    }
    let dest = parent.join(&name);
    if dest.exists() {
        return Err(format!("{} already exists.", dest.display()));
    }
    run(parent, &["clone", "--", url, &name])?;
    Ok(dest.to_string_lossy().into_owned())
}

pub fn init(path: &Path) -> GitResult<()> {
    run(path, &["init", "-b", "main"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gitdesk-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        init(&dir).unwrap();
        run(&dir, &["config", "user.name", "Test"]).unwrap();
        run(&dir, &["config", "user.email", "test@example.com"]).unwrap();
        run(&dir, &["config", "commit.gpgsign", "false"]).unwrap();
        dir
    }

    #[test]
    fn commit_only_selected_files() {
        let dir = temp_repo("commit");
        fs::write(dir.join("a.txt"), "a\n").unwrap();
        fs::write(dir.join("b.txt"), "b\n").unwrap();
        let s = status(&dir).unwrap();
        assert_eq!(s.len(), 2);
        assert!(s.iter().all(|f| f.kind == "new" && f.untracked));
        assert!(diff_file(&dir, "a.txt", true).unwrap().contains("+a"));

        commit(&dir, &["a.txt".into()], "Add a", "").unwrap();
        let s = status(&dir).unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].path, "b.txt");

        let commits = log(&dir, 0, 10).unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].summary, "Add a");
        let files = commit_files(&dir, &commits[0].sha).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].path.as_str(), files[0].kind.as_str()), ("a.txt", "new"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn modify_diff_and_discard() {
        let dir = temp_repo("discard");
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        commit(&dir, &["a.txt".into()], "Init", "with body").unwrap();
        assert_eq!(log(&dir, 0, 1).unwrap()[0].body, "with body");

        fs::write(dir.join("a.txt"), "two\n").unwrap();
        fs::write(dir.join("junk.txt"), "x").unwrap();
        let s = status(&dir).unwrap();
        assert_eq!(s.iter().find(|f| f.path == "a.txt").unwrap().kind, "modified");
        let d = diff_file(&dir, "a.txt", false).unwrap();
        assert!(d.contains("-one") && d.contains("+two"));

        discard(&dir, &s).unwrap();
        assert!(status(&dir).unwrap().is_empty());
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        assert!(!dir.join("junk.txt").exists());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn branches_and_info() {
        let dir = temp_repo("branch");
        assert!(!repo_info(&dir).unwrap().has_commits);
        assert!(log(&dir, 0, 10).unwrap().is_empty());
        fs::write(dir.join("a.txt"), "a").unwrap();
        commit(&dir, &["a.txt".into()], "Init", "").unwrap();

        create_branch(&dir, "feature/x").unwrap();
        assert!(create_branch(&dir, "bad name..").is_err());
        let b = branches(&dir).unwrap();
        assert_eq!(b.current, "feature/x");
        assert!(b.local.contains(&"main".to_string()));

        checkout(&dir, "main", false).unwrap();
        let info = repo_info(&dir).unwrap();
        assert_eq!(info.branch, "main");
        assert!(info.has_commits && info.upstream.is_none() && info.remote_url.is_none());
        assert!(push(&dir).is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn clone_and_track() {
        let origin = temp_repo("origin");
        fs::write(origin.join("a.txt"), "a").unwrap();
        commit(&origin, &["a.txt".into()], "Init", "").unwrap();
        let parent = std::env::temp_dir().join(format!("gitdesk-test-clone-{}", std::process::id()));
        let _ = fs::remove_dir_all(&parent);
        fs::create_dir_all(&parent).unwrap();

        let path = clone(origin.to_str().unwrap(), &parent).unwrap();
        let cloned = Path::new(&path);
        let info = repo_info(cloned).unwrap();
        assert_eq!(info.upstream.as_deref(), Some("origin/main"));
        assert_eq!((info.ahead, info.behind), (0, 0));

        fs::write(cloned.join("b.txt"), "b").unwrap();
        run(cloned, &["config", "user.name", "T"]).unwrap();
        run(cloned, &["config", "user.email", "t@example.com"]).unwrap();
        commit(cloned, &["b.txt".into()], "Add b", "").unwrap();
        assert_eq!(repo_info(cloned).unwrap().ahead, 1);
        fs::remove_dir_all(parent).ok();
        fs::remove_dir_all(origin).ok();
    }
}
