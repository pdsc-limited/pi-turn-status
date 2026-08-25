# Pi Turn Status Extension

## Purpose

This repository develops a Pi coding-agent extension that records and renders a durable status line at the end of every turn. It is intended to make unattended sessions diagnosable by showing turn timestamps, elapsed time, token/cache usage, cumulative usage, and (when available) stop/error information. Marker data is always appended durably to the trace. Rendering is hidden by default, with a project-local setting able to make shown the default for that project. Runtime visibility controls are `/turn-status show`, `/turn-status hide`, and `/turn-status` with no argument to toggle.

## Workspace layout

`/workspace/pi-turn-status/` is the project container. `dev/` is its primary Git checkout. Create additional linked worktrees as siblings of `dev/` only when needed.

Keep build and generated artifacts under `build/` in the relevant checkout. Do not put them in the project container or global temporary directories.

## Extension layout

- `extensions/` — Pi extension source files; the initial extension will be `turn-status.ts`.
- `test/` — deterministic tests or fixtures for formatting/usage aggregation logic.
- `docs/` — user-facing installation, configuration, and compatibility notes.

The extension must use Pi's public extension API. Custom transcript data must be appended with `pi.appendEntry()` and rendered with `pi.registerEntryRenderer()` so it remains durable but outside model context.

## Installation and permissions

During development, load the extension from this checkout (for example through the project's `.pi/extensions/` link/copy or Pi's explicit extension path). Do not write, copy, symlink, or install anything into `~/.pi/agent/extensions/` without explicit user approval in the current conversation.

Do not modify Pi's own installation, session JSONL files, global config, model/provider configuration, or other projects unless the user explicitly requests it.

Treat session transcripts and provider errors as potentially sensitive. Tests and documentation must use synthetic fixtures; do not commit real session data, credentials, API keys, or absolute personal paths.

## Development workflow

1. Read the current Pi extension documentation before using APIs that are not already established by this repository.
2. Keep turn status entries TUI-only and avoid adding custom data to the LLM context.
3. Preserve Pi's normal footer; do not replace it with `ctx.ui.setFooter` for this feature.
4. Test the pure formatting/aggregation logic separately from Pi runtime integration where practical.
5. Before committing, run the documented validation commands and inspect `git diff`/`git status`.

## Git

Make small, focused commits. Do not use destructive Git commands (`reset --hard`, `clean`, force-push) unless explicitly requested. Do not change global Git configuration.
