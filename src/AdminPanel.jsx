import { useState, useEffect } from "react";
import * as Sync from "./sync.js";
import { Avatar } from "./AdvisorView.jsx";

/* 管理面板：成员、邀请码、服务器状态、审计日志。
 *
 * 设计取向是「少而准」——一个 20 人的课题组，管理员真正会用到的动作就那么几个：
 * 有人该提成导师、有人忘了密码、有人毕业要清号、码泄露了要换、磁盘快满了要知道。
 * 每个危险动作都是两步确认，且全部写进审计日志。
 */

const C = {
  bg: "#FDFBF7", panel: "#FFFDF9", ink: "#2C2C2C", sub: "#8C8478",
  dim: "#B0A99B", line: "#EDE8DE", hair: "#F4F0E7",
  amber: "#C08A1E", green: "#5A9E4B", red: "#C02556", blue: "#5B7FC7",
};
const MONO = "'JetBrains Mono','SF Mono','Menlo',monospace";

const fmtBytes = (n) => {
  if (!n) return "0";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtWhen = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function Panel({ title, hint, children }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.panel,
      padding: 14, marginBottom: 12 }}>
      {title && (
        <div style={{ fontSize: 11, fontWeight: 700, color: C.sub, letterSpacing: "0.4px",
          textTransform: "uppercase", marginBottom: hint ? 3 : 9 }}>{title}</div>
      )}
      {hint && <div style={{ fontSize: 11.5, color: C.dim, marginBottom: 10, lineHeight: 1.6 }}>{hint}</div>}
      {children}
    </div>
  );
}

const btn = (bg, fg, extra = {}) => ({
  padding: "6px 11px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit",
  fontSize: 11.5, fontWeight: 600, border: "none", background: bg, color: fg, ...extra,
});
const ghost = { ...btn("#FFF", C.sub, { border: `1px solid ${C.line}` }) };

/* ── 单个成员的管理操作 ── */
function MemberRow({ m, me, token, onDone, onNotice }) {
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState("");     // 'remove' 需要二次确认
  const self = m.id === me.id;

  const run = async (key, fn, notice) => {
    setBusy(key); setConfirm("");
    try {
      const r = await fn();
      onNotice(notice ? notice(r) : "");
      onDone();
    } catch (e) { onNotice("✗ " + e.message); }
    finally { setBusy(""); }
  };

  const roleLabel = { admin: "管理员", advisor: "导师", student: "学生" }[m.role] || m.role;
  const roleColor = { admin: C.amber, advisor: C.blue, student: C.sub }[m.role] || C.sub;

  return (
    <div style={{ padding: "10px 0", borderTop: `1px solid ${C.hair}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ filter: m.archivedAt ? "grayscale(1)" : "none" }}><Avatar user={m} size={30} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
            {m.displayName}
            {self && <span style={{ fontSize: 10, color: C.dim, fontWeight: 400 }}>（你自己）</span>}
          </div>
          <div style={{ fontSize: 10.5, color: C.dim, fontFamily: MONO }}>
            @{m.username} · <span style={{ color: roleColor, fontWeight: 700 }}>{roleLabel}</span>
            {m.archivedAt && <span style={{ color: C.dim }}> · 已离组</span>}
          </div>
        </div>
      </div>

      {/* 自己不能改自己的角色，也不能删自己——降错了就只能 SSH 上服务器救 */}
      {!self && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, paddingLeft: 39 }}>
          {["student", "advisor", "admin"].filter((r) => r !== m.role).map((r) => (
            <button key={r} disabled={!!busy}
              onClick={() => run("role" + r, () => Sync.adminSetRole(token, m.id, r),
                () => `✓ ${m.displayName} 已设为${{ admin: "管理员", advisor: "导师", student: "学生" }[r]}`)}
              style={{ ...ghost, opacity: busy ? .5 : 1 }}>
              设为{{ admin: "管理员", advisor: "导师", student: "学生" }[r]}
            </button>
          ))}
          <button disabled={!!busy}
            onClick={() => run("pw", () => Sync.adminResetPassword(token, m.id),
              (r) => `✓ ${m.displayName} 的临时密码：${r.tempPassword}（只显示这一次，请转告本人并让其登录后修改）`)}
            style={{ ...ghost, opacity: busy ? .5 : 1 }}>重置密码</button>
          <button disabled={!!busy}
            onClick={() => run("rv", () => Sync.adminRevokeSessions(token, m.id),
              (r) => `✓ 已让 ${m.displayName} 的 ${r.revoked} 个登录设备全部登出`)}
            style={{ ...ghost, opacity: busy ? .5 : 1 }}>强制登出</button>
          {m.archivedAt ? (
            <button disabled={!!busy}
              onClick={() => run("un", () => Sync.adminArchive(token, m.id, false),
                () => `✓ ${m.displayName} 已恢复在组`)}
              style={{ ...ghost, opacity: busy ? .5 : 1 }}>恢复在组</button>
          ) : (
            <button disabled={!!busy}
              onClick={() => run("ar", () => Sync.adminArchive(token, m.id, true),
                () => `✓ ${m.displayName} 已标记离组。记录一条没删，在导师端「已离组」里仍可查看`)}
              style={{ ...ghost, opacity: busy ? .5 : 1 }}>标记离组</button>
          )}
          {/* 彻底删除只该用来清理误注册，所以要点两下、文案也说明白 */}
          <button disabled={!!busy}
            onClick={() => {
              if (confirm !== "remove") { setConfirm("remove"); return; }
              run("rm", () => Sync.adminRemove(token, m.id),
                (r) => `✓ 已删除 ${m.displayName}，连同 ${r.removed?.records || 0} 条记录、` +
                       `${r.removed?.projects || 0} 个项目、${r.removed?.photos || 0} 张照片`);
            }}
            style={{ ...btn(confirm === "remove" ? C.red : "#FFF",
              confirm === "remove" ? "#FFF" : C.dim,
              { border: `1px solid ${confirm === "remove" ? C.red : C.line}`, opacity: busy ? .5 : 1 }) }}>
            {confirm === "remove" ? "确认彻底删除？记录一并消失，不可恢复" : "彻底删除"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── 管理面板 ── */
export function AdminPanel({ auth, onChanged }) {
  const token = auth.token;
  const [members, setMembers] = useState([]);
  const [status, setStatus] = useState(null);
  const [audit, setAudit] = useState([]);
  const [invite, setInvite] = useState("");
  const [inviteDraft, setInviteDraft] = useState("");
  const [editInvite, setEditInvite] = useState(false);
  const [notice, setNotice] = useState("");
  const [err, setErr] = useState("");
  const [nonce, setNonce] = useState(0);
  const reload = () => { setNonce((n) => n + 1); onChanged?.(); };

  useEffect(() => {
    Promise.allSettled([
      Sync.fetchUsers(token), Sync.adminStatus(token),
      Sync.adminAudit(token), Sync.adminGetInvite(token),
    ]).then(([u, st, ad, iv]) => {
      if (u.status === "fulfilled") setMembers(u.value.users || []);
      if (st.status === "fulfilled") setStatus(st.value);
      if (ad.status === "fulfilled") setAudit(ad.value.entries || []);
      if (iv.status === "fulfilled") { setInvite(iv.value.code || ""); setInviteDraft(iv.value.code || ""); }
      const bad = [u, st, ad, iv].find((x) => x.status === "rejected");
      setErr(bad ? bad.reason?.message || "载入失败" : "");
    });
  }, [token, nonce]);

  const saveInvite = async () => {
    try {
      const r = await Sync.adminSetInvite(token, inviteDraft.trim());
      setInvite(r.code || ""); setEditInvite(false);
      setNotice(r.code ? "✓ 邀请码已更换，立即生效" : "✓ 已清空邀请码——现在任何人都能注册");
      reload();
    } catch (e) { setNotice("✗ " + e.message); }
  };

  const disk = status?.disk;
  const diskPct = disk ? Math.round((1 - disk.freeBytes / disk.totalBytes) * 100) : 0;

  return (
    <div style={{ paddingBottom: 24 }}>
      {err && <Panel><div style={{ color: C.red, fontSize: 13 }}>{err}</div></Panel>}
      {notice && (
        <div style={{ border: `1px solid ${notice.startsWith("✗") ? C.red : C.green}`,
          background: notice.startsWith("✗") ? "#FFF3F5" : "#F1F8EF", borderRadius: 12,
          padding: "11px 13px", marginBottom: 12, fontSize: 12.5, lineHeight: 1.7,
          color: notice.startsWith("✗") ? C.red : "#3B6B31", wordBreak: "break-all" }}>
          {notice}
          <button onClick={() => setNotice("")} style={{ ...ghost, marginLeft: 8, padding: "3px 8px" }}>
            知道了
          </button>
        </div>
      )}

      <Panel title="邀请码" hint="新成员注册时要填。改完立刻生效，不影响已注册的账号。">
        {editInvite ? (
          <div style={{ display: "flex", gap: 6 }}>
            <input value={inviteDraft} onChange={(e) => setInviteDraft(e.target.value)}
              autoCapitalize="none" autoCorrect="off" placeholder="留空则任何人都能注册"
              style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 9,
                border: `1px solid ${C.line}`, fontFamily: MONO, fontSize: 13, outline: "none" }} />
            <button onClick={saveInvite} style={{ ...btn(C.ink, "#FFF") }}>保存</button>
            <button onClick={() => { setEditInvite(false); setInviteDraft(invite); }}
              style={ghost}>取消</button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 13, background: "#F4F0E7",
              padding: "7px 10px", borderRadius: 8, overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap" }}>{invite || "（未设置——任何人都能注册）"}</code>
            <button onClick={() => setEditInvite(true)} style={ghost}>更换</button>
            <button onClick={() => { setInviteDraft(Math.random().toString(36).slice(2, 8) +
              Math.random().toString(36).slice(2, 8)); setEditInvite(true); }} style={ghost}>随机</button>
          </div>
        )}
      </Panel>

      <Panel title={`成员 · ${members.length}`}
        hint="「标记离组」保留全部记录，只是把人从导师端主视图挪到「已离组」里；
             「彻底删除」才会连数据一起清，只用于误注册。自己的角色改不了、也删不掉自己。">
        {members.map((m) => (
          <MemberRow key={m.id} m={m} me={auth.user} token={token}
            onDone={reload} onNotice={setNotice} />
        ))}
      </Panel>

      {status && (
        <Panel title="服务器状态">
          {disk && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 5 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>磁盘</span>
                <span style={{ fontSize: 11.5, color: diskPct > 90 ? C.red : C.sub, fontFamily: MONO }}>
                  已用 {diskPct}% · 剩余 {fmtBytes(disk.freeBytes)}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: C.hair, overflow: "hidden" }}>
                <div style={{ width: `${diskPct}%`, height: "100%",
                  background: diskPct > 90 ? C.red : diskPct > 75 ? C.amber : C.green }} />
              </div>
              {diskPct > 90 && (
                <div style={{ fontSize: 11, color: C.red, marginTop: 5, lineHeight: 1.6 }}>
                  磁盘快满了。写满时数据库会写入失败，甚至损坏——请尽快清理这台机器上的其他文件。
                </div>
              )}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(78px, 1fr))", gap: 10 }}>
            {[["成员", status.counts.users], ["项目", status.counts.projects],
              ["记录", status.counts.records], ["待办", status.counts.todos],
              ["照片", status.counts.photos], ["在线会话", status.counts.sessions]].map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 17, fontWeight: 700, fontFamily: MONO }}>{v}</div>
                <div style={{ fontSize: 10.5, color: C.sub }}>{k}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: C.sub, marginTop: 11, paddingTop: 10,
            borderTop: `1px solid ${C.hair}`, lineHeight: 1.8 }}>
            <div>数据库 {fmtBytes(status.dbBytes)} · 照片 {fmtBytes(status.photoBytes)}</div>
            <div>推送 {status.push ? "已启用" : "未启用"} · 注册 {status.inviteSet ? "需邀请码" : "开放"}</div>
            {status.backups?.length > 0 && (
              <div>最近备份 {fmtWhen(status.backups[0].at)}（{fmtBytes(status.backups[0].size)}，
                共 {status.backups.length} 份）</div>
            )}
          </div>
        </Panel>
      )}

      {audit.length > 0 && (
        <Panel title="操作日志" hint="所有管理动作都会记在这里。">
          {audit.slice(0, 20).map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 8, padding: "6px 0",
              borderTop: i ? `1px solid ${C.hair}` : "none", fontSize: 11.5 }}>
              <span style={{ fontFamily: MONO, color: C.dim, flexShrink: 0, width: 66 }}>
                {fmtWhen(e.at)}
              </span>
              <span style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>
                <b style={{ color: C.ink }}>{e.actor}</b>
                <span style={{ color: C.sub }}> {e.action} </span>
                {e.target && <b style={{ color: C.ink }}>{e.target}</b>}
                {e.detail && <span style={{ color: C.dim }}> · {e.detail}</span>}
              </span>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
