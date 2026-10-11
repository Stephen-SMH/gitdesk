import { invoke } from "@tauri-apps/api/core";

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

export const git = {
  repoInfo: (repo: string) => invoke<RepoInfo>("repo_info", { repo }),
  status: (repo: string) => invoke<FileChange[]>("status", { repo }),
  diffFile: (repo: string, file: string, untracked: boolean) =>
    invoke<string>("diff_file", { repo, file, untracked }),
  commit: (repo: string, files: string[], summary: string, description: string) =>
    invoke<string>("commit", { repo, files, summary, description }),
  discard: (repo: string, files: { path: string; untracked: boolean }[]) =>
    invoke<void>("discard", { repo, files }),
  log: (repo: string, skip: number, limit: number) => invoke<Commit[]>("log", { repo, skip, limit }),
  commitFiles: (repo: string, sha: string) => invoke<CommitFile[]>("commit_files", { repo, sha }),
  commitDiff: (repo: string, sha: string, file: string) =>
    invoke<string>("commit_diff", { repo, sha, file }),
  branches: (repo: string) => invoke<Branches>("branches", { repo }),
  checkout: (repo: string, branch: string, remote: boolean) =>
    invoke<void>("checkout", { repo, branch, remote }),
  createBranch: (repo: string, name: string) => invoke<void>("create_branch", { repo, name }),
  fetch: (repo: string) => invoke<void>("fetch", { repo }),
  pull: (repo: string) => invoke<void>("pull", { repo }),
  push: (repo: string) => invoke<void>("push", { repo }),
  clone: (url: string, parent: string) => invoke<string>("clone_repo", { url, parent }),
  init: (path: string) => invoke<void>("init_repo", { path }),
  launchRepo: () => invoke<string | null>("launch_repo"),
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
