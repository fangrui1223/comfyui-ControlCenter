import importlib.util
import json
import os
import hashlib
from pathlib import Path
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[4] / 'lib' / 'plugin_dependency_plan.py'
spec = importlib.util.spec_from_file_location('dependency_plan', SCRIPT)
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


def wheel(root, name, version, requirements=(), tag='py3-none-any'):
    filename = f'{name}-{version}-{tag}.whl'
    info = f'{name}-{version}.dist-info'
    with zipfile.ZipFile(root / filename, 'w') as archive:
        archive.writestr(f'{name}/__init__.py', '')
        archive.writestr(f'{info}/METADATA', f'Metadata-Version: 2.3\nName: {name}\nVersion: {version}\n' + ''.join(f'Requires-Dist: {r}\n' for r in requirements))
        archive.writestr(f'{info}/WHEEL', f'Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: {tag}\n')
        archive.writestr(f'{info}/RECORD', '')
    return root / filename


class DependencyAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def analyze(self, requirements, versions=None, metadata=None):
        (self.root / 'requirements.txt').write_text(requirements, encoding='utf-8')
        return plan.analyze({'currentRoot': str(self.root), 'targetRoot': str(self.root),
                             'installedPackages': versions or {}, 'installedRequirements': metadata or {},
                             'markerEnvironment': {'python_full_version': '3.13.12', 'python_version': '3.13', 'sys_platform': 'win32'}})

    def test_inactive_platform_and_python_markers_are_not_missing(self):
        result = self.analyze('absent; sys_platform == "linux"\nother; python_version < "3.12"')
        self.assertTrue(all(r['satisfied'] and not r['active'] for r in result['target']))

    def test_inactive_direct_url_does_not_request_installation(self):
        result = self.analyze('pkg @ https://example.org/pkg.whl ; sys_platform == "linux"')
        self.assertEqual([], result['issues'])

    def test_extras_check_installed_dependency_metadata(self):
        result = self.analyze('base[feature]==1', {'base': '1'}, {'base': ['extra_pkg>=2; extra == "feature"', 'not_selected; extra == "other"']})
        self.assertEqual(['base', 'extra-pkg'], [r['normalizedName'] for r in result['target']])
        self.assertFalse(result['target'][1]['satisfied'])

    def test_pep440_local_pre_and_wildcard_versions(self):
        self.assertTrue(plan.satisfies('2.12.1+cu130', '==2.12.1'))
        self.assertTrue(plan.satisfies('1.22.4', '~=1.22.0'))
        self.assertFalse(plan.satisfies('1.23.0', '~=1.22.0'))
        self.assertTrue(plan.satisfies('2.8.1', '==2.8.*'))
        self.assertTrue(plan.satisfies('2.0rc1', '>=1'))
        self.assertTrue(plan.satisfies('2.0rc1', '>=2.0rc1'))

    def test_nested_requirement_include_is_read_only(self):
        (self.root / 'nested.txt').write_text('package>=1', encoding='utf-8')
        result = self.analyze('-r nested.txt', {'package': '1'})
        self.assertTrue(result['target'][0]['satisfied'])
        self.assertEqual('nested.txt', result['target'][0]['sourceFile'])

    def test_include_cannot_escape_plugin(self):
        result = self.analyze('-r ../outside.txt')
        self.assertIn('escaped', result['issues'][0])

    def test_pip_options_dynamic_and_urls_require_review(self):
        result = self.analyze('--extra-index-url https://example.org\npkg @ https://example.org/pkg.whl')
        self.assertEqual(2, len(result['issues']))
        (self.root / 'pyproject.toml').write_text('[project]\ndynamic=["dependencies"]', encoding='utf-8')
        self.assertIn('Dynamic', self.analyze('')['issues'][0])

    def test_existing_conflict_is_not_attributed_to_target(self):
        metadata = {'old': ['missing==1']}
        self.assertEqual({'old: missing==1'}, plan.requirement_issues({'old': '1'}, metadata, plan.default_environment()))


class WheelResolutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.uv = os.environ['FR_TEST_UV']

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.wheels = self.root / 'wheelhouse'
        self.wheels.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def resolve(self, requirements, versions=None, metadata=None, protected=()):
        return plan.resolve_wheels({'requirements': requirements, 'installedPackages': versions or {}, 'installedRequirements': metadata or {},
                                    'protectedNames': list(protected)}, self.uv, self.root / 'resolve', self.wheels)

    def test_exact_direct_and_transitive_plan_preserves_installed_cuda(self):
        wheel(self.wheels, 'rootpkg', '2', ['childpkg>=2', 'torch>=2'])
        wheel(self.wheels, 'childpkg', '2')
        result = self.resolve(['rootpkg==2'], {'rootpkg': '1', 'childpkg': '1', 'torch': '2.12.1+cu130'}, protected=['torch'])
        self.assertEqual({'rootpkg': '2', 'childpkg': '2'}, {c['name']: c['to'] for c in result['changes']})
        self.assertEqual('2.12.1+cu130', result['expectedPackages']['torch'])
        self.assertTrue(all(len(c['wheel']['sha256']) == 64 for c in result['changes']))
        self.assertEqual('transitive', result['changes'][0]['reason'])

    def test_satisfied_existing_packages_produce_no_install_plan(self):
        result = self.resolve(['existing>=1'], {'existing': '2'})
        self.assertEqual([], result['changes'])

    def test_protected_change_is_blocked_without_fetching_cuda_wheel(self):
        wheel(self.wheels, 'rootpkg', '2', ['torch>=3'])
        with self.assertRaisesRegex(RuntimeError, 'protected stack'):
            self.resolve(['rootpkg==2'], {'torch': '2.12.1+cu130'}, protected=['torch'])

    def test_new_conflict_with_another_installed_plugin_is_blocked(self):
        wheel(self.wheels, 'childpkg', '2')
        with self.assertRaisesRegex(RuntimeError, 'Wheel-only|conflict with installed'):
            self.resolve(['childpkg==2'], {'childpkg': '1', 'other': '1'}, {'other': ['childpkg<2']})

    def test_preexisting_unrelated_conflict_does_not_block(self):
        wheel(self.wheels, 'rootpkg', '1')
        result = self.resolve(['rootpkg==1'], {'old': '1'}, {'old': ['missing==1']})
        self.assertEqual(['rootpkg'], [c['name'] for c in result['changes']])

    def test_backtracks_new_package_to_preserve_another_installed_plugin(self):
        wheel(self.wheels, 'rootpkg', '2', ['childpkg==2'])
        wheel(self.wheels, 'rootpkg', '1', ['childpkg==1'])
        wheel(self.wheels, 'childpkg', '1')
        wheel(self.wheels, 'childpkg', '2')
        result = self.resolve(['rootpkg>=1'], {'childpkg': '1', 'other': '1'}, {'other': ['childpkg<2']})
        self.assertEqual([('rootpkg', '1')], [(c['name'], c['to']) for c in result['changes']])

    def test_extra_transitive_wheel_is_included(self):
        wheel(self.wheels, 'rootpkg', '1', ['childpkg==2; extra == "feature"'])
        wheel(self.wheels, 'childpkg', '2')
        result = self.resolve(['rootpkg[feature]==1'])
        self.assertEqual({'rootpkg', 'childpkg'}, {c['name'] for c in result['changes']})

    def test_missing_or_wrong_platform_wheel_blocks_source_build(self):
        wheel(self.wheels, 'rootpkg', '1', tag='cp310-cp310-linux_x86_64')
        with self.assertRaisesRegex(RuntimeError, 'Wheel-only'):
            self.resolve(['rootpkg==1'])

    def test_untrusted_url_and_incorrect_hash_are_rejected(self):
        self.assertFalse(plan.trusted_wheel_url('https://example.org/package.whl'))
        w = wheel(self.wheels, 'rootpkg', '1')
        with self.assertRaisesRegex(RuntimeError, 'hash'):
            plan.wheel_metadata({'name': 'rootpkg', 'version': '1', 'filename': w.name, 'url': w.as_uri(), 'sha256': '0'*64}, self.root / 'download', self.wheels)

    def test_locked_wheels_install_offline_into_a_disposable_environment(self):
        import subprocess
        import sys
        environment = self.root / 'environment'
        kwargs = dict(capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
        result = subprocess.run([self.uv, '--no-config', 'venv', str(environment), '--python', sys.executable, '--no-python-downloads', '--cache-dir', str(self.root / 'venv-cache')], **kwargs)
        self.assertEqual(0, result.returncode, result.stderr)
        python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        package = wheel(self.wheels, 'rootpkg', '2')
        digest = hashlib.sha256(package.read_bytes()).hexdigest()
        requirements = self.root / 'approved.txt'
        requirements.write_text(f'rootpkg @ {package.as_uri()} --hash=sha256:{digest}\n', encoding='utf-8')
        result = subprocess.run([self.uv, '--no-config', 'pip', 'install', '--python', str(python), '--offline', '--no-index', '--no-deps', '--no-build', '--no-python-downloads', '--link-mode', 'copy', '--require-hashes', '-r', str(requirements), '--cache-dir', str(self.root / 'install-cache')], **kwargs)
        self.assertEqual(0, result.returncode, result.stderr)
        result = subprocess.run([str(python), '-I', '-c', 'from importlib.metadata import version; print(version("rootpkg"))'], **kwargs)
        self.assertEqual('2', result.stdout.strip())


if __name__ == '__main__':
    unittest.main()
