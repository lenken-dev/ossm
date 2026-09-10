# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repository uses a single-context layout focused on the Rust implementation.

## Before exploring, read these

- **`CONTEXT.md`** at the repository root
- **`.agent-docs/adr/`** for ADRs that touch the area being changed

The domain context primarily covers the Rust workspace, including its crates, drivers, firmware, bindings, and board support. Other applications and documentation should be explored when they interact with that Rust implementation.

When an ADR affects current work, mention the decision and follow it. If the work requires a conflicting choice, call out the conflict explicitly before changing the design.
