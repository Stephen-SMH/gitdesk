import { useEffect, useRef, useState } from "react";
import { errorText, web, type Folder } from "./api";

/**
 * The web app's stand-in for the native folder dialog. A browser can't hand us
 * a real path, so gitdesk-web lists folders and we pick one here.
 */
export function FolderPicker(props: { title: string; start: string | null; onDone: (path: string | null) => void }) {
  const [folder, setFolder] = useState<Folder | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // A long path should show the folder we're in, not where the path starts.
  useEffect(() => {
    if (input.current) input.current.scrollLeft = input.current.scrollWidth;
  }, [folder]);

  const go = (path: string | null) =>
    web
      .listDir(path)
      .then((f) => {
        setFolder(f);
        setTyped(f.path);
        setError(null);
        return f;
      })
      .catch((e) => {
        setError(errorText(e));
        return null;
      });

  useEffect(() => {
    // An empty or stale start (a repo that moved) falls back to the home folder.
    go(props.start).then((f) => {
      if (!f && props.start) go(null);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Choose what's listed, or first go to a path that was typed but not opened.
  const choose = async () => {
    const f = typed.trim() === folder?.path ? folder : await go(typed);
    if (f) props.onDone(f.path);
  };

  return (
    <div className="modal-bg" onClick={() => props.onDone(null)}>
      <form
        className="modal picker"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          go(typed);
        }}
      >
        <h2>{props.title}</h2>
        <div className="row">
          <input ref={input} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Folder path" placeholder="~/code" />
          <button type="submit">Go</button>
        </div>
        {error && <p className="hint picker-error">{error}</p>}
        <ul className="picker-list">
          {folder?.parent && (
            <li className="up" onClick={() => go(folder.parent)}>
              ..
            </li>
          )}
          {folder?.dirs.map((d) => (
            <li key={d.path} onClick={() => go(d.path)} title={d.path}>
              <span className="dd-name">{d.name}</span>
              {d.repo && <span className="tag">repository</span>}
            </li>
          ))}
          {folder && folder.dirs.length === 0 && <li className="empty">No folders inside</li>}
        </ul>
        <div className="modal-actions">
          {folder?.repo && <span className="hint picker-note">This folder is a git repository</span>}
          <button type="button" onClick={() => props.onDone(null)}>Cancel</button>
          <button type="button" className="primary" disabled={!typed.trim()} onClick={choose}>
            Choose folder
          </button>
        </div>
      </form>
    </div>
  );
}
