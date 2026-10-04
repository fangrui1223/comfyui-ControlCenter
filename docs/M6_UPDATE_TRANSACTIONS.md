# M6 — Layered updates and recovery

## Transaction boundaries

FR Control Center treats each mutable layer as a separate transaction:

| Layer | Primary rollback unit | Required acceptance gates |
| --- | --- | --- |
| Core | pinned commit plus offline Git bundle | clean tree, Core quick test, Manager v4 startup, runtime smoke |
| Frontend | exact package set and lock snapshot | frontend load and Core API compatibility |
| Manager | Manager wheel set, config and state | Manager v4 API v2 and plugin catalog refresh |
| Runtime | whole staged runtime directory | hardware, numerical and Core quick tests |
| Plugin | plugin snapshot plus dependency lock | Python import, startup import and representative workflow |
| Model mapping | YAML and undo manifest | dry run, collisions, Core quick test and zero model writes |

One transaction changes one layer. Models are not included in environment update or restore snapshots.

## Channels

- Existing stable: observe only; the project never updates it.
- Next: verified stable targets only.
- Lab: stable, preview and experimental targets; it has independent Python, plugins, Manager state, user data and compiled caches.

A preview/nightly selection is therefore rejected for next even if its version number is newer. Runtime updates additionally require a fully staged candidate and a passed hardware probe before any live rename.

## Baseline restore point

`fr-create-update-restore-point.ps1` refuses a running environment or dirty Core tree. It captures the exact Core commit/tag, an offline Core Git bundle, Python package lock, runtime manifest, Manager config and model-mapping metadata. It records custom-node names but never copies or changes model files.

`fr-restore-update-point.ps1` is dry-run by default. Direct script execution deliberately fails closed; a real restore must be orchestrated by the app so it can stop the environment, create a pre-restore safety point, reconcile packages and run post-restore gates.

## Compiled plugin compatibility transaction

The compatibility update entry is a distinct single-plugin transaction, not a relaxation of the normal batch-update guard:

1. recompute the compatibility plan and reject a stale digest or changed exact target;
2. capture the full `pip freeze` state and baseline `pip check` output;
3. stop the instance through the shared action lifecycle, save a pre-update snapshot and create a local CNR directory backup when applicable;
4. ask Manager v4 to switch only the source to the planned target, with dependency and install hooks disabled;
5. verify the exact CNR version/Git commit, assert that the full Python package state and protected stack did not change, reject only newly introduced `pip check` issues, import-smoke the updated plugin, and confirm Manager v4 still resolves it;
6. save a post-update snapshot only after every gate succeeds.

Any Manager failure, target mismatch, unplanned package change, new environment conflict, import failure, Manager-state failure or post-snapshot failure restores the local Git/CNR source and reconciles Python packages from the pre-update snapshot. Pre-existing `pip check` warnings are recorded separately and do not by themselves block an otherwise safe source-only update.
