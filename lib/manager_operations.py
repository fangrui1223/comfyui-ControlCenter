"""Small transactional adapter for ComfyUI-Manager v4 operations.

The public ``cm_cli update`` command deliberately schedules some Windows
operations for the next ComfyUI start.  The Control Center needs the source
and dependency changes to finish inside its snapshot/verify/rollback
transaction, so this adapter calls the same Manager v4 engine with
``instant_execution=True``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from contextlib import contextmanager


@contextmanager
def _git_long_paths():
    """Pass Windows long-path support to GitPython and Manager's child helpers.

    Append to Git's command-scoped configuration so existing proxy/config
    entries survive. No repository, global config or registry is changed.
    """
    if sys.platform != "win32":
        yield
        return
    raw_count = os.environ.get("GIT_CONFIG_COUNT", "")
    try:
        count = int(raw_count or "0")
    except ValueError as error:
        raise RuntimeError("Invalid GIT_CONFIG_COUNT for the plugin update process.") from error
    if count < 0:
        raise RuntimeError("Invalid GIT_CONFIG_COUNT for the plugin update process.")
    values = {
        "GIT_CONFIG_COUNT": str(count + 1),
        f"GIT_CONFIG_KEY_{count}": "core.longpaths",
        f"GIT_CONFIG_VALUE_{count}": "true",
    }
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _verify_git_source(manager_cli, plugin_dir: str, expected_commit: str | None):
    # v4's Windows repo_update does not propagate its git-helper exit code.
    # Verify before postinstall so a failed checkout cannot install dependencies.
    with manager_cli.core.git.Repo(plugin_dir) as repo:
        if repo.head.is_detached:
            raise RuntimeError("Manager v4 left the plugin on a detached Git revision.")
        tracking = repo.active_branch.tracking_branch()
        if tracking is None:
            raise RuntimeError("Manager v4 left the plugin without a Git upstream.")
        target = expected_commit or tracking.commit.hexsha
        if repo.head.commit.hexsha != target or repo.is_dirty(untracked_files=False):
            raise RuntimeError("Manager v4 Git source update did not complete; dependency installation was skipped.")


def _inside(parent: str, child: str) -> bool:
    parent_real = os.path.normcase(os.path.realpath(parent))
    child_real = os.path.normcase(os.path.realpath(child))
    try:
        return os.path.commonpath((parent_real, child_real)) == parent_real
    except ValueError:
        return False


def _canonical(path: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def _validate_plugin_dir(comfyui_dir: str, plugin_dir: str) -> str:
    if not plugin_dir or any(char in plugin_dir for char in ("\x00", "\r", "\n")):
        raise RuntimeError("Invalid plugin directory.")
    custom_nodes = _canonical(os.path.join(comfyui_dir, "custom_nodes"))
    plugin_path = _canonical(plugin_dir)
    if (
        not _inside(comfyui_dir, custom_nodes)
        or os.path.dirname(plugin_path) != custom_nodes
        or not os.path.isdir(plugin_path)
    ):
        raise RuntimeError("The plugin must be an installed directory inside this instance's custom_nodes.")
    return plugin_path


def _resolve_installed_node(manager_cli, plugin_dir: str):
    """Resolve the execution identity from v4's installed records, never a folder name.

    Explicit ``id@version`` specs only parse a string in Manager; they do not
    prove that the corresponding active record exists. Check the actual update
    table as well so unified_update cannot target another installation path.
    """
    manager = manager_cli.unified_manager
    matches = [
        node for node in manager.installed_node_packages.values()
        if _canonical(node.fullpath) == plugin_dir
    ]
    if len(matches) != 1:
        raise RuntimeError(f"Manager v4 could not uniquely identify the installed plugin: {plugin_dir}")
    node = matches[0]
    if not node.is_enabled:
        raise RuntimeError(f"Manager v4 reports that the plugin is disabled: {plugin_dir}")
    if not node.id or not node.version:
        raise RuntimeError(f"Manager v4 returned an invalid plugin identity: {plugin_dir}")
    if node.version == "unknown":
        entry = manager.unknown_active_nodes.get(node.id)
    else:
        entry = manager.active_nodes.get(node.id)
        if entry is not None and str(entry[0]) != node.version:
            raise RuntimeError(f"Manager v4 has inconsistent version records for: {plugin_dir}")
    if entry is None or _canonical(entry[1]) != plugin_dir:
        raise RuntimeError(f"Manager v4 has no matching active update record for: {plugin_dir}")
    return node


def _prepare_manager(comfyui_dir: str, user_dir: str):
    comfyui_dir = os.path.abspath(comfyui_dir)
    user_dir = os.path.abspath(user_dir)

    if not os.path.isfile(os.path.join(comfyui_dir, "folder_paths.py")):
        raise RuntimeError(f"Invalid ComfyUI directory: {comfyui_dir}")
    if not _inside(comfyui_dir, user_dir):
        raise RuntimeError("The Manager user directory must be inside the ComfyUI directory.")
    # cm_cli resolves the v4 package and performs the same preparation used by
    # its commands.  COMFYUI_PATH must exist before importing it.
    os.environ["COMFYUI_PATH"] = comfyui_dir
    if comfyui_dir not in sys.path:
        sys.path.append(comfyui_dir)

    import cm_cli.__main__ as manager_cli

    manager_cli.cmd_ctx.set_user_directory(user_dir)
    manager_cli.cmd_ctx.set_channel_mode(None, "cache")
    return manager_cli


@_git_long_paths()
def update_node_now(
    comfyui_dir: str,
    user_dir: str,
    plugin_dir: str,
    source_only: bool = False,
    expected_target: str | None = None,
    expected_commit: str | None = None,
) -> dict[str, object]:
    plugin_dir = _validate_plugin_dir(comfyui_dir, plugin_dir)
    manager_cli = _prepare_manager(comfyui_dir, user_dir)
    node = _resolve_installed_node(manager_cli, plugin_dir)
    node_name, version_spec = node.id, node.version
    print(f"[FR Manager v4] {plugin_dir} -> {node_name}@{version_spec}")
    pip_fixer = None
    if not source_only:
        pip_fixer = manager_cli.manager_util.PIPFixer(
            manager_cli.manager_util.get_installed_packages(),
            comfyui_dir,
            manager_cli.context.manager_files_path,
        )

    install_started = False
    try:
        result = manager_cli.unified_manager.unified_update(
            node_name,
            version_spec,
            instant_execution=True,
            no_deps=source_only,
            return_postinstall=True,
        )
        if not result.result:
            raise RuntimeError(result.msg or f"Manager v4 failed to update {node_name}.")
        if expected_target is not None and str(result.target) != expected_target:
            raise RuntimeError(
                f"Manager v4 resolved target {result.target!s}, expected {expected_target}."
            )
        if version_spec in ("nightly", "unknown"):
            _verify_git_source(manager_cli, plugin_dir, expected_commit)
        # The compatibility fast path deliberately commits only Manager's
        # source switch. Even with no_deps=True Manager's postinstall callback
        # can still execute install.py, so it must not run here.
        if not source_only and result.postinstall is not None:
            install_started = True
            if not result.postinstall():
                raise RuntimeError(f"Manager v4 dependency installation failed for {node_name}.")
    finally:
        if pip_fixer is not None and install_started:
            pip_fixer.fix_broken()

    payload = {
        "ok": True,
        "node": node_name,
        "pluginDir": plugin_dir,
        "version": version_spec,
        "action": result.action,
        "target": result.target,
        "message": result.msg,
        "sourceOnly": source_only,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return payload


def inspect_node(
    comfyui_dir: str,
    user_dir: str,
    plugin_dir: str,
    expected_version: str | None = None,
) -> dict[str, object]:
    plugin_dir = _validate_plugin_dir(comfyui_dir, plugin_dir)
    manager_cli = _prepare_manager(comfyui_dir, user_dir)
    node = _resolve_installed_node(manager_cli, plugin_dir)
    if expected_version is not None and node.version != expected_version:
        raise RuntimeError(f"Manager v4 reports version {node.version}, expected {expected_version}.")
    payload = {
        "ok": True,
        "node": node.id,
        "version": node.version,
        "pluginDir": plugin_dir,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return payload


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="FR Control Center Manager v4 adapter")
    subparsers = parser.add_subparsers(dest="command", required=True)
    update_parser = subparsers.add_parser(
        "update-node-now", help="Update one installed node immediately through Manager v4"
    )
    update_parser.add_argument("--comfyui-dir", required=True)
    update_parser.add_argument("--user-dir", required=True)
    update_parser.add_argument("--plugin-dir", required=True)
    update_parser.add_argument(
        "--source-only",
        action="store_true",
        help="Apply only Manager's source switch; skip dependency and install hooks",
    )
    update_parser.add_argument(
        "--expected-target",
        help="Fail after the source switch if Manager resolved a different exact target",
    )
    update_parser.add_argument("--expected-commit", help="Require the selected exact Git source revision before install hooks")
    inspect_parser = subparsers.add_parser(
        "inspect-node", help="Resolve one installed node through Manager v4 without mutation"
    )
    inspect_parser.add_argument("--comfyui-dir", required=True)
    inspect_parser.add_argument("--user-dir", required=True)
    inspect_parser.add_argument("--plugin-dir", required=True)
    inspect_parser.add_argument("--expected-version", help="Require the actual installed CNR version")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "update-node-now":
            update_node_now(
                args.comfyui_dir,
                args.user_dir,
                args.plugin_dir,
                source_only=args.source_only,
                expected_target=args.expected_target,
                expected_commit=args.expected_commit,
            )
            return 0
        if args.command == "inspect-node":
            inspect_node(args.comfyui_dir, args.user_dir, args.plugin_dir, args.expected_version)
            return 0
        raise RuntimeError(f"Unsupported command: {args.command}")
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
