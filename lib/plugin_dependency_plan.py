"""Read-only PEP 508 analysis and wheel-only resolution for plugin updates.

Never import a plugin, build a distribution, or install packages. The resolver
excludes retained installed packages, then checks downloaded wheel metadata
against them; this also supports installed CUDA wheels absent from PyPI.
"""
from __future__ import annotations

import argparse
from email.parser import BytesParser
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import traceback
import uuid
from urllib.parse import unquote, urlparse
from urllib.request import urlopen
import zipfile

try:
    import tomllib
except ImportError:
    import tomli as tomllib
from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.tags import sys_tags
from packaging.utils import canonicalize_name, parse_wheel_filename

REQUIREMENT_FILES = re.compile(r"^(requirements(?:[-_.].+)?\.txt|repair_dependency_list\.txt)$", re.I)
NATIVE_SUFFIXES = {".pyd", ".dll", ".so", ".dylib"}


class ResolutionFailure(RuntimeError):
    def __init__(self, conflicts, details):
        super().__init__('Wheel-only dependency resolution failed: no compatible plan preserving installed packages.')
        self.code = 'dependency-conflict' if conflicts else 'wheel-resolution-failed'
        self.conflicts = conflicts
        self.details = details


def installed_state():
    versions, requirements, native = {}, {}, set()
    for dist in metadata.distributions():
        name = canonicalize_name(dist.metadata.get("Name", ""))
        if not name:
            continue
        if name in versions and versions[name] != dist.version:
            raise RuntimeError(f"Multiple installed versions of {name} require environment repair.")
        versions[name] = dist.version
        requirements[name] = dist.requires or []
        wheel = dist.read_text("WHEEL") or ""
        if "Root-Is-Purelib: false" in wheel or any(Path(str(p)).suffix.lower() in NATIVE_SUFFIXES for p in dist.files or []):
            native.add(name)
    return versions, requirements, native


def active_requirement(req, environment, extras=()):
    return req.marker is None or any(req.marker.evaluate(dict(environment, extra=extra)) for extra in ("", *extras))


def satisfies(version, constraint):
    # Installed prereleases already exist in the environment and may satisfy a
    # specifier; candidate selection remains the resolver's responsibility.
    return version is not None and SpecifierSet(constraint or "").contains(version, prereleases=True)


def read_declarations(root, versions, environment, native, installed_requirements):
    root = Path(root).resolve()
    records, issues, seen_files = [], [], set()

    def add(raw, source):
        try:
            req = Requirement(raw)
            name = canonicalize_name(req.name)
            active = active_requirement(req, environment)
            if req.url and active:
                issues.append(f"Direct URL/VCS dependency needs separate review: {raw}")
            version = environment["python_full_version"] if name == "python" else versions.get(name)
            records.append({"name": req.name, "normalizedName": name, "constraint": str(req.specifier) or None,
                            "marker": str(req.marker) if req.marker else None, "extras": sorted(req.extras),
                            "active": active, "sourceFile": source, "raw": str(req), "compiled": name in native,
                            "installedVersion": version, "satisfied": (satisfies(version, str(req.specifier)) if not req.url else None) if active else True})
        except Exception as error:
            issues.append(f"Cannot parse dependency in {source}: {raw} ({error})")

    def read_file(file):
        resolved = file.resolve()
        if not resolved.is_relative_to(root) or file.is_symlink():
            issues.append(f"Requirement include escaped the plugin: {file.name}")
            return
        if resolved in seen_files:
            return
        seen_files.add(resolved)
        source = resolved.relative_to(root).as_posix()
        if not file.is_file():
            issues.append(f"Requirement include is missing: {source}")
            return
        for raw in file.read_text(encoding="utf-8-sig").replace("\\\n", "").splitlines():
            line = re.split(r"\s+#", raw.strip(), maxsplit=1)[0].strip()
            if not line or line.startswith("#"):
                continue
            include = re.fullmatch(r"(?:-r\s*|--requirement[=\s]+)(.+)", line)
            if include:
                read_file(file.parent / include[1].strip())
            elif line.startswith("-"):
                issues.append(f"Unsupported requirement option needs review in {source}: {line}")
            else:
                add(line, source)

    for file in sorted(root.iterdir()):
        if file.is_file() and REQUIREMENT_FILES.fullmatch(file.name):
            read_file(file)
    project_path = root / "pyproject.toml"
    if project_path.is_file():
        try:
            project = tomllib.loads(project_path.read_text(encoding="utf-8-sig")).get("project", {})
            for raw in project.get("dependencies", []):
                add(raw, "pyproject.toml")
            if project.get("requires-python"):
                add("python" + project["requires-python"], "pyproject.toml#requires-python")
            if "dependencies" in project.get("dynamic", []):
                issues.append("Dynamic dependency metadata requires separate review.")
        except Exception as error:
            issues.append(f"Cannot read pyproject.toml: {error}")

    # Check active extras and installed transitive requirements as well as roots.
    expanded = set()
    for record in records:
        if not record["active"] or record["normalizedName"] not in versions:
            continue
        name, extras = record["normalizedName"], tuple(record["extras"])
        if (name, extras) in expanded:
            continue
        expanded.add((name, extras))
        for raw in installed_requirements.get(name, []):
            try:
                req = Requirement(raw)
                if active_requirement(req, environment, extras):
                    # Marker was evaluated using the parent's selected extras.
                    req.marker = None
                    add(str(req), f"installed-metadata:{name}")
            except Exception as error:
                issues.append(f"Cannot read installed dependency metadata for {name}: {error}")
    return records, sorted(set(issues))


def analyze(request):
    versions, requirements, native = installed_state()
    versions = {canonicalize_name(k): v for k, v in request.get("installedPackages", versions).items()}
    requirements = request.get("installedRequirements", requirements)
    environment = dict(default_environment(), **request.get("markerEnvironment", {}))
    current, current_issues = read_declarations(request["currentRoot"], versions, environment, native, requirements)
    target, target_issues = read_declarations(request["targetRoot"], versions, environment, native, requirements)
    return {"current": current, "target": target, "issues": target_issues,
            "currentIssues": current_issues, "installedPackages": versions,
            "installedRequirements": requirements, "markerEnvironment": environment}


def trusted_wheel_url(url, wheelhouse=None):
    parsed = urlparse(url)
    if parsed.scheme == "https" and parsed.hostname == "files.pythonhosted.org" and not parsed.username and not parsed.password:
        return True
    if wheelhouse and parsed.scheme == "file":
        local = Path(unquote(parsed.path.lstrip("/") if os.name == "nt" else parsed.path)).resolve()
        return local.is_relative_to(Path(wheelhouse).resolve())
    return False


def wheel_metadata(wheel, destination, wheelhouse=None):
    if not trusted_wheel_url(wheel["url"], wheelhouse):
        raise RuntimeError("Wheel provenance requires review: " + wheel["url"])
    destination = Path(destination)
    if destination.is_symlink():
        raise RuntimeError('Wheel cache directory contains a link requiring review.')
    destination.mkdir(parents=True, exist_ok=True)
    path = destination / wheel["filename"]
    if path.is_symlink():
        raise RuntimeError('Wheel cache file contains a link requiring review.')
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != wheel["sha256"]:
        temporary = path.with_suffix(f".{uuid.uuid4()}.partial")
        digest = hashlib.sha256()
        with urlopen(wheel["url"], timeout=30) as response, temporary.open("wb") as output:
            if not trusted_wheel_url(response.geturl(), wheelhouse):
                raise RuntimeError("Wheel redirect escaped the approved source.")
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != wheel["sha256"]:
            temporary.unlink(missing_ok=True)
            raise RuntimeError("Downloaded wheel hash does not match the update plan.")
        temporary.replace(path)
    with zipfile.ZipFile(path) as archive:
        entries = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
        wheel_entries = [name for name in archive.namelist() if name.endswith(".dist-info/WHEEL")]
        if len(entries) != 1 or len(wheel_entries) != 1:
            raise RuntimeError("Ambiguous wheel metadata.")
        info = BytesParser().parsebytes(archive.read(entries[0]))
        wheel_info = archive.read(wheel_entries[0]).decode("utf-8")
        if canonicalize_name(info["Name"]) != wheel["name"] or info["Version"] != wheel["version"]:
            raise RuntimeError("Wheel identity does not match the update plan.")
        if info.get("Requires-Python") and not satisfies(default_environment()["python_full_version"], info["Requires-Python"]):
            raise RuntimeError("Wheel requires a different Python version.")
        binary = "Root-Is-Purelib: false" in wheel_info or any(Path(name).suffix.lower() in NATIVE_SUFFIXES for name in archive.namelist())
        return info.get_all("Requires-Dist", []), binary


def select_wheel(package, tags, wheelhouse=None):
    candidates = []
    for entry in package.get("wheels", []):
        url = entry.get("url", "")
        filename = entry.get("name") or Path(unquote(urlparse(url).path)).name
        name, version, _, wheel_tags = parse_wheel_filename(filename)
        matching = set(wheel_tags).intersection(tags)
        if not matching or canonicalize_name(name) != package["name"] or str(version) != package["version"]:
            continue
        sha = entry.get("hashes", {}).get("sha256", "")
        # Offline fixtures have no index hash. Production never uses this path.
        if not sha and wheelhouse and trusted_wheel_url(url, wheelhouse):
            parsed = urlparse(url)
            local = Path(unquote(parsed.path.lstrip('/') if os.name == 'nt' else parsed.path))
            sha = hashlib.sha256(local.read_bytes()).hexdigest()
            entry = dict(entry, hashes={"sha256": sha}, size=local.stat().st_size)
        if not re.fullmatch(r"[a-f0-9]{64}", sha):
            continue
        candidates.append((min(tags[tag] for tag in matching), filename, entry, wheel_tags))
    if not candidates:
        raise RuntimeError("No compatible hashed wheel for " + package["name"])
    _, filename, entry, wheel_tags = min(candidates, key=lambda candidate: candidate[:2])
    return {"name": package["name"], "version": package["version"], "filename": filename,
            "url": entry["url"], "sha256": entry["hashes"]["sha256"], "size": entry.get("size", 0),
            "tags": sorted(map(str, wheel_tags))}


def requirement_issues(versions, requirements, environment):
    result = set()
    for owner, raws in requirements.items():
        for raw in raws:
            try:
                req = Requirement(raw)
                if active_requirement(req, environment) and (req.url or not satisfies(versions.get(canonicalize_name(req.name)), str(req.specifier))):
                    result.add(f"{owner}: {req}")
            except Exception:
                result.add(f"{owner}: unrecognized metadata: {raw}")
    return result


def resolve_wheels(request, uv, output_dir, wheelhouse=None):
    root = Path(output_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    versions = request["installedPackages"]
    metadata_requirements = request.get("installedRequirements", {})
    environment = request.get("markerEnvironment", default_environment())
    protected = set(request["protectedNames"])
    wheel_cache = Path(request.get('wheelCacheDir') or root / 'wheels')
    roots = [Requirement(raw) for raw in request["requirements"]]
    if any(req.url for req in roots):
        raise RuntimeError("Direct URL dependencies require separate review.")
    constraints = root / "constraints.txt"
    constraints.write_text("\n".join(f"{name}=={versions[name]}" for name in sorted(protected.intersection(versions))), encoding="utf-8")
    baseline_issues = requirement_issues(versions, metadata_requirements, environment)
    retained = {name for name, version in versions.items() if all(
        satisfies(version, str(req.specifier)) for req in roots if canonicalize_name(req.name) == name)}
    selected = {}
    last_candidate_requirements = {}
    tags = {tag: index for index, tag in enumerate(sys_tags())}
    env = {key: value for key, value in os.environ.items() if not key.startswith(("UV_", "PIP_"))}
    env.update(UV_PYTHON_DOWNLOADS="never", UV_NO_CONFIG="1", PYTHONDONTWRITEBYTECODE="1")
    for attempt in range(8):
        constraints_lines = {f"{name}=={versions[name]}" for name in protected.intersection(versions)}
        # Preserve requirements of retained distributions that currently work.
        # Let uv backtrack the new package to a compatible wheel rather than
        # choosing its latest version and accidentally breaking another node.
        selected_extras = {}
        for req in roots:
            selected_extras.setdefault(canonicalize_name(req.name), set()).update(req.extras)
        for owner in retained:
            for raw in metadata_requirements.get(owner, []):
                try:
                    requirement = Requirement(raw)
                    name = canonicalize_name(requirement.name)
                    if not requirement.url and active_requirement(requirement, environment, selected_extras.get(owner, ())) and satisfies(versions.get(name), str(requirement.specifier)):
                        constraints_lines.add(name + str(requirement.specifier))
                except Exception:
                    pass  # Existing invalid metadata is reported separately.
        constraints.write_text('\n'.join(sorted(constraints_lines)), encoding='utf-8')
        input_path, excludes, lock = root / "requirements.in", root / "excludes.txt", root / "pylock.toml"
        input_path.write_text("\n".join(sorted({str(req) for req in roots})), encoding="utf-8")
        excludes.write_text("\n".join(sorted(retained)), encoding="utf-8")
        args = [uv, "--no-config", "pip", "compile", str(input_path), "--python", sys.executable,
                "--no-python-downloads", "--no-build", "--no-sources",
                "--constraints", str(constraints), "--excludes", str(excludes), "--format", "pylock.toml",
                "--output-file", str(lock), "--cache-dir", str(wheel_cache / "uv-cache")]
        args.extend(["--no-index", "--find-links", str(Path(wheelhouse).resolve())] if wheelhouse else ["--default-index", "https://pypi.org/simple"])
        completed = subprocess.run(args, cwd=root, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45)
        if completed.returncode:
            conflicts = {}
            for candidate, raws in last_candidate_requirements.items():
                for raw in raws:
                    req = Requirement(raw)
                    name = canonicalize_name(req.name)
                    if not active_requirement(req, environment, selected_extras.get(candidate, ())) or satisfies(versions.get(name), str(req.specifier)):
                        continue
                    for owner in retained:
                        for existing_raw in metadata_requirements.get(owner, []):
                            existing = Requirement(existing_raw)
                            if canonicalize_name(existing.name) == name and active_requirement(existing, environment, selected_extras.get(owner, ())) and satisfies(versions.get(name), str(existing.specifier)):
                                edges = conflicts.setdefault(name, set())
                                edges.update([(candidate, str(req.specifier)), (owner, str(existing.specifier))])
            report = [{ 'dependency': name, 'requirements': [{ 'owner': owner, 'constraint': constraint } for owner, constraint in sorted(edges)] } for name, edges in sorted(conflicts.items())]
            raise ResolutionFailure(report, completed.stderr[-10000:])
        resolved = tomllib.loads(lock.read_text(encoding="utf-8"))
        selected = {}
        package_requirements = dict(metadata_requirements)
        for package in resolved.get("packages", []):
            name = canonicalize_name(package["name"])
            package = dict(package, name=name)
            if versions.get(name) == package["version"]:
                continue
            if name in protected:
                raise RuntimeError("Protected package cannot change in a plugin update: " + name)
            wheel = select_wheel(package, tags, wheelhouse)
            requirements, binary = wheel_metadata(wheel, wheel_cache / wheel['sha256'], wheelhouse)
            wheel["compiled"] = binary
            selected[name] = wheel
            package_requirements[name] = requirements
        last_candidate_requirements = {name: package_requirements[name] for name in selected}
        candidate = dict(versions, **{name: wheel["version"] for name, wheel in selected.items()})
        needed, active_extras = [], {}
        for req in roots:
            active_extras.setdefault(canonicalize_name(req.name), set()).update(req.extras)
        visited = set()
        queue = list(roots)
        for req in queue:
            name = canonicalize_name(req.name)
            if req.url:
                raise RuntimeError("Transitive direct URL dependency needs separate review: " + str(req))
            if not satisfies(candidate.get(name), str(req.specifier)):
                if name in protected:
                    raise RuntimeError("Target requires a protected stack change: " + str(req))
                needed.append(req)
            extras = active_extras.setdefault(name, set())
            extras.update(req.extras)
            key = (name, tuple(sorted(extras)))
            if key in visited:
                continue
            visited.add(key)
            for raw in package_requirements.get(name, []):
                child = Requirement(raw)
                if active_requirement(child, environment, extras):
                    child.marker = None
                    queue.append(child)
        if needed:
            for req in needed:
                name = canonicalize_name(req.name)
                if name in retained:
                    # Once visible to uv, the parent's own metadata determines
                    # this edge. Do not pin an edge from a discarded candidate:
                    # doing so prevents the resolver from backtracking it.
                    retained.remove(name)
                elif name not in selected:
                    roots.append(req)
                else:
                    raise RuntimeError('Selected wheel metadata does not satisfy its dependency closure: ' + str(req))
            continue
        new_issues = requirement_issues(candidate, package_requirements, environment) - baseline_issues
        if new_issues:
            raise RuntimeError("Update would conflict with installed packages: " + "; ".join(sorted(new_issues)))
        changes = []
        direct = {canonicalize_name(Requirement(raw).name) for raw in request["requirements"]}
        for name, wheel in sorted(selected.items()):
            changes.append({"name": name, "from": versions.get(name), "to": wheel["version"],
                            "kind": "changed" if name in versions else "added", "compiled": wheel["compiled"],
                            "protected": False, "reason": "direct" if name in direct else "transitive", "wheel": wheel})
        return {"changes": changes, "expectedPackages": candidate}
    raise RuntimeError("Dependency resolution exceeded the review limit.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("analyze", "resolve"))
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--uv")
    parser.add_argument("--wheelhouse")
    args = parser.parse_args()
    try:
        request = json.loads(Path(args.request).read_text(encoding="utf-8-sig"))
        result = analyze(request) if args.command == "analyze" else resolve_wheels(request, args.uv, Path(args.output).parent, args.wheelhouse)
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        return 0
    except Exception as error:
        failure = {'error': str(error), 'errorCode': getattr(error, 'code', 'wheel-resolution-failed'), 'conflicts': getattr(error, 'conflicts', []), 'details': getattr(error, 'details', '')}
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(json.dumps(failure, ensure_ascii=False), encoding='utf-8')
        print(f"ERROR: {error}", file=sys.stderr)
        if os.environ.get('FR_DEPENDENCY_DEBUG') == '1':
            traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
