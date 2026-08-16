from __future__ import annotations

import importlib.metadata
import json
import os
import platform
import sys
import time
from pathlib import Path


PACKAGES = (
    "torch",
    "torchvision",
    "torchaudio",
    "transformers",
    "diffusers",
    "accelerate",
    "triton",
    "triton-windows",
    "sageattention",
    "sageattn3",
    "xformers",
    "tensorrt",
)


def package_versions() -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for name in PACKAGES:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return versions


def timed_cuda_case(torch, name: str, operation) -> dict:
    try:
        torch.cuda.synchronize()
        started = time.perf_counter()
        value = operation()
        torch.cuda.synchronize()
        elapsed_ms = (time.perf_counter() - started) * 1000
        # PyTorch can create/compute Float8 tensors on Blackwell while
        # `torch.isfinite` itself has no Float8 kernel. The conversion to FP32
        # is part of validation, not the timed operation, and lets the probe
        # distinguish a real non-finite result from a missing inspection op.
        finite = bool(torch.isfinite(value.float()).all().item())
        return {"name": name, "status": "pass" if finite else "fail", "elapsedMs": elapsed_ms}
    except Exception as error:  # the probe must report every independent case
        return {"name": name, "status": "fail", "error": f"{type(error).__name__}: {error}"}


def main() -> int:
    result: dict = {
        "schemaVersion": 1,
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": {
            "version": platform.python_version(),
            "executable": str(Path(sys.executable).resolve()),
            "implementation": platform.python_implementation(),
        },
        "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "packages": package_versions(),
        "environment": {
            "CUDA_MODULE_LOADING": os.environ.get("CUDA_MODULE_LOADING"),
            "TORCHINDUCTOR_CACHE_DIR": os.environ.get("TORCHINDUCTOR_CACHE_DIR"),
            "TRITON_CACHE_DIR": os.environ.get("TRITON_CACHE_DIR"),
        },
        "cuda": {"available": False, "tests": []},
        "accelerators": [],
    }
    try:
        import torch
    except Exception as error:
        result["torchImportError"] = f"{type(error).__name__}: {error}"
        print(json.dumps(result, indent=2))
        return 2

    cuda = result["cuda"]
    cuda["torchVersion"] = torch.__version__
    cuda["runtime"] = torch.version.cuda
    cuda["available"] = torch.cuda.is_available()
    cuda["archList"] = torch.cuda.get_arch_list() if torch.cuda.is_available() else []
    if not torch.cuda.is_available():
        print(json.dumps(result, indent=2))
        return 3

    device = torch.cuda.current_device()
    properties = torch.cuda.get_device_properties(device)
    cuda.update(
        {
            "device": device,
            "name": properties.name,
            "computeCapability": list(torch.cuda.get_device_capability(device)),
            "totalMemory": properties.total_memory,
            "bf16Supported": bool(torch.cuda.is_bf16_supported()),
        }
    )
    import torch.nn.functional as functional

    def matmul(dtype):
        left = torch.randn((2048, 2048), device="cuda", dtype=dtype)
        right = torch.randn((2048, 2048), device="cuda", dtype=dtype)
        return left @ right

    def sdpa(dtype):
        query = torch.randn((1, 16, 2048, 128), device="cuda", dtype=dtype)
        key = torch.randn_like(query)
        value = torch.randn_like(query)
        return functional.scaled_dot_product_attention(query, key, value)

    cuda["tests"] = [
        timed_cuda_case(torch, "fp16-matmul", lambda: matmul(torch.float16)),
        timed_cuda_case(torch, "bf16-matmul", lambda: matmul(torch.bfloat16)),
        timed_cuda_case(torch, "fp16-sdpa", lambda: sdpa(torch.float16)),
        timed_cuda_case(torch, "bf16-sdpa", lambda: sdpa(torch.bfloat16)),
    ]
    if hasattr(torch, "float8_e4m3fn"):
        cuda["tests"].append(
            timed_cuda_case(
                torch,
                "fp8-e4m3fn-conversion",
                lambda: torch.randn((4096, 4096), device="cuda", dtype=torch.float16).to(torch.float8_e4m3fn),
            )
        )

    if result["packages"]["triton-windows"] is not None:
        try:
            import triton

            def compiled_operation(value):
                return torch.sin(value) * 1.5 + torch.cos(value)

            value = torch.randn((4096, 4096), device="cuda", dtype=torch.float16)
            reference = compiled_operation(value)
            compiled = torch.compile(compiled_operation, fullgraph=True)
            started = time.perf_counter()
            actual = compiled(value)
            torch.cuda.synchronize()
            first_compile_ms = (time.perf_counter() - started) * 1000
            max_abs = float((actual.float() - reference.float()).abs().max().item())
            result["accelerators"].append(
                {
                    "name": "triton-windows",
                    "status": "pass" if max_abs <= 0.01 else "fail",
                    "version": getattr(triton, "__version__", None),
                    "firstCompileMs": first_compile_ms,
                    "maxAbsError": max_abs,
                }
            )
        except Exception as error:
            result["accelerators"].append(
                {"name": "triton-windows", "status": "fail", "error": f"{type(error).__name__}: {error}"}
            )

    if result["packages"]["xformers"] is not None:
        try:
            import xformers.ops as xops

            query = torch.randn((1, 2048, 16, 64), device="cuda", dtype=torch.float16)
            key = torch.randn_like(query)
            value = torch.randn_like(query)
            native = functional.scaled_dot_product_attention(
                query.permute(0, 2, 1, 3),
                key.permute(0, 2, 1, 3),
                value.permute(0, 2, 1, 3),
            ).permute(0, 2, 1, 3)
            actual = xops.memory_efficient_attention(query, key, value)
            difference = (actual.float() - native.float()).abs()
            max_abs = float(difference.max().item())
            mean_abs = float(difference.mean().item())
            finite = bool(torch.isfinite(actual.float()).all().item())
            result["accelerators"].append(
                {
                    "name": "xformers",
                    "status": "pass" if finite and max_abs <= 0.05 and mean_abs <= 0.002 else "fail",
                    "maxAbsError": max_abs,
                    "meanAbsError": mean_abs,
                }
            )
        except Exception as error:
            result["accelerators"].append(
                {"name": "xformers", "status": "fail", "error": f"{type(error).__name__}: {error}"}
            )
    torch.cuda.empty_cache()
    cuda["memoryAfterProbe"] = {
        "allocated": torch.cuda.memory_allocated(device),
        "reserved": torch.cuda.memory_reserved(device),
        "maxAllocated": torch.cuda.max_memory_allocated(device),
    }
    failed = [test for test in cuda["tests"] if test["status"] != "pass"]
    failed.extend(test for test in result["accelerators"] if test["status"] != "pass")
    print(json.dumps(result, indent=2))
    return 4 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
