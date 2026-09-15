---
name: ossm-upstream-pr
description: Export a merged OSSM fork feature into an upstream pull request with a published branch for GitHub diff review and confirmation before PR creation, filtering fork-only changes and new tests. Use for upstream contributions from this repo's develop branch.
---

# OSSM upstream PR

This fork develops on `develop`. Feature branches merge there after review and verification. Export one selected feature into a fresh branch based on upstream, preserving the fork's development history and files.

## Determine the export scope

Identify the selected fork PR, its merge into `develop`, the fork push destination, and the upstream repository and target branch. Inspect repository metadata rather than assuming `origin` is upstream or that local `main` is current. Retrieve current upstream contribution instructions and the applicable PR template. Resolve missing identity or an ambiguous merge with the user before proposing an export.

For a normal merge commit `M`, inspect `git diff M^1 M`: the change introduced into `develop`, including merge resolutions. Do not export the whole upstream-to-develop diff or copy complete files from `develop`. For squash/rebase merges, establish the exact change range using the fork PR and merge metadata; ask if it cannot be established reliably.

Account for every changed file and mixed-purpose hunk. Check the selected changes against current upstream for already-landed work, conflicts, and dependencies on other fork changes. Propose any necessary prerequisite explicitly instead of silently pulling it in.

Apply these fork export rules alongside upstream's documented conventions. The rules are this fork's preferences, not evidence that upstream prohibits these contributions.

| Category | Export rule |
| --- | --- |
| Production implementation | Include feature-relevant implementation, wiring, and required build/dependency changes. |
| New tests | Exclude all newly added automated tests, including unit, integration, inline, and documentation tests. Exclude supporting fixtures, harnesses, dev-dependencies, and configuration used only by excluded tests. Inspect source files and manifests as well as test directories. Preserve upstream's existing tests; flag necessary changes to those tests individually in the proposal. |
| Documentation | Decide case by case. Default to allowing feature-relevant edits to existing upstream docs and excluding new documentation files, including under `docs/` or `doc/`. List each documentation decision explicitly; inclusion of a new doc requires explicit agreement. New executable doctests remain excluded even in otherwise eligible documentation. |
| Agent environment | Exclude agent instructions and configuration, including `AGENTS.md`, `CLAUDE.md`, `.agent-docs/`, `.agents/`, and `.codex/`, wherever applicable. |
| Fork planning | Exclude `CONTEXT.md`, `.scratch/`, fork research, specs, ADRs, and implementation notes. |
| Local setup | Exclude personal environment/editor configuration and ignore entries for fork-only artifacts. Changes to upstream's shared tooling are eligible only when needed for the selected feature; propose them individually. |
| Fork identity | Exclude fork branding, URLs, release destinations, and fork-only CI changes from the patch. The required fork PR link belongs in the PR body. |
| Incidental changes | Exclude unrelated refactors, fixes, formatting, upgrades, and generated-file churn. Keep lockfile changes required by retained dependencies; calculate them from the upstream-based result. |

Classify additions, modifications, deletions, and renames: path filtering alone is insufficient. Removing excluded content must leave coherent imports, manifests, documentation links, and build configuration. Existing upstream files are the baseline; exclusion means omitting the fork change, not deleting upstream content.

Present a concrete proposal containing:

- Fork PR link, source merge/range, upstream target and base commit, and proposed export branch name (prefer `upstream/<feature>`).
- Included and excluded files or change groups with reasons; identify partial-file selections and each documentation decision.
- Prerequisites, conflicts, unresolved decisions, and the checks planned for the exported result.
- Proposed PR title and body using upstream's actual template. Fill its sections for the exported scope and put a direct link to the fork PR in the testing section, explaining that new tests are retained there for review. Distinguish verified results from checks still planned.

Creating, committing, and pushing the export branch to the fork are authorized without a separate confirmation. Proceed with the selected feature and these export rules; resolve scope decisions that need user input before including those changes. Publish the prepared branch so the user can review its diff in GitHub before confirming PR creation.

## Prepare and publish the export branch

Create the fresh export branch from the identified upstream base, preferably in a separate worktree. Apply only the selected changes; keep `develop`, the feature branch, and uncommitted user work intact. Avoid bringing fork-only commits into the export ancestry.

If conflicts or dependencies require expanding beyond the selected feature, obtain agreement for that scope change before including it. Routine adaptations within the selected scope do not need approval.

Inspect the complete diff and commit range against the target upstream branch. Every change must map to the selected scope; excluded material must be absent from both the patch and exported commits. Run appropriate build/check commands for the retained implementation. New tests may be run from a temporary copy or the fork without committing them to the export, but report precisely which tree and revision were tested. Fork test results alone do not establish that the filtered export passes.

Commit the prepared changes and push the export branch to the fork without asking for confirmation. Present a GitHub compare link showing the upstream target against the published fork branch, along with the export branch, worktree path, upstream base and export commit IDs, a diff summary, validation results, and final PR title and body. Also provide the exact command to inspect the full PR diff locally, such as `git diff <upstream-base>...<export-commit>`. Ask the user to review the diff in GitHub and explicitly confirm PR creation. Wait for their response before opening a PR. If the patch changes after review, publish the updated branch and obtain confirmation for that revision before creating the PR.

## Create the PR after diff confirmation

Create the PR from the published, reviewed export branch against the identified upstream repository and branch. Use the upstream template and required direct fork PR link, replacing planned checks with actual outcomes and limitations. With `gh`, pass multiline text using `--body-file`. Do not label unrun checks as passing. Resolve failing relevant checks before creating the PR; if blocked, report the failure and get agreement before creating the PR with that limitation.

The prepared-diff confirmation authorizes PR creation for the reviewed revision. If a push or PR creation result is ambiguous, inspect remote state before retrying to avoid duplicate PRs. Report the resulting PR URL, export branch, and validation outcome. Do not merge either PR as part of this skill.
