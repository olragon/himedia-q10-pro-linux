#!/usr/bin/env python3
"""Replace drivers/media/platform/hisilicon/ new-file sections of patch 0008
with the tree files of the same name (histb-vdec-core.c, histb-vpss.c, ...).

usage: vdec-regen-core-patch.py <0008.patch> <tree-file> [<tree-file> ...]
0008 adds each file (-0,0 +1,N), so regeneration is a header + '+'-prefixed body.
"""
import os, re, sys


def regen(lines, src):
    body = open(src, encoding="utf-8", newline="").read()
    assert body.endswith("\n"), src
    body_lines = body[:-1].split("\n")
    tag = "diff --git a/drivers/media/platform/hisilicon/" + os.path.basename(src) + " "
    start = next(i for i, l in enumerate(lines) if l.startswith(tag))
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("diff --git ")), len(lines))
    hunk = next(i for i in range(start, end) if lines[i].startswith("@@ "))
    assert re.fullmatch(r"@@ -0,0 \+1,\d+ @@", lines[hunk]), lines[hunk]
    new = lines[start:hunk] + [f"@@ -0,0 +1,{len(body_lines)} @@"] + ["+" + l for l in body_lines]
    return lines[:start] + new + lines[end:]


patch = sys.argv[1]
lines = open(patch, encoding="utf-8", newline="").read().split("\n")
for src in sys.argv[2:]:
    lines = regen(lines, src)
open(patch, "w", encoding="utf-8", newline="").write("\n".join(lines))
