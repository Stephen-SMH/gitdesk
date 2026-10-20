import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  git,
  errorText,
  isDesktop,
  loadRecent,
  saveRecent,
  type Branches,
  type ChangeKind,
  type Commit,
  type CommitFile,
  type FileChange,
  type RepoInfo,
} from "./api";
import { DiffView } from "./DiffView";
import { FolderPicker } from "./FolderPicker";
import { confirmAction, openExternal, pickFolderNative, revealFolder } from "./platform";
import "./App.css";

type Tab = "changes" | "history";
type Busy = null | "fetch" | "pull" | "push" | "commit" | "clone" | "branch";

const KIND_LABEL: Record<ChangeKind, string> = {
  new: "+",
  modified: "•",
  deleted: "−",
  renamed: "→",
  conflicted: "!",
};

function KindBadge({ kind }: { kind: ChangeKind }) {
  return (
    <span className={`kind kind-${kind}`} title={kind}>
      {KIND_LABEL[kind]}
    </span>
  );
}

function relTime(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const units: [number, string][] = [
    [31536000, "year"],
    [2592000, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)} ${u}${s >= 2 * n ? "s" : ""} ago`;
  return "just now";
}

/** https URL for a GitHub/GitLab-style remote, or null. */
function webUrl(remote: string | null) {
  if (!remote) return null;
  const m = /^(?:git@|ssh:\/\/git@|https?:\/\/)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(remote);
  return m ? `https://${m[1]}/${m[2]}` : null;
}

function splitPath(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

/** Parent folder of an absolute path, with either separator. */
function parentDir(p: string) {
  return p.replace(/[\\/][^\\/]*[\\/]?$/, "");
}

export default function App() {
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [repoPath, setRepoPath] = useState<string | null>(() => loadRecent()[0] ?? null);
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [tab, setTab] = useState<Tab>("changes");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [menu, setMenu] = useState<null | "repo" | "branch">(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [picker, setPicker] = useState<null | { title: string; start: string | null; resolve: (path: string | null) => void }>(null);

  // changes tab
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");

  // history tab
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [activeCommit, setActiveCommit] = useState<Commit | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFile[]>([]);
  const [commitFile, setCommitFile] = useState<string | null>(null);

  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const fail = useCallback((e: unknown) => setError(errorText(e)), []);

  const refresh = useCallback(async () => {
    if (!repoPath) return;
    try {
      const [i, s] = await Promise.all([git.repoInfo(repoPath), git.status(repoPath)]);
      setInfo(i);
      setChanges(s);
    } catch (e) {
      setInfo(null);
      fail(e);
    }
  }, [repoPath, fail]);

  const loadHistory = useCallback(
    async (reset: boolean) => {
      if (!repoPath) return;
      const skip = reset ? 0 : commits.length;
      try {
        const page = await git.log(repoPath, skip, 100);
        setCommits((prev) => (reset ? page : [...prev, ...page]));
        setHasMore(page.length === 100);
      } catch (e) {
        fail(e);
      }
    },
    [repoPath, commits.length, fail],
  );

  // Switching repository resets everything.
  useEffect(() => {
    setInfo(null);
    setChanges([]);
    setExcluded(new Set());
    setSelected(null);
    setCommits([]);
    setActiveCommit(null);
    setDiff(null);
    setSummary("");
    setDescription("");
    refresh();
  }, [repoPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === "history") loadHistory(true);
  }, [tab, repoPath, info?.branch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Name the browser tab after the repository (the desktop window title is fixed).
  useEffect(() => {
    document.title = info ? `${info.name} · GitDesk` : "GitDesk";
  }, [info?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pick up edits made in other apps when the window regains focus.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Load the diff for whatever is selected.
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    let job: Promise<string> | null = null;
    if (tab === "changes" && selected) {
      const f = changes.find((c) => c.path === selected);
      if (f) job = git.diffFile(repoPath, f.path, f.untracked);
    } else if (tab === "history" && activeCommit && commitFile) {
      job = git.commitDiff(repoPath, activeCommit.sha, commitFile);
    }
    if (!job) {
      setDiff(null);
      return;
    }
    setDiffLoading(true);
    job
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && (setDiff(null), fail(e)))
      .finally(() => !cancelled && setDiffLoading(false));
    return () => {
      cancelled = true;
    };
  }, [repoPath, tab, selected, changes, activeCommit, commitFile, fail]);

  // Drop a selection that no longer exists after a refresh.
  useEffect(() => {
    if (selected && !changes.some((c) => c.path === selected)) setSelected(changes[0]?.path ?? null);
    if (!selected && changes.length) setSelected(changes[0].path);
  }, [changes, selected]);

  const openRepo = useCallback(
    async (path: string) => {
      try {
        const i = await git.repoInfo(path);
        const next = [i.path, ...recent.filter((r) => r !== i.path)];
        setRecent(next);
        saveRecent(next);
        setRepoPath(i.path);
        setMenu(null);
        setError(null);
      } catch (e) {
        const msg = errorText(e);
        if (msg.includes("not a git repository")) {
          const ok = await confirmAction(`${path} is not a git repository. Create one here?`, {
            title: "Create repository",
            okLabel: "Create",
          });
          if (ok) {
            try {
              await git.init(path);
              return openRepo(path);
            } catch (e2) {
              return fail(e2);
            }
          }
        } else fail(e);
      }
    },
    [recent, fail],
  );

  useEffect(() => {
    git.launchRepo().then((p) => {
      if (p) openRepo(p);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Native dialog on desktop; in the browser, the FolderPicker rendered below. */
  const pickFolder = useCallback(
    (title: string) =>
      isDesktop
        ? pickFolderNative(title)
        : new Promise<string | null>((resolve) => setPicker({ title, start: repoPath && parentDir(repoPath), resolve })),
    [repoPath],
  );

  const addLocal = async () => {
    const dir = await pickFolder("Choose a repository folder");
    if (dir) openRepo(dir);
  };

  const removeRecent = (path: string) => {
    const next = recent.filter((r) => r !== path);
    setRecent(next);
    saveRecent(next);
    if (repoPath === path) setRepoPath(next[0] ?? null);
  };

  const run = async (kind: Busy, job: () => Promise<unknown>, done?: string) => {
    setBusy(kind);
    setError(null);
    try {
      await job();
      if (done) setNotice(done);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const included = changes.filter((c) => !excluded.has(c.path));
  const allIncluded = changes.length > 0 && included.length === changes.length;

  const doCommit = () =>
    repoPath &&
    run("commit", async () => {
      await git.commit(
        repoPath,
        included.flatMap((c) => (c.old_path ? [c.path, c.old_path] : [c.path])),
        summary,
        description,
      );
      setSummary("");
      setDescription("");
      setExcluded(new Set());
      if (tab === "history") loadHistory(true);
    }, `Committed ${included.length} file${included.length === 1 ? "" : "s"} to ${info?.branch}`);

  const doDiscard = async (files: FileChange[]) => {
    if (!repoPath || files.length === 0) return;
    const ok = await confirmAction(
      files.length === 1
        ? `Discard all changes to ${files[0].path}? This cannot be undone.`
        : `Discard changes to ${files.length} files? This cannot be undone.`,
      { title: "Discard changes", kind: "warning", okLabel: "Discard" },
    );
    if (!ok) return;
    try {
      await git.discard(repoPath, files.map((f) => ({ path: f.path, untracked: f.untracked })));
    } catch (e) {
      fail(e);
    }
    refresh();
  };

  const selectCommit = async (c: Commit) => {
    if (!repoPath) return;
    setActiveCommit(c);
    setCommitFile(null);
    try {
      const files = await git.commitFiles(repoPath, c.sha);
      setCommitFiles(files);
      setCommitFile(files[0]?.path ?? null);
    } catch (e) {
      fail(e);
    }
  };

  // Primary remote action, like GitHub Desktop's third toolbar button.
  const remoteAction = useMemo(() => {
    if (!info) return null;
    if (!info.remote_url) return { label: "No remote", detail: "Add an origin remote to sync", disabled: true, kind: null };
    if (!info.upstream)
      return { label: "Publish branch", detail: `Push ${info.branch} to origin`, kind: "push" as const };
    if (info.behind > 0)
      return { label: `Pull origin`, detail: `${info.behind} commit${info.behind > 1 ? "s" : ""} behind`, kind: "pull" as const, count: `↓${info.behind}` };
    if (info.ahead > 0)
      return { label: `Push origin`, detail: `${info.ahead} commit${info.ahead > 1 ? "s" : ""} ahead`, kind: "push" as const, count: `↑${info.ahead}` };
    return { label: "Fetch origin", detail: "Check for new commits", kind: "fetch" as const };
  }, [info]);

  const runRemote = () => {
    if (!repoPath || !remoteAction?.kind) return;
    const k = remoteAction.kind;
    run(k, () => git[k](repoPath), k === "fetch" ? undefined : k === "pull" ? "Pulled latest changes" : "Pushed to origin");
  };

  const toolbar = (
    <header className="toolbar">
      <div className="tb-drop">
        <button className={`tb-btn ${menu === "repo" ? "open" : ""}`} onClick={() => setMenu(menu === "repo" ? null : "repo")}>
          <span className="tb-label">Current repository</span>
          <span className="tb-value">{info?.name ?? (repoPath ? "…" : "None")}</span>
          <span className="caret">▾</span>
        </button>
        {menu === "repo" && (
          <RepoMenu
            recent={recent}
            current={repoPath}
            onPick={openRepo}
            onRemove={removeRecent}
            onAdd={addLocal}
            onClone={() => {
              setMenu(null);
              setCloneOpen(true);
            }}
          />
        )}
      </div>
      <div className="tb-drop">
        <button
          className={`tb-btn ${menu === "branch" ? "open" : ""}`}
          disabled={!info}
          onClick={() => setMenu(menu === "branch" ? null : "branch")}
        >
          <span className="tb-label">Current branch</span>
          <span className="tb-value">{info?.branch ?? "-"}</span>
          <span className="caret">▾</span>
        </button>
        {menu === "branch" && repoPath && (
          <BranchMenu
            repo={repoPath}
            busy={busy === "branch"}
            onSwitch={(b, remote) =>
              run("branch", async () => {
                await git.checkout(repoPath, b, remote);
                setMenu(null);
              })
            }
            onCreate={(name) =>
              run("branch", async () => {
                await git.createBranch(repoPath, name);
                setMenu(null);
              }, `Created and switched to ${name}`)
            }
            onError={fail}
          />
        )}
      </div>
      <button className="tb-btn tb-remote" disabled={!remoteAction || remoteAction.disabled || busy !== null} onClick={runRemote}>
        <span className="tb-label">{busy && ["fetch", "pull", "push"].includes(busy) ? "Working…" : remoteAction?.detail ?? "Remote"}</span>
        <span className="tb-value">
          {remoteAction?.label ?? "Fetch origin"}
          {remoteAction?.count && <span className="count">{remoteAction.count}</span>}
        </span>
      </button>
      <div className="tb-spacer" />
      {info && (
        <div className="tb-links">
          <button className="link-btn" onClick={() => revealFolder(info.path).catch(fail)}>Show in Finder</button>
          {webUrl(info.remote_url) && (
            <button className="link-btn" onClick={() => openExternal(webUrl(info.remote_url)!).catch(fail)}>View on web</button>
          )}
        </div>
      )}
    </header>
  );

  return (
    <div className="app" onClick={(e) => menu && !(e.target as HTMLElement).closest(".tb-drop") && setMenu(null)}>
      {toolbar}
      {error && (
        <div className="banner banner-error" role="alert">
          <pre>{error}</pre>
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {notice && <Toast text={notice} onDone={() => setNotice(null)} />}

      {!repoPath || !info ? (
        <Welcome onAdd={addLocal} onClone={() => setCloneOpen(true)} recent={recent} onPick={openRepo} />
      ) : (
        <main className="body">
          <aside className="sidebar">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}>
                Changes {changes.length > 0 && <span className="pill">{changes.length}</span>}
              </button>
              <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
                History
              </button>
            </div>

            {tab === "changes" ? (
              <>
                <div className="list-head">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={allIncluded}
                      ref={(el) => {
                        if (el) el.indeterminate = included.length > 0 && !allIncluded;
                      }}
                      onChange={() => setExcluded(allIncluded ? new Set(changes.map((c) => c.path)) : new Set())}
                      disabled={changes.length === 0}
                    />
                    {changes.length} changed file{changes.length === 1 ? "" : "s"}
                  </label>
                  {changes.length > 0 && (
                    <button className="link-btn danger" onClick={() => doDiscard(changes)}>Discard all</button>
                  )}
                </div>
                <ul className="files">
                  {changes.map((c) => {
                    const { dir, name } = splitPath(c.path);
                    return (
                      <li key={c.path} className={selected === c.path ? "sel" : ""} onClick={() => setSelected(c.path)}>
                        <input
                          type="checkbox"
                          checked={!excluded.has(c.path)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() =>
                            setExcluded((prev) => {
                              const n = new Set(prev);
                              n.has(c.path) ? n.delete(c.path) : n.add(c.path);
                              return n;
                            })
                          }
                          aria-label={`Include ${c.path}`}
                        />
                        <span className="fname" title={c.old_path ? `${c.old_path} → ${c.path}` : c.path}>
                          <span className="dir">{dir}</span>
                          {name}
                        </span>
                        <button className="row-act" title="Discard changes" onClick={(e) => (e.stopPropagation(), doDiscard([c]))}>
                          ↺
                        </button>
                        <KindBadge kind={c.kind} />
                      </li>
                    );
                  })}
                  {changes.length === 0 && (
                    <li className="empty">
                      No local changes.
                      <br />
                      Edit files in {info.name} and they show up here.
                    </li>
                  )}
                </ul>
                <form
                  className="commit-box"
                  onSubmit={(e) => {
                    e.preventDefault();
                    doCommit();
                  }}
                >
                  <input
                    placeholder={included.length === 1 ? `Update ${splitPath(included[0].path).name}` : "Summary (required)"}
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    aria-label="Commit summary"
                  />
                  <textarea placeholder="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Commit description" />
                  <button
                    type="submit"
                    className="primary"
                    disabled={busy !== null || included.length === 0 || summary.trim() === ""}
                  >
                    {busy === "commit" ? "Committing…" : (
                      <>Commit to <strong>{info.branch}</strong></>
                    )}
                  </button>
                </form>
              </>
            ) : (
              <ul className="commits">
                {commits.map((c) => (
                  <li key={c.sha} className={activeCommit?.sha === c.sha ? "sel" : ""} onClick={() => selectCommit(c)}>
                    <div className="c-sum">{c.summary}</div>
                    <div className="c-meta">
                      {c.author} · {relTime(c.date)}
                    </div>
                  </li>
                ))}
                {commits.length === 0 && <li className="empty">No commits yet.</li>}
                {hasMore && commits.length > 0 && (
                  <li className="more">
                    <button className="link-btn" onClick={() => loadHistory(false)}>Load more</button>
                  </li>
                )}
              </ul>
            )}
          </aside>

          <section className="main">
            {tab === "changes" ? (
              <>
                {selected && (
                  <div className="file-head">
                    <span className="mono">{selected}</span>
                  </div>
                )}
                <DiffView diff={diff} loading={diffLoading} />
              </>
            ) : activeCommit ? (
              <div className="commit-view">
                <div className="commit-head">
                  <h2>{activeCommit.summary}</h2>
                  {activeCommit.body && <p className="c-body">{activeCommit.body}</p>}
                  <div className="c-meta">
                    <strong>{activeCommit.author}</strong> committed {relTime(activeCommit.date)} ·{" "}
                    <span className="mono">{activeCommit.short}</span> · {commitFiles.length} file{commitFiles.length === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="commit-split">
                  <ul className="files compact">
                    {commitFiles.map((f) => {
                      const { dir, name } = splitPath(f.path);
                      return (
                        <li key={f.path} className={commitFile === f.path ? "sel" : ""} onClick={() => setCommitFile(f.path)}>
                          <span className="fname" title={f.path}>
                            <span className="dir">{dir}</span>
                            {name}
                          </span>
                          <KindBadge kind={f.kind} />
                        </li>
                      );
                    })}
                  </ul>
                  <DiffView diff={diff} loading={diffLoading} />
                </div>
              </div>
            ) : (
              <div className="diff-empty">Select a commit to see what changed.</div>
            )}
          </section>
        </main>
      )}

      {cloneOpen && (
        <CloneDialog
          onClose={() => setCloneOpen(false)}
          pickFolder={pickFolder}
          busy={busy === "clone"}
          onClone={(url, parent) =>
            run("clone", async () => {
              const path = await git.clone(url, parent);
              setCloneOpen(false);
              await openRepo(path);
            }, "Repository cloned")
          }
        />
      )}

      {picker && (
        <FolderPicker
          title={picker.title}
          start={picker.start}
          onDone={(path) => {
            picker.resolve(path);
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}

function RepoMenu(props: {
  recent: string[];
  current: string | null;
  onPick: (p: string) => void;
  onRemove: (p: string) => void;
  onAdd: () => void;
  onClone: () => void;
}) {
  const [filter, setFilter] = useState("");
  const shown = props.recent.filter((r) => r.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="dropdown">
      <input autoFocus placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="dd-group">Recent</div>
      <ul>
        {shown.map((r) => (
          <li key={r} className={r === props.current ? "sel" : ""} onClick={() => props.onPick(r)}>
            <span className="dd-name">{splitPath(r).name}</span>
            <span className="dd-sub">{r}</span>
            <button className="row-act" title="Remove from list" onClick={(e) => (e.stopPropagation(), props.onRemove(r))}>
              ×
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="empty">No repositories</li>}
      </ul>
      <div className="dd-actions">
        <button onClick={props.onAdd}>Add local repository…</button>
        <button onClick={props.onClone}>Clone repository…</button>
      </div>
    </div>
  );
}

function BranchMenu(props: {
  repo: string;
  busy: boolean;
  onSwitch: (b: string, remote: boolean) => void;
  onCreate: (name: string) => void;
  onError: (e: unknown) => void;
}) {
  const [data, setData] = useState<Branches | null>(null);
  const [filter, setFilter] = useState("");
  const { repo, onError } = props;
  useEffect(() => {
    git.branches(repo).then(setData).catch(onError);
  }, [repo, onError]);
  const f = filter.toLowerCase();
  const local = data?.local.filter((b) => b.toLowerCase().includes(f)) ?? [];
  const remote = data?.remote.filter((b) => b.toLowerCase().includes(f)) ?? [];
  const exact = data?.local.includes(filter.trim());
  return (
    <div className="dropdown">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (filter.trim() && !exact) props.onCreate(filter.trim());
        }}
      >
        <input autoFocus placeholder="Filter or type a new branch name" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </form>
      {filter.trim() && !exact && (
        <button className="dd-create" disabled={props.busy} onClick={() => props.onCreate(filter.trim())}>
          + Create branch <strong>{filter.trim()}</strong> from {data?.current || "HEAD"}
        </button>
      )}
      {!data && <div className="dd-group">Loading…</div>}
      {local.length > 0 && <div className="dd-group">Local</div>}
      <ul>
        {local.map((b) => (
          <li key={b} className={b === data?.current ? "sel" : ""} onClick={() => b !== data?.current && props.onSwitch(b, false)}>
            <span className="dd-name">{b === data?.current ? "✓ " : ""}{b}</span>
          </li>
        ))}
      </ul>
      {remote.length > 0 && <div className="dd-group">Remote</div>}
      <ul>
        {remote.map((b) => (
          <li key={b} onClick={() => props.onSwitch(b, true)}>
            <span className="dd-name">{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CloneDialog(props: {
  onClose: () => void;
  onClone: (url: string, parent: string) => void;
  pickFolder: (title: string) => Promise<string | null>;
  busy: boolean;
}) {
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const pick = async () => {
    const dir = await props.pickFolder("Clone into…");
    if (dir) setParent(dir);
  };
  return (
    <div className="modal-bg" onClick={props.onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim() && parent) props.onClone(url.trim(), parent);
        }}
      >
        <h2>Clone a repository</h2>
        <label>
          Repository URL
          <input autoFocus placeholder="https://github.com/owner/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          Local path
          <div className="row">
            <input readOnly placeholder="Choose a parent folder" value={parent} />
            <button type="button" onClick={pick}>Choose…</button>
          </div>
        </label>
        <p className="hint">Private repositories use your existing git credentials (keychain or SSH agent).</p>
        <div className="modal-actions">
          <button type="button" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!url.trim() || !parent || props.busy}>
            {props.busy ? "Cloning…" : "Clone"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Welcome(props: { onAdd: () => void; onClone: () => void; recent: string[]; onPick: (p: string) => void }) {
  return (
    <div className="welcome">
      <div className="logo">⎇</div>
      <h1>Welcome to GitDesk</h1>
      <p>A small desktop git client. Open a repository to see its changes, history and branches.</p>
      <div className="welcome-actions">
        <button className="primary" onClick={props.onAdd}>Add local repository</button>
        <button onClick={props.onClone}>Clone a repository</button>
      </div>
      {props.recent.length > 0 && (
        <ul className="welcome-recent">
          {props.recent.slice(0, 5).map((r) => (
            <li key={r}>
              <button className="link-btn" onClick={() => props.onPick(r)}>{r}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const t = setTimeout(() => done.current(), 2800);
    return () => clearTimeout(t);
  }, [text]);
  return <div className="toast" role="status">{text}</div>;
}
