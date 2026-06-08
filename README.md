# Ainoflow Sandbox Terminal

Terminal-first VS Code extension for running AI coding agents (Claude Code, Codex,
Gemini CLI, and others) inside isolated, persistent sandboxes.

The experience is meant to feel identical to a native VS Code terminal while
providing isolation, persistence, and security through sandbox execution — with no
need to understand Docker, containers, VMs, or sandbox lifecycle management.

## Status

Early project setup. Requirements are captured first; implementation follows.

## Documentation

- [Functional Requirements Document (FRD)](docs/FRD.md) — initial requirements specification.

## Goals (summary)

- A terminal experience indistinguishable from native VS Code terminals
- Execute agents inside isolated sandboxes
- Preserve agent authentication and session state
- Resume previous agent sessions
- Support multiple agents per project

See the [FRD](docs/FRD.md) for the full specification.
