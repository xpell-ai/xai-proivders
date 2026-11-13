# Changelog

## [2.0.8] — 2026-11-13 (unreleased candidate)

- Declare Node.js typings explicitly so the package builds in an isolated workspace without ancestor-provided @types/node.
- Compared with public 2.0.7 declarations: add bounded text/Gemini continuation helpers, safe Gemini failure diagnostics, Aime recovery/document extraction and trusted file-reference resolution.
- Coordinate the existing Azure, OpenAI, Aime, Gemini and mock provider exports with XNode 2.0.8.
- Retain signed Gemini continuation/context propagation, tool normalization and cached-content diagnostics covered by mock tests.
- Declare MIT consistently with the existing LICENSE file.

Compatibility: internal workspace specifications are retained. No public API redesign, PostgreSQL backend, persistence migration or automatic SQLite activation is introduced by this preparation.

Validation: package builds and available tests are recorded in the coordinated Gate 2 report. Gate 3 must verify the exact packed artifacts and clean-consumer compatibility before publication. These entries describe verified checked-out capabilities and release-preparation deltas; they do not claim that every capability is new relative to the last npm artifact.

