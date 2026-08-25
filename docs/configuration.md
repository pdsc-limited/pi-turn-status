# Configuration

Turn Status reads an optional project-local configuration file:

```text
<project>/.pi/turn-status.json
```

For example, to show markers by default in a project:

```json
{ "showByDefault": true }
```

`showByDefault` is the only supported setting and must be a boolean. If the file is absent, invalid, or contains unsupported settings, the extension uses its default: hidden.

## Trust requirement

Pi must trust the project before the extension reads this file. For an untrusted project, Turn Status ignores the project configuration and keeps the default hidden.

## Interaction with session commands

The project setting establishes visibility only when no visibility choice has been recorded on the active session branch. `/turn-status show`, `/turn-status hide`, and the no-argument `/turn-status` toggle record a branch-local choice, which takes precedence when that branch is revisited.

Visibility is prospective: it is captured on each newly recorded turn marker. Changing the setting or running a command does not alter the visibility of markers already recorded.

## Cumulative totals

Every marker contains cumulative usage totals calculated from Turn Status markers on the active session branch. These are extension-recorded, branch-local totals: they do not include turns outside that branch, and they are not a session-wide or provider-billed total.

## Stored errors

A marker can store a sanitized, bounded summary of Pi-provided provider error text, its stop reason, and identifiers for failed tools. Sanitization removes terminal control sequences but cannot identify every possible secret, so review transcripts before sharing them.
