# <directory name> Index

> One INDEX.md per directory, recording **direct children only**. The root INDEX.md additionally maintains the priority levels, the id cursor and the statistics.

## Subdirectories

| Subdirectory | Description |
|--------------|-------------|
| <feature directory>/ | one sentence describing what this feature category covers |

## Cases

| Case ID | Name | Test point (one sentence) | Status | Related bug_report |
|---------|------|---------------------------|--------|--------------------|
| FS0001 | Reject overlong request parameters | Overlong parameters must be rejected without crashing | Failed | <report path under the bug report directory> |

<!-- The following three sections are only needed in the root INDEX.md; delete them in subdirectories -->

## Priority levels (root only)

> Cases are generated in priority order from high to low: move to the next level only after all high-priority feature areas are covered (core first, details later).
> **`live.json` machine value — never translate:** the `status` field of every `priorities.levels[].domains[]` entry in live.json must be exactly the canonical Chinese `未覆盖` / `已覆盖`. This column is a machine contract (produced and compared by the platform); English `Not covered` / `Covered` there is only tolerated by a read-side fallback, so always write the canonical Chinese value.
> The "Coverage status" column of the INDEX.md table below is human-readable only (the platform does not parse it), so it may use `Not covered / Covered`; update that column and the `priorities` field of live.json at the end of every round.

| Priority | Feature area | Core scenario | Coverage status |
|----------|--------------|---------------|-----------------|
| P0 | <core feature area> | <one-sentence main flow> | Not covered |
| P1 | <important feature area> | <one-sentence scenario> | Not covered |
| P2 | <detail scenario> | <one-sentence scenario> | Not covered |

## id cursor (root only)

Next available id: FS0001

## Overall statistics (root only)

| Metric | Count |
|--------|-------|
| Total cases | 0 |
| Passed / Failed / Not run / Skipped | 0 / 0 / 0 / 0 |
| Cumulative rounds | 0 |
