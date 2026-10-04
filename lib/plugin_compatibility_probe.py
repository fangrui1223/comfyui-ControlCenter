"""Restricted post-update validation helpers for plugin compatibility transactions."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import traceback


def _inside(parent: str, child: str) -> bool:
    parent_real = os.path.normcase(os.path.realpath(parent))
    child_real = os.path.normcase(os.path.realpath(child))
    try:
        return os.path.commonpath((parent_real, child_real)) == parent_real
    except ValueError:
        return False


def import_smoke(comfyui_dir: str, plugin_dir: str) -> dict[str, object]:
    comfyui_dir = os.path.abspath(comfyui_dir)
    plugin_dir = os.path.abspath(plugin_dir)
    custom_nodes_dir = os.path.join(comfyui_dir, "custom_nodes")
    if not os.path.isfile(os.path.join(comfyui_dir, "folder_paths.py")):
        raise RuntimeError("Invalid ComfyUI directory.")
    if not _inside(custom_nodes_dir, plugin_dir):
        raise RuntimeError("Plugin directory must be inside ComfyUI/custom_nodes.")
    if not os.path.isfile(os.path.join(plugin_dir, "__init__.py")):
        raise RuntimeError("Plugin __init__.py was not found.")

    # Custom nodes are not ordinary isolated Python packages. Many of them
    # register HTTP routes against PromptServer.instance while importing, and
    # ComfyUI creates that instance before it loads custom nodes. Reproduce
    # that real startup order without starting a web listener or loading any
    # other custom node. A raw importlib exec here creates false failures for
    # valid nodes such as ComfyUI-Easy-Use.
    previous_cwd = os.getcwd()
    previous_argv = sys.argv[:]
    loop: asyncio.AbstractEventLoop | None = None
    prompt_server = None
    sys.path.insert(0, comfyui_dir)
    sys.path.insert(0, custom_nodes_dir)
    try:
        os.chdir(comfyui_dir)
        # Keep the validation offline and prevent ComfyUI from discovering all
        # installed nodes. These flags are consumed while importing core.
        sys.argv = [
            previous_argv[0],
            "--disable-all-custom-nodes",
            "--disable-api-nodes",
        ]
        from app.assets.manager import default_asset_manager
        import nodes
        from server import PromptServer

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        prompt_server = PromptServer(loop, default_asset_manager())
        existing_nodes = set(nodes.NODE_CLASS_MAPPINGS)
        loaded = loop.run_until_complete(
            nodes.load_custom_node(
                plugin_dir,
                existing_nodes,
                module_parent="custom_nodes",
            )
        )
        if not loaded:
            raise RuntimeError("ComfyUI's native custom-node loader rejected the plugin.")
        added_nodes = sorted(set(nodes.NODE_CLASS_MAPPINGS).difference(existing_nodes))
        payload = {
            "ok": True,
            "module": os.path.basename(plugin_dir),
            "loader": "comfyui-native",
            "nodeClassCount": len(added_nodes),
            "hasNodeMappings": len(added_nodes) > 0,
        }
        print(json.dumps(payload, ensure_ascii=False))
        return payload
    finally:
        if loop is not None:
            client_session = getattr(prompt_server, "client_session", None)
            if client_session is not None and not client_session.closed:
                loop.run_until_complete(client_session.close())
            loop.run_until_complete(asyncio.sleep(0))
            loop.close()
        asyncio.set_event_loop(None)
        sys.argv = previous_argv
        os.chdir(previous_cwd)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="FR plugin compatibility validation")
    subparsers = parser.add_subparsers(dest="command", required=True)
    smoke = subparsers.add_parser("import-smoke")
    smoke.add_argument("--comfyui-dir", required=True)
    smoke.add_argument("--plugin-dir", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "import-smoke":
            import_smoke(args.comfyui_dir, args.plugin_dir)
            return 0
        raise RuntimeError(f"Unsupported command: {args.command}")
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
