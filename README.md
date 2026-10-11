# GitDesk

A lightweight desktop git client in the spirit of GitHub Desktop, built with **Tauri 2**, **Rust** and **React**. The app bundle is about 4.4 MB.

![Changes view](docs/changes.png)

## Features

- **Changes**: every modified, new, deleted and renamed file, with checkboxes. A commit includes exactly the files you tick. Other staged or unstaged work is left alone.
- **Diff view**: old and new line numbers with coloured hunks, for working-tree changes and past commits.
- **Commit**: summary and description. Discard one file or all changes, with a confirmation first.
- **History**: commit list (100 at a time), commit details, and a diff for each file.
- **Branches**: filter, create from the current branch, switch, and check out remote branches with tracking.
- **Sync**: one toolbar button that fetches, pulls, pushes or publishes depending on ahead/behind state.
- **Repositories**: add a local folder (and offer `git init` if it isn't a repo yet), clone by URL, and keep a recent list.
- **Command line**: `gitdesk ~/code/project` opens straight into that repository.
- Light and dark themes that follow the system.

| History | Branches (dark) |
| --- | --- |
| ![History](docs/history.png) | ![Branch picker](docs/branches-dark.png) |

## How it works

```
React UI ──invoke──▶ Tauri commands (src-tauri/src/lib.rs)
                         │  spawn_blocking, so the window never freezes
                         ▼
                    git layer (src-tauri/src/git.rs) ──▶ system `git`
```

GitDesk drives your installed `git` binary, the same way GitHub Desktop does. Your config, hooks, credential helper (Keychain, Git Credential Manager) and SSH agent all work unchanged. `GIT_TERMINAL_PROMPT=0` makes auth failures show up as errors instead of hanging on a hidden prompt.

The git layer has integration tests that run against real temporary repositories. They cover selective commits, diffs, discard, branches, and cloning with ahead/behind tracking.

## Develop

Requirements: Node 20+, Rust (stable), git 2.23+, plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev               # run the app
cd src-tauri && cargo test      # git layer tests
npm run tauri build             # release bundle
```

> **macOS note:** if linking fails with `tapi error: malformed file … unknown architecture`, your Command Line Tools ship an SDK newer than their linker. Point at the older SDK: `export SDKROOT=$(xcrun --show-sdk-path --sdk macosx26.5)` (or the matching path under `/Library/Developer/CommandLineTools/SDKs/`).

## Roadmap

- Stage individual hunks and lines, stash, amend
- Merge, conflict resolution, cherry-pick and revert
- GitHub sign-in, pull request list and creation
- Signed and notarised builds with auto-update

## License

MIT © Soe Moe Htet (Stephen)
