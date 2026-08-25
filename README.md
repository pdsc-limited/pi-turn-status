# Pi Turn Status

A Pi coding-agent extension for durable, per-turn transcript status markers. Its goal is to make long unattended trajectories easier to diagnose without replacing Pi's normal footer or adding data to model context.

Planned marker contents:

- turn start and finish timestamps
- elapsed turn duration
- per-turn input/output/cache token usage
- cumulative token totals
- provider stop/error details when available

> Development scaffold only. No extension implementation or global installation exists yet.

## Development

Work from this checkout (`/workspace/pi-turn-status/dev`). Read [`AGENTS.md`](AGENTS.md) before changing code or installing the extension.

The extension will be developed and tested locally first. Installation into `~/.pi/agent/extensions/` is deliberately not part of this repository's default workflow.
