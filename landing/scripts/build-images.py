#!/usr/bin/env python3
"""
build-images.py — 世途旅游官网改版图片资源管线

把源图（生成图 / 真实照片）等比缩放到目标宽度，输出 avif/webp/jpg 三种格式到
landing/assets/img/。质量参数从"理想值"开始，若超出体积预算就自动降质重试，
直到落在预算内或触到质量下限为止（下限时如仍超预算，如实报告，不谎报）。

用法：
    python3 landing/scripts/build-images.py

幂等：重复运行会用同样的输入重新生成同样的输出（只要源图和参数不变，结果一致）。
不会删除或覆盖 SOURCES 列表之外的任何文件。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
REFS_DIR = Path(
    "/private/tmp/claude-501/-Users-bobwang-Documents-Flight-Ticket-Manager"
    "/f92b67fa-cc39-46e9-a963-8e490c4f0f42/scratchpad/design/refs"
)
OUT_DIR = REPO_ROOT / "landing" / "assets" / "img"

# 目标宽度 1920 的体积预算（宽度非 1920 的产物不做硬性预算校验，仍会走同样的质量流程）
BUDGET_1920 = {
    "avif": 300 * 1024,
    "webp": 450 * 1024,
    "jpg": 600 * 1024,
}

IDEAL_QUALITY = {"avif": 55, "webp": 82, "jpg": 86}
MIN_QUALITY = {"avif": 40, "webp": 70, "jpg": 78}
QUALITY_STEP = 5


@dataclass(frozen=True)
class Job:
    src: Path
    out_basename: str
    target_width: int


JOBS = [
    Job(REFS_DIR / "D2-hero-cloudtop.png", "hero-cloudtop.v2", 1920),
    Job(REFS_DIR / "D2-hero-cloudtop.png", "hero-cloudtop-960.v2", 960),
    Job(REFS_DIR / "D2-night-ramp.png", "ramp-night.v2", 1920),
    Job(REFS_DIR / "D2-coast-dusk.png", "coast-dusk.v2", 1920),
    Job(OUT_DIR / "office-reception.jpg", "office-reception.v2", 1400),
]


def load_and_resize(src: Path, target_width: int) -> Image.Image:
    img = Image.open(src)
    # 去 EXIF：转 RGB 重建像素数据，不带原图的元数据/EXIF/ICC profile 之外的多余 chunk。
    img = img.convert("RGB")

    width, height = img.size
    if width > target_width:
        new_height = round(height * (target_width / width))
        img = img.resize((target_width, new_height), Image.LANCZOS)
    # 源图更窄或相等则不放大，原样使用

    return img


def encode(img: Image.Image, fmt: str, quality: int) -> bytes:
    buf = BytesIO()
    if fmt == "avif":
        img.save(buf, format="AVIF", quality=quality)
    elif fmt == "webp":
        img.save(buf, format="WEBP", quality=quality)
    elif fmt == "jpg":
        img.save(
            buf,
            format="JPEG",
            quality=quality,
            optimize=True,
            progressive=True,
        )
    else:
        raise ValueError(f"unknown format: {fmt}")
    return buf.getvalue()


def encode_within_budget(img: Image.Image, fmt: str, target_width: int) -> tuple[bytes, int]:
    """从理想质量开始尝试，超预算就降质，直到达标或触底。返回 (数据, 最终质量值)。"""
    budget = BUDGET_1920[fmt] if target_width == 1920 else None
    quality = IDEAL_QUALITY[fmt]
    min_quality = MIN_QUALITY[fmt]

    data = encode(img, fmt, quality)
    if budget is None or len(data) <= budget:
        return data, quality

    while quality > min_quality:
        quality -= QUALITY_STEP
        data = encode(img, fmt, quality)
        if len(data) <= budget:
            return data, quality

    # 触底仍超预算：如实返回触底结果，由调用方报告超标
    return data, quality


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    results = []
    any_over_budget = False

    for job in JOBS:
        if not job.src.exists():
            print(f"[跳过] 源文件不存在: {job.src}", file=sys.stderr)
            continue

        img = load_and_resize(job.src, job.target_width)
        w, h = img.size

        for fmt in ("avif", "webp", "jpg"):
            data, quality = encode_within_budget(img, fmt, job.target_width)
            out_path = OUT_DIR / f"{job.out_basename}.{fmt}"
            out_path.write_bytes(data)

            size_bytes = len(data)
            budget = BUDGET_1920[fmt] if job.target_width == 1920 else None
            over_budget = budget is not None and size_bytes > budget
            if over_budget:
                any_over_budget = True

            results.append(
                {
                    "file": out_path.name,
                    "dims": f"{w}x{h}",
                    "bytes": size_bytes,
                    "quality": quality,
                    "budget": budget,
                    "over_budget": over_budget,
                }
            )

            status = ""
            if budget is not None:
                status = " [超预算!]" if over_budget else " [达标]"
            print(
                f"{out_path.name} / {w}x{h} / {size_bytes:,} bytes "
                f"/ quality={quality}{status}"
            )

    print()
    print("=" * 78)
    header = f"{'文件名':<32}{'尺寸':<12}{'字节数':<14}{'质量':<8}"
    print(header)
    print("-" * 78)
    for r in results:
        print(
            f"{r['file']:<32}{r['dims']:<12}{format(r['bytes'], ',') + ' B':<14}{r['quality']:<8}"
        )
    print("=" * 78)

    if any_over_budget:
        print("警告：存在超出体积预算且已触底质量下限的产物，见上方 [超预算!] 标记。")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
