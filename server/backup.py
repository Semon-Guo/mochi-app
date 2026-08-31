#!/usr/bin/env python3
"""每天备份一次 SQLite 库，保留最近 14 份。

用 sqlite3 的在线备份 API，不锁库、不会拿到写到一半的快照，
所以可以在服务运行时直接跑（这台机器上没装 sqlite3 命令行工具）。

照片和数据文件不在这里备份——它们是不可变文件，量大，单独用 rsync 更合适。
"""
import os
import sqlite3
import sys
import time
from pathlib import Path

DATA_DIR = Path(os.environ.get("MOCHI_DATA") or Path.home() / "mochi-data")
DB = DATA_DIR / "mochi.db"
OUT = Path(os.environ.get("MOCHI_BACKUP") or Path.home() / "mochi" / "backups")
KEEP = 14


def main():
    if not DB.exists():
        print(f"数据库不存在: {DB}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / f"mochi-{time.strftime('%Y%m%d')}.db"

    src = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()

    old = sorted(OUT.glob("mochi-*.db"), key=lambda p: p.stat().st_mtime, reverse=True)[KEEP:]
    for p in old:
        p.unlink()

    size = dest.stat().st_size
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] 备份完成 {dest.name} "
          f"({size/1024:.1f} KB)，清理 {len(old)} 份旧备份")
    return 0


if __name__ == "__main__":
    sys.exit(main())
