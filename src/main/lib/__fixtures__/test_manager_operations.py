"""Offline regression tests for the actual Manager v4 adapter.

Only temporary directories and v4-shaped test records are used. No Manager,
custom-node code, package installer, or real ComfyUI environment is imported.
"""

import importlib.util
import io
import os
import subprocess
import sys
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch
from contextlib import ExitStack, redirect_stdout, redirect_stderr


spec = importlib.util.spec_from_file_location(
    "manager_operations",
    os.environ.get("FR_MANAGER_ADAPTER_PATH") or Path(__file__).resolve().parents[4] / "lib" / "manager_operations.py",
)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class ManagerOperationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.comfy = Path(self.temp.name) / "ComfyUI"
        self.plugin = self.comfy / "custom_nodes" / "minimax-h3-audio-T8"
        self.plugin.mkdir(parents=True)
        self.user = self.comfy / "user"
        self.result = SimpleNamespace(
            result=True, target="nightly", action="update-git", msg=None,
            postinstall=Mock(return_value=True),
        )
        self.manager = SimpleNamespace(
            installed_node_packages={}, active_nodes={}, unknown_active_nodes={},
            unified_update=Mock(return_value=self.result),
        )
        self.fixer = SimpleNamespace(fix_broken=Mock())
        self.cli = SimpleNamespace(
            unified_manager=self.manager,
            manager_util=SimpleNamespace(
                PIPFixer=Mock(return_value=self.fixer),
                get_installed_packages=Mock(return_value={}),
            ),
            context=SimpleNamespace(manager_files_path="test-manager-state"),
            core=SimpleNamespace(git=SimpleNamespace(Repo=MagicMock())),
        )
        self.repo = self.cli.core.git.Repo.return_value.__enter__.return_value
        self.repo.head.is_detached = False
        self.repo.head.commit.hexsha = "2" * 40
        self.repo.active_branch.tracking_branch.return_value.commit.hexsha = "2" * 40
        self.repo.is_dirty.return_value = False
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)
        self.prepare = self.contexts.enter_context(patch.object(adapter, "_prepare_manager", return_value=self.cli))
        self.contexts.enter_context(redirect_stdout(io.StringIO()))
        self.contexts.enter_context(redirect_stderr(io.StringIO()))

    def record(self, node_id="minimax-h3-audio-t8", version="nightly", enabled=True):
        node = SimpleNamespace(
            id=node_id, version=version, fullpath=str(self.plugin), is_enabled=enabled,
        )
        self.manager.installed_node_packages[node_id] = node
        table = self.manager.unknown_active_nodes if version == "unknown" else self.manager.active_nodes
        table[node_id] = ("https://example.invalid/repository" if version == "unknown" else version, str(self.plugin))
        return node

    def update(self, **kwargs):
        return adapter.update_node_now(str(self.comfy), str(self.user), str(self.plugin), **kwargs)

    def inspect(self, **kwargs):
        return adapter.inspect_node(str(self.comfy), str(self.user), str(self.plugin), **kwargs)

    def assert_not_updated(self):
        self.manager.unified_update.assert_not_called()
        self.cli.manager_util.PIPFixer.assert_not_called()

    def test_registered_git_uses_manager_id_and_nightly(self):
        self.record()
        payload = self.update()
        self.manager.unified_update.assert_called_once_with(
            "minimax-h3-audio-t8", "nightly", instant_execution=True,
            no_deps=False, return_postinstall=True,
        )
        self.assertEqual(payload["node"], "minimax-h3-audio-t8")
        self.assertEqual(payload["pluginDir"], adapter._canonical(str(self.plugin)))
        self.result.postinstall.assert_called_once()
        self.fixer.fix_broken.assert_called_once()

    def test_unregistered_git_uses_repository_id_even_with_renamed_directory(self):
        self.record("different-repository-name", "unknown")
        self.update()
        self.assertEqual(self.manager.unified_update.call_args.args, ("different-repository-name", "unknown"))

    def test_cnr_uses_actual_installed_id_and_version(self):
        self.record("registry-id", "1.87.0")
        self.update()
        self.assertEqual(self.manager.unified_update.call_args.args, ("registry-id", "1.87.0"))

    def test_source_only_skips_all_dependency_and_install_hooks(self):
        self.record()
        self.update(source_only=True)
        self.assertTrue(self.manager.unified_update.call_args.kwargs["no_deps"])
        self.cli.manager_util.PIPFixer.assert_not_called()
        self.result.postinstall.assert_not_called()

    def test_wrong_exact_target_fails_before_install_hooks(self):
        self.record("registry-id", "1.87.0")
        self.result.target = "1.89.0"
        with self.assertRaisesRegex(RuntimeError, "expected 1.88.0"):
            self.update(source_only=True, expected_target="1.88.0")
        self.result.postinstall.assert_not_called()

    def test_dependency_failure_is_reported_and_fixer_runs(self):
        self.record()
        self.result.postinstall.return_value = False
        with self.assertRaisesRegex(RuntimeError, "dependency installation failed"):
            self.update()
        self.fixer.fix_broken.assert_called_once()

    def test_git_failure_reported_as_manager_success_skips_install_hooks(self):
        self.record()
        self.repo.head.commit.hexsha = "1" * 40
        with self.assertRaisesRegex(RuntimeError, "Git source update did not complete"):
            self.update()
        self.result.postinstall.assert_not_called()
        self.fixer.fix_broken.assert_not_called()

    def test_incomplete_worktree_at_target_revision_skips_install_hooks(self):
        self.record()
        self.repo.is_dirty.return_value = True
        with self.assertRaisesRegex(RuntimeError, "Git source update did not complete"):
            self.update()
        self.result.postinstall.assert_not_called()

    def test_changed_remote_cannot_replace_selected_exact_commit(self):
        self.record()
        with self.assertRaisesRegex(RuntimeError, "Git source update did not complete"):
            self.update(source_only=True, expected_commit="3" * 40)
        self.result.postinstall.assert_not_called()

    def test_git_detached_or_missing_upstream_is_rejected(self):
        self.record()
        self.repo.head.is_detached = True
        with self.assertRaisesRegex(RuntimeError, "detached"):
            self.update()
        self.repo.head.is_detached = False
        self.repo.active_branch.tracking_branch.return_value = None
        with self.assertRaisesRegex(RuntimeError, "without a Git upstream"):
            self.update()
        self.result.postinstall.assert_not_called()

    def test_cnr_update_does_not_open_a_git_repository(self):
        self.record("registry-id", "1.87.0")
        self.update()
        self.cli.core.git.Repo.assert_not_called()

    def test_windows_longpaths_preserves_inherited_config_and_restores_on_failure(self):
        self.record()
        inherited = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.longpaths", "GIT_CONFIG_VALUE_0": "false"}
        with patch.dict(os.environ, inherited, clear=True), patch.object(adapter.sys, "platform", "win32"):
            def fail(*args, **kwargs):
                self.assertEqual(os.environ["GIT_CONFIG_COUNT"], "2")
                self.assertEqual(os.environ["GIT_CONFIG_VALUE_0"], "false")
                self.assertEqual(os.environ["GIT_CONFIG_KEY_1"], "core.longpaths")
                self.assertEqual(os.environ["GIT_CONFIG_VALUE_1"], "true")
                raise RuntimeError("fixture Git failure")
            self.manager.unified_update.side_effect = fail
            with self.assertRaisesRegex(RuntimeError, "fixture Git failure"):
                self.update(source_only=True)
            self.assertEqual(dict(os.environ), inherited)

    def test_invalid_git_config_count_fails_before_manager_import(self):
        for value in ("invalid", "-1"):
            with patch.dict(os.environ, {"GIT_CONFIG_COUNT": value}), patch.object(adapter.sys, "platform", "win32"):
                with self.assertRaisesRegex(RuntimeError, "Invalid GIT_CONFIG_COUNT"):
                    self.update()
        self.prepare.assert_not_called()

    def test_real_git_child_checks_out_long_workflow_without_persisting_config(self):
        self.record()
        # Each filename remains under NTFS's component limit. The full path
        # exceeds MAX_PATH, as in the reported H3 workflow checkout failure.
        relative = "examples/workflows/60-ltx-rgb-stage-split/native-load-policy-exp/" + "S27_" + "workflow_" * 18 + ".json"
        workflow = self.plugin / relative
        self.assertGreater(len(str(workflow)), 260)
        def git(*args):
            return subprocess.run(
                ["git", "-c", "core.longpaths=true", "-c", "user.name=FR Test", "-c", "user.email=test@example.invalid", *args],
                cwd=self.plugin, check=True, capture_output=True, text=True, timeout=20,
            ).stdout.strip()
        git("init", "-b", "main")
        (self.plugin / "README.md").write_text("baseline\n", encoding="utf-8")
        git("add", ".")
        git("commit", "-m", "baseline")
        original = git("rev-parse", "HEAD")
        workflow.parent.mkdir(parents=True)
        workflow.write_text('{"fixture": "long workflow"}\n', encoding="utf-8")
        git("add", ".")
        git("commit", "-m", "workflow update")
        target = git("rev-parse", "HEAD")
        git("reset", "--hard", original)
        git("config", "core.longpaths", "false")
        config_before = (self.plugin / ".git" / "config").read_bytes()
        helper = "import subprocess,sys; sys.exit(subprocess.call(['git','reset','--hard',sys.argv[1]]))"
        def update(*args, **kwargs):
            subprocess.run([sys.executable, "-s", "-c", helper, target], cwd=self.plugin,
                           check=True, capture_output=True, timeout=20)
            self.repo.head.commit.hexsha = git("rev-parse", "HEAD")
            self.repo.active_branch.tracking_branch.return_value.commit.hexsha = target
            return self.result
        self.manager.unified_update.side_effect = update
        self.result.postinstall.side_effect = lambda: workflow.read_text(encoding="utf-8").startswith('{"fixture"')
        self.update(expected_commit=target)
        self.assertTrue(workflow.is_file())
        self.result.postinstall.assert_called_once()
        self.assertEqual((self.plugin / ".git" / "config").read_bytes(), config_before)

    def test_manager_failure_is_reported(self):
        self.record()
        self.result.result = False
        self.result.msg = "fixture update failure"
        with self.assertRaisesRegex(RuntimeError, "fixture update failure"):
            self.update()
        self.result.postinstall.assert_not_called()

    def test_inspect_checks_the_real_nightly_record(self):
        self.record()
        self.assertEqual(self.inspect()["version"], "nightly")
        self.assert_not_updated()

    def test_inspect_checks_exact_cnr_version(self):
        self.record("registry-id", "1.88.0")
        self.assertEqual(self.inspect(expected_version="1.88.0")["node"], "registry-id")
        with self.assertRaisesRegex(RuntimeError, "expected 1.89.0"):
            self.inspect(expected_version="1.89.0")
        self.assert_not_updated()

    def test_missing_record_fails_update_and_inspection(self):
        for operation in (self.update, self.inspect):
            with self.subTest(operation=operation.__name__):
                with self.assertRaisesRegex(RuntimeError, "uniquely identify"):
                    operation()
        self.assert_not_updated()

    def test_disabled_record_is_rejected(self):
        self.record(enabled=False)
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            self.update()
        self.assert_not_updated()

    def test_ambiguous_path_is_rejected(self):
        self.record()
        self.record("other-id")
        with self.assertRaisesRegex(RuntimeError, "uniquely identify"):
            self.update()
        self.assert_not_updated()

    def test_missing_active_update_record_is_rejected(self):
        self.record()
        self.manager.active_nodes.clear()
        with self.assertRaisesRegex(RuntimeError, "matching active update record"):
            self.update()
        self.assert_not_updated()

    def test_active_record_for_another_path_is_rejected(self):
        self.record()
        self.manager.active_nodes["minimax-h3-audio-t8"] = ("nightly", str(self.comfy / "other-plugin"))
        with self.assertRaisesRegex(RuntimeError, "matching active update record"):
            self.update()
        self.assert_not_updated()

    def test_inconsistent_active_version_is_rejected(self):
        self.record("registry-id", "1.87.0")
        self.manager.active_nodes["registry-id"] = ("1.88.0", str(self.plugin))
        with self.assertRaisesRegex(RuntimeError, "inconsistent version"):
            self.update()
        self.assert_not_updated()

    def test_outside_missing_nested_and_disabled_paths_fail_before_manager_import(self):
        nested = self.plugin / "nested"
        nested.mkdir()
        disabled = self.comfy / "custom_nodes" / ".disabled" / "node"
        disabled.mkdir(parents=True)
        paths = [self.comfy, nested, disabled, self.plugin / "missing", str(self.plugin) + "\n"]
        for plugin_path in paths:
            with self.subTest(plugin_path=plugin_path):
                with self.assertRaises(RuntimeError):
                    adapter.update_node_now(str(self.comfy), str(self.user), str(plugin_path))
        self.prepare.assert_not_called()
        self.assert_not_updated()

    def test_windows_case_and_separators_match_real_path(self):
        self.record()
        path = str(self.plugin / ".." / self.plugin.name)
        if os.name == "nt":
            path = path.upper().replace("\\", "/")
        payload = adapter.inspect_node(str(self.comfy), str(self.user), path)
        self.assertEqual(payload["node"], "minimax-h3-audio-t8")

    def test_cli_update_and_inspection_use_plugin_directory(self):
        self.record()
        args = ["--comfyui-dir", str(self.comfy), "--user-dir", str(self.user), "--plugin-dir", str(self.plugin)]
        self.assertEqual(adapter.main(["update-node-now", *args, "--source-only"]), 0)
        self.assertEqual(adapter.main(["inspect-node", *args]), 0)
        self.manager.installed_node_packages.clear()
        self.assertEqual(adapter.main(["inspect-node", *args]), 1)


if __name__ == "__main__":
    unittest.main()
