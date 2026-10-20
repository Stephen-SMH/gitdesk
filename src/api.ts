import { invoke, isTauri } from "@tauri-apps/api/core";

/** True inside the Tauri window; false when gitdesk-web serves the UI to a browser. */
export const isDesktop = isTauri();

/**
 * Run a backend command. The desktop app goes through Tauri; the web app POSTs
 * the same command and arguments to gitdesk-web (src-web), which answers with
 * the same JSON, or with the error text and a non-2xx status.
 */
async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isDesktop) return invoke<T>(cmd, args);
  let res: Response;
  try {
    res = await fetch(`/api/${cmd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  } catch {
    throw "Lost connection to gitdesk-web. Is it still running?";
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw typeof body === "string" ? body : `gitdesk-web: ${res.status} ${res.statusText}`;
  return body as T;
}

export type RepoInfo = {
  path: string;
  name: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  remote_url: string | null;
  has_commits: boolean;
};

export type ChangeKind = "new" | "modified" | "deleted" | "renamed" | "conflicted";

export type FileChange = {
  path: string;
  kind: ChangeKind;
  untracked: boolean;
  old_path: string | null;
};

export type Commit = {
  sha: string;
  short: string;
  summary: string;
  body: string;
  author: string;
  email: string;
  date: string;
};

export type CommitFile = { path: string; kind: ChangeKind };

export type Branches = { current: string; local: string[]; remote: string[] };

/** A folder as the web app's folder picker sees it. */
export type Folder = {
  path: string;
  parent: string | null;
  repo: boolean;
  dirs: { name: string; path: string; repo: boolean }[];
};

export const git = {
  repoInfo: (repo: string) => call<RepoInfo>("repo_info", { repo }),
  status: (repo: string) => call<FileChange[]>("status", { repo }),
  diffFile: (repo: string, file: string, untracked: boolean) =>
    call<string>("diff_file", { repo, file, untracked }),
  commit: (repo: string, files: string[], summary: string, description: string) =>
    call<string>("commit", { repo, files, summary, description }),
  discard: (repo: string, files: { path: string; untracked: boolean }[]) =>
    call<void>("discard", { repo, files }),
  log: (repo: string, skip: number, limit: number) => call<Commit[]>("log", { repo, skip, limit }),
  commitFiles: (repo: string, sha: string) => call<CommitFile[]>("commit_files", { repo, sha }),
  commitDiff: (repo: string, sha: string, file: string) =>
    call<string>("commit_diff", { repo, sha, file }),
  branches: (repo: string) => call<Branches>("branches", { repo }),
  checkout: (repo: string, branch: string, remote: boolean) =>
    call<void>("checkout", { repo, branch, remote }),
  createBranch: (repo: string, name: string) => call<void>("create_branch", { repo, name }),
  fetch: (repo: string) => call<void>("fetch", { repo }),
  pull: (repo: string) => call<void>("pull", { repo }),
  push: (repo: string) => call<void>("push", { repo }),
  clone: (url: string, parent: string) => call<string>("clone_repo", { url, parent }),
  init: (path: string) => call<void>("init_repo", { path }),
  launchRepo: () => call<string | null>("launch_repo"),
};

/** Web-only: the browser can't see the file system or open Finder, so gitdesk-web does it. */
export const web = {
  listDir: (path: string | null) => call<Folder>("list_dir", { path }),
  reveal: (path: string) => call<void>("reveal", { path }),
};

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

/** Recent repositories live in localStorage; losing them is harmless. */
const RECENT_KEY = "gitdesk.recent";

export function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveRecent(paths: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(paths.slice(0, 12)));
  } catch {
    /* storage unavailable */
  }
}
