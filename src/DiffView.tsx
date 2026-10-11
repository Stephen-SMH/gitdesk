type Line = { kind: "add" | "del" | "ctx" | "hunk"; text: string; oldNo?: number; newNo?: number };

/** Turn a unified diff into numbered rows, dropping the file headers. */
export function parseDiff(diff: string): { lines: Line[]; binary: boolean } {
  const lines: Line[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("Binary files")) return { lines: [], binary: true };
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: raw });
    } else if (!inHunk) {
      continue;
    } else if (raw.startsWith("diff --git")) {
      inHunk = false;
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return { lines, binary: false };
}

export function DiffView({ diff, loading }: { diff: string | null; loading: boolean }) {
  if (loading) return <div className="diff-empty">Loading diff…</div>;
  if (diff === null) return <div className="diff-empty">Select a file to see its changes.</div>;
  const { lines, binary } = parseDiff(diff);
  if (binary) return <div className="diff-empty">Binary file changed. No text diff to show.</div>;
  if (lines.length === 0) return <div className="diff-empty">No content changes (mode or empty file).</div>;
  return (
    <div className="diff" role="table" aria-label="Diff">
      {lines.map((l, i) => (
        <div key={i} className={`dl dl-${l.kind}`} role="row">
          <span className="ln">{l.oldNo ?? ""}</span>
          <span className="ln">{l.newNo ?? ""}</span>
          <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
          <span className="code">{l.text || " "}</span>
        </div>
      ))}
    </div>
  );
}
