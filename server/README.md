# Mochi 同步服务

课题组共用的实验记录同步后端。**只同步实验记录**（`projects` / `records` / 照片）——
个人待办、专注计时、timeline 全部留在设备本地，不上传、服务器也没有对应的表。

学生读写自己的记录，导师只读全组的（导师也**不能**修改学生的记录，服务端强制）。

导师角色只能在服务器上用 `set_role.py` 授予——接口注册一律是学生，
否则组里谁先抢注谁就拿到了看全组记录的权限。

## 为什么是纯标准库 Python

这台服务器访问 GitHub releases 不稳定（装 Bun 时下载超时失败）。任何需要下载运行时或
依赖的方案都会在部署和以后的维护上反复卡住，所以整个服务只用 Python 3.12 标准库：
`sqlite3` 存数据、`hashlib` 做密码哈希、`http.server` 起服务。零 pip install。

## 当前部署

| 项 | 值 |
|---|---|
| 机器 | `wang@172.29.249.177` |
| 代码 | `~/mochi/server/` |
| 数据 | `~/mochi-data/`（`mochi.db` + `photos/`，权限 700/600） |
| 配置 | `~/mochi/server.env`（含邀请码，权限 600） |
| 日志 | `~/mochi/server.log` |
| 备份 | `~/mochi/backups/`，每天 3:30 自动备份，保留 14 份 |
| 服务 | systemd user unit `mochi.service`，已 enable + linger（重启自动拉起） |
| 端口 | **3000 = HTTPS API**，3001 = 明文 HTTP 根证书分发页 |
| 证书 | `~/mochi/certs/`（自签，SAN 绑 IP，有效期 397 天） |
| CA 私钥 | **只在你 Mac 的 `~/.mochi-ca/ca.key`，从不上传服务器** |

## 运维

```bash
python3 ~/mochi/server/set_role.py               # 列出所有成员
python3 ~/mochi/server/set_role.py <用户名> advisor  # 设为导师
systemctl --user status mochi        # 状态
systemctl --user restart mochi       # 重启
tail -f ~/mochi/server.log           # 看日志
python3 ~/mochi/server/test_server.py   # 跑回归测试（用临时库，不碰正式数据）
python3 ~/mochi/server/backup.py     # 手动备份一次
```

改配置（比如换邀请码）后需要重启：

```bash
vi ~/mochi/server.env && systemctl --user restart mochi
```

## API

所有接口除 `/api/health`、`/api/register`、`/api/login` 外都需要
`Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | `{username, password, displayName, inviteCode}` → `{token, user}`，**一律注册为学生** |
| POST | `/api/login` | `{username, password}` → `{token, user}` |
| POST | `/api/logout` | 吊销当前 token |
| GET | `/api/me` | 当前用户 |
| GET | `/api/users` | 成员列表（仅导师） |
| GET | `/api/sync?since=<seq>` | 增量拉取，返回 `{projects, records, photos, seq, more}` |
| POST | `/api/sync` | 推送 `{projects:[], records:[], photos:[]}` |
| POST | `/api/photo/<id>` | 上传照片二进制（元数据须先经 `/api/sync` 建好） |
| GET | `/api/photo/<id>` | 下载照片（本人或导师） |

### 同步模型

每条记录有两个时间维度，**这是有意分开的**：

- `updatedAt` —— 客户端修改这条记录的时刻，用来做 LWW 冲突判定（新的赢）
- `seq` —— 服务器写入时分配的全局递增号，客户端拿它当增量拉取的游标

20 台设备的时钟不可能一致，拿客户端时间当游标会漏数据，所以游标必须由服务器发号。

删除走**墓碑**：置 `deletedAt` 而不是真删行，否则客户端分不清「这条被删了」和
「这条还没同步过来」。拉取时墓碑记录的 `data` 为 `null`。

## 安全

- 密码用 scrypt（OpenSSL 3 环境）或 PBKDF2-SHA256 600k 迭代（回退），加盐存储，格式自描述
- 会话 token 是 32 字节密码学随机数，90 天不活动失效
- 登录时用户不存在也跑一次哈希校验，避免用响应时间区分「用户不存在」和「密码错」
- 数据目录 700、库文件 600，服务进程 `umask(0o077)`；`/home/wang` 本身是 750
- CORS 白名单在 `MOCHI_ORIGINS`，名单外的来源拿不到跨域头
- **注意**：有 root 的人仍然能读到这台机器上的一切，文件权限挡不住 root

## 证书

没有域名，所以用自建 CA 签了一张 SAN 绑 IP 的证书（`IP:172.29.249.177`）。
iOS 认 IP 类型的 SAN，所以不需要域名也能有合法 HTTPS。

三条 iOS 硬性要求都满足了：SAN 含 IP 条目、有效期 397 天（<398）、
extendedKeyUsage 含 serverAuth。

**每台设备要装一次根证书**，装完才能连。分发页：`http://172.29.249.177:3001/`
（这一页必须走明文——装证书之前 HTTPS 还不被信任；它只提供公开的根证书，没有敏感数据）。

- iPhone：用 **Safari** 打开分发页 → 装描述文件 →
  **设置 → 通用 → 关于本机 → 证书信任设置 → 打开开关**（这步最容易漏）
- Mac：下载 `ca.crt` → 双击 → 钥匙串里改成「始终信任」

### 每年续期

服务器证书 397 天到期，在 **Mac 上**跑：

```bash
./renew-cert.sh              # 默认 172.29.249.177
./renew-cert.sh <新IP>        # 服务器 IP 变了就传新 IP
```

设备端不用动——大家装的是 CA（10 年有效），换服务器证书对设备透明。

**注意**：证书 SAN 绑死了 IP，服务器 IP 一旦变化必须重签（脚本支持传新 IP）。

## 前端

同步相关代码在 `src/`：

| 文件 | 职责 |
|---|---|
| `src/sync.js` | 同步引擎：打戳、墓碑、LWW 合并、推拉、照片 |
| `src/photos.js` | 照片的 IndexedDB 存取（主应用和同步引擎共用） |
| `src/SyncUI.jsx` | 同步状态条、登录/注册表单、导师视图 |

**关键设计**：业务代码里那 23 处 `setData` 一处都没改。`todo-notes-app.jsx`
把 `setData` 包了一层，每次状态更新自动 diff 出变化的实验记录、盖 `updatedAt`、
给删掉的留墓碑，结果塞进 `data._sync`。渲染代码看不见它。

同步合并的结果走另一条通道 `applySync`（不过 `stampChanges`）——否则刚从服务器
拉下来的记录会被当成本地新改动，下一轮又推回去。

### 测试

```bash
node src/sync.test.mjs      # 同步引擎纯逻辑（19 项）
node src/sync.e2e.mjs       # 前端引擎 × 真实后端，模拟多设备（20 项）
python3 server/test_server.py   # 服务端 API（36 项）
```

`sync.e2e.mjs` 会自己起一个临时服务实例，不碰正式数据。它覆盖了多设备双向同步、
学生间隔离、导师只读、LWW 冲突、删除传播，以及**待办和计时数据确认不上传**。

## 还没做

- 权限细分（现在只有 学生 / 导师 两种角色）
- 服务端还没有清理无引用照片的机制
