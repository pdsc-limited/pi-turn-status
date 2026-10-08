# Pi Turn Status

Pi Turn Status is a [Pi](https://github.com/earendil-works/pi) extension that appends a durable status marker after each Pi turn. Markers are rendered in the TUI only; they do not replace Pi's normal footer or add content to the model context.

Each marker records the turn's start and end timestamps, elapsed time when a start timestamp is available, assistant and tool-result usage, cumulative usage, stop reason, and failed-tool identifiers. Expanded markers also show cost totals and failed-tool details.

A **Pi turn** is the interval from Pi's `turn_start` event through its matching `turn_end` event. Its usage is the usage reported on that turn's assistant message and tool results.

## Compatibility

Supported and tested with Pi 1.0.4.

## Load locally

From this repository checkout, start Pi with the extension explicitly:

```sh
pi -e ./extensions/turn-status.ts
```

This project does not perform a global installation. In particular, it does not install, copy, or link the extension into `~/.pi/agent/extensions/`.

## Visibility controls

Markers are recorded for every completed turn, whether or not they are shown. Rendering is hidden by default.

Use these Pi commands during a session:

- `/turn-status show` — show markers for subsequent turns.
- `/turn-status hide` — hide markers for subsequent turns.
- `/turn-status` — toggle visibility for subsequent turns.

Visibility is stored with each marker. Therefore, a command changes the visibility of future markers only; it does not retroactively show or hide existing markers. The chosen visibility is also recorded on the current session branch, so it is reconstructed when that branch is revisited.

See [configuration](docs/configuration.md) for a project default.

## Privacy

Provider error messages, when Pi supplies them, are sanitized, bounded, stored in the durable marker data, and may be rendered in the TUI. Treat session transcripts containing these entries as potentially sensitive and do not share them without review.

## Development and validation

Install dependencies, then run the available validation commands:

```sh
npm ci
npm run typecheck
npm test
npm run check
```

`npm run check` runs both type checking and tests.
