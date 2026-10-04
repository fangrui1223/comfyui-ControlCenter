# Protect shared model directory links during Core updates

FR Control Center 1.0.48 protects an existing `ComfyUI/models` directory link
(Windows Junction or directory symlink) when updating or restoring Core. A normal
physical models directory keeps its existing behavior. The implementation is in
`src/main/lib/modelLinkGuard.ts`; no installation or model-library path is hard-coded.

## Transaction

Before Git starts, the launcher records the link identity and resolved target in
`ComfyUI/.git/fr-model-link-guard/active.json`, then renames the **link itself** into
that transaction's directory and creates a physical models directory for Git.
The shared model library is never copied, overwritten, moved, or recursively deleted.

After the Git child closes, on success, failure or cancellation, the generated
physical directory is retained as `<transaction>/checkout-models`. The original
link is moved back and its target is verified before clearing the journal. The
updater preserves tracked model entries in its backup index instead of recording
the temporary absence as user deletions. Safe pygit2 snapshot checkout first
materializes only tracked files in the temporary physical models directory;
conflict checks for all other source files stay in effect.

Recovery data remains under `.git/fr-model-link-guard/<transaction-id>/`. It is
small (Core's configs/placeholders, not model weights) and intentionally retained.
No links or files are created inside the shared model library.

## Covered entry points

- Core latest/stable, explicit tag and explicit commit updates.
- Core snapshot version checkout and fetch/checkout, for pygit2 and system Git.
- Source rollback following dependency failure or cancellation.
- Interrupted-operation recovery before launching a standalone installation,
  even when HEAD did not change or the ordinary source-operation marker is absent.

The recovery journal is committed before the first rename. Malformed journals,
unavailable targets, linked metadata directories and conflicting replacement
entries fail closed, retaining the recovery data. A concurrent operation is
rejected. Recorded updater children must exit before recovery, preventing an
orphaned Git process from writing through a prematurely restored model link.

This is protection for operations performed by this Control Center. An unrelated
external Git command or another updater does not run the guard. It does not infer
or create a missing mapping: model mappings still require an explicit plan.
Git worktrees whose `.git` is a file are rejected when they have a whole-model
directory link, instead of silently updating without protection.

## Validation

Unit tests cover normal directories, repeated transactions, errors, concurrent
operations, malformed metadata, conflicting entries, live child processes and
recovery at every directory-rename boundary. Integration tests create disposable
Windows Junctions and local Git repositories, run the actual pygit2 Core updater,
exercise native Git and pygit2 restore entry points, and forcibly terminate a
fixture updater before recovering through the launch hook. Shared sentinel weights
and model configs must remain byte-for-byte unchanged. Tests never update an actual
ComfyUI installation or run inference.

Use the project's existing Node tools to run the focused suites. The real pygit2
integration tests use `FR_TEST_PYTHON` when supplied, otherwise the bundled Windows
bootstrap Python. They require access to their temporary fixture repositories.
