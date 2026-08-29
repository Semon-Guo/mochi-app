#!/usr/bin/env python3
"""查看成员、设置角色。

导师权限只能从这里授予——需要能 SSH 到这台机器才能执行，
所以组里没人能靠抢注或者调接口把自己变成导师。

    python3 set_role.py                 列出所有成员
    python3 set_role.py <用户名> advisor  设为导师（可读全组记录）
    python3 set_role.py <用户名> admin    设为管理员（导师权限 + 审批导师申请）
    python3 set_role.py <用户名> student  收回为学生
"""
import os
import sqlite3
import sys
import time
from pathlib import Path

DB = Path(os.environ.get("MOCHI_DATA") or Path.home() / "mochi-data") / "mochi.db"
ROLES = ("student", "advisor", "admin")


def main(argv):
    if not DB.exists():
        print(f"数据库不存在: {DB}", file=sys.stderr)
        return 1
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row

    if len(argv) == 0:
        # 按权限层级排，不能靠字母序（student > admin > advisor，正好排反）
        rows = c.execute(
            "SELECT username, display_name, role, pending_role, created_at FROM users"
            " ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'advisor' THEN 1 ELSE 2 END, created_at"
        ).fetchall()
        if not rows:
            print("还没有人注册")
            return 0
        print(f"{'用户名':<20} {'显示名':<16} {'角色':<9} 注册时间")
        print("-" * 62)
        for r in rows:
            mark = "◆" if r["role"] == "admin" else "★" if r["role"] == "advisor" else " "
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(r["created_at"] / 1000))
            wait = "  ← 待审批导师" if r["pending_role"] else ""
            print(f"{mark}{r['username']:<19} {r['display_name']:<16} {r['role']:<9} {when}{wait}")
        return 0

    if len(argv) != 2 or argv[1] not in ROLES:
        print(__doc__)
        return 2

    username, role = argv[0].strip().lower(), argv[1]
    row = c.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row:
        print(f"没有这个用户: {username}", file=sys.stderr)
        return 1
    if row["role"] == role:
        print(f"{username} 已经是 {role}，无需改动")
        return 0

    c.execute("UPDATE users SET role = ? WHERE username = ?", (role, username))
    c.commit()
    print(f"{username}（{row['display_name']}）: {row['role']} → {role}")
    if role in ("advisor", "admin"):
        print("提醒：该账号现在能读取全组所有人的实验记录。")
    if role == "admin":
        print("      并且能批准别人的导师申请。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
