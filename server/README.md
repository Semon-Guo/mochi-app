# Mochi 同步服务

课题组共用的实验记录同步后端。**只同步实验记录**（`projects` / `records` / 照片）——
个人待办、专注计时、timeline 全部留在设备本地，不上传、服务器也没有对应的表。

学生读写自己的记录，导师只读全组的（导师也**不能**修改学生的记录，服务端强制）。

### 角色

| 角色 | 能做什么 |
|---|---|
| `student` | 只读写自己的记录 |
| `advisor` | 加上：读全组的实验记录（改不了别人的，服务端强制） |
| `admin` | 加上：成员管理、邀请码、服务器状态、审计日志 |

**注册一律是学生**，导师和管理员由管理员在界面上直接任命。曾经有过「导师邀请码」
（用它注册即导师），后来取消了——那等于把「谁能看全组记录」的门槛降成「知道一串
字符」，而任命本来就是低频操作，没必要为它开一道后门。

管理员在导师端的「管理」tab 里可以：任命/收回角色、重置密码、强制某人所有设备
登出、标记离组、更换邀请码、查看服务器状态和操作日志。

**离组不删数据。**实验记录是课题组的资产，人走了数据得留下——以后追溯某个结论
怎么来的还得靠它。标记离组只是把人从导师端主视图挪进「已离组」折叠区，记录一条
不少，点进去照样能翻。会话会被吊销，可以随时恢复在组。

真正的删除（`/api/admin/remove`）保留着，但只该用来清理误注册和测试账号，界面上
需要两步确认并写明「记录一并消失」。

### 谁出现在「按成员」里

服务端给每个人算一个 `inGroup`：`role == "student"` 或有任何记录/项目。
纯管理账号（比如只用来审批、一条记录都没有的管理员）不会占着成员列表——
那个位置是留给做科研产出的人的。

几条刻意加的约束：

- **管理员不能改自己的角色、不能删自己**——降错了就只能 SSH 上服务器救
- **不能降级或删除最后一个管理员**——否则没人能再管理
- **重置密码只能生成随机临时密码**，管理员无法指定。否则他就知道了别人的密码，
  之后能冒充对方；临时密码只回显一次，且会顺带吊销该用户所有旧会话
- **本人改密码要验旧密码**，否则设备被人短暂拿到就能改掉密码锁死账号
- 所有管理动作写入 `audit_log`，界面上可查

## 为什么是纯标准库 Python

这台服务器访问 GitHub releases 不稳定（装 Bun 时下载超时失败）。任何需要下载运行时或
依赖的方案都会在部署和以后的维护上反复卡住，所以整个服务只用 Python 3.12 标准库：
`sqlite3` 存数据、`hashlib` 做密码哈希、`http.server` 起服务。零 pip install。

## 当前部署

| 项 | 值 |
|---|---|
| 机器 | `wang@172.29.249.177` |
| 代码 | `~/mochi/server/` |
| 数据 | `~/mochi-data/`（`mochi.db` + `photos/` + `files/`，权限 700/600） |
| 配置 | `~/mochi/server.env`（权限 600）；邀请码存在数据库里，界面可改 |
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
python3 server/test_server.py   # 服务端 API（175 项）
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
| POST | `/api/register` | `{username, password, displayName, inviteCode}` → `{token, user}`；身份由用的哪个码决定 |
| POST | `/api/login` | `{username, password}` → `{token, user}` |
| POST | `/api/logout` | 吊销当前 token |
| GET | `/api/me` | 当前用户 |
| GET | `/api/users` | 成员列表（导师 / 管理员） |
| GET | `/api/overview` | 全组统计聚合（导师 / 管理员） |
| POST | `/api/admin/role` | `{userId, role}` 任命角色（仅管理员） |
| POST | `/api/admin/remove` | `{userId}` 移除成员及其全部数据（仅管理员） |
| POST | `/api/admin/reset-password` | `{userId}` → `{tempPassword}`（仅管理员） |
| POST | `/api/admin/revoke-sessions` | `{userId}` 强制登出（仅管理员） |
| GET/POST | `/api/admin/invite` | 查看 / 更换邀请码（仅管理员） |
| GET | `/api/admin/status` | 磁盘、数据量、备份、推送状态（仅管理员） |
| GET | `/api/admin/audit` | 操作日志（仅管理员） |
| POST | `/api/password` | `{oldPassword, newPassword}` 本人改密码 |
| POST | `/api/avatar` | 设置头像（data URL，≤96KB） |
| POST | `/api/profile` | 改显示名 |
| GET | `/api/sync?since=<seq>` | 增量拉取，返回 `{projects, records, photos, comments, milestones, seq, more}` |
| POST | `/api/sync` | 推送 `{projects:[], records:[], photos:[], comments:[], milestones:[]}` |
| POST | `/api/photo/<id>` | 上传照片二进制（元数据须先经 `/api/sync` 建好） |
| GET | `/api/photo/<id>` | 下载照片（本人或导师） |
| POST | `/api/file/<id>/init` | 登记数据文件 `{name, size, mime}` → `{received}` 续传点 |
| POST | `/api/file/<id>?offset=N` | 追加一个分块，传满即完成 |
| GET | `/api/file/<id>` | 下载数据文件，支持 `Range`（本人或导师） |
| POST | `/api/file/<id>/ticket` | 换一张 5 分钟有效的下载票 → `{url}` |
| POST | `/api/file/<id>/drop` | 删掉自己的一个数据文件 |
| POST | `/api/admin/gc` | 立刻回收无人引用的数据文件（仅管理员） |

### 数据文件（原始测量结果）

照片和数据文件走的是两条完全不同的路，**别把它们并成一条**：

| | 照片 | 数据文件 |
|---|---|---|
| 体量 | 压到长边 1600 的 JPEG，几百 KB | 原始数据，几百 MB |
| 本地 | 存 IndexedDB，每台设备都有一份 | **不存**，只在记录里留文件名和大小 |
| 上传 | 由同步循环顺带推上去，可离线 | 选中即分块直传，**必须在线** |
| 取用 | 自动下到每台设备 | 点一下才现拉 |

几百 MB 的东西不能按照片那套来：本地库会被撑爆，手机上直接崩，而且没人希望
自己的手机后台默默拉下组里所有人的数据集。代价是上传必须在线——这是有意的，
攒在本地「回头再传」对几百 MB 只会变成「以为传上去了其实没有」。

- 上传全程流式落盘，服务端不把请求体读进内存；断了重新 `init` 就从断点续传
- 文件名、大小这些元数据跟着记录正文一起同步（`record.data.files[]`），
  `files` 表只回答「这坨字节归谁、传完了没有」，因此**不在 `SYNC_TABLES` 里**
- 下载不走 `Authorization`：`<a href>` 带不上请求头，而几百 MB 必须交给浏览器
  自己去拉（能续传、能进下载列表、不占页面内存），所以先换一张短期下载票，
  长期 token 不进 URL、不进访问日志
- 上传是选完文件就发生的，而引用它的记录可能永远没保存。所以有一个 6 小时一轮的
  回收：超过宽限期仍没被任何记录引用的文件一律删掉，否则每次中途放弃都在磁盘上
  留下几百 MB

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MOCHI_MAX_FILE_MB` | 512 | 单个数据文件上限 |
| `MOCHI_USER_QUOTA_MB` | 10240 | 每人数据文件总量上限 |
| `MOCHI_ORPHAN_GRACE_H` | 24 | 多久没被记录引用就回收 |

### 可见性：两处「不是我的行也得给我」

同步的默认规则是「只给你自己的行」，但有两处必须破例，否则功能是断的：

| 例外 | 为什么 | 怎么实现 |
|---|---|---|
| 导师建的项目 | 学生看不到这个项目就没法往里记 | 成员名单存在项目 `data.members` 里跟着同步走；服务端另存一张 `project_members` 倒排表，拉取时走索引 |
| 别人对我的记录写的回复和赞 | 那条评论的 `owner_id` 是导师，按 owner 过滤学生根本拉不到 | 写入时冗余存一份 `target_owner`（被评论记录的作者），拉取条件是 `owner_id = 我 OR target_owner = 我` |

两个坑：

- **评论的墓碑不能清 `target_owner`**。取消赞是删除，删除时 `data` 是空的，
  跟着把 `target_owner` 清掉的话学生就拉不到这条墓碑，那个赞会永远留在他屏幕上。
- **评论只能挂在自己看得到的记录上**（`comment_target_error`）。不查的话，
  猜中一个记录 id 就能往别人的记录下面塞东西，而且靠 `target_owner` 直接
  显示到对方界面上。

「未读」状态**只存在本机**（`src/seen.js`），不上服务器：那是导师一个人的
阅读进度，没有理由让被看的学生知道他读没读、什么时候读的。

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
| `src/files.js` | 数据文件的分块上传 / 续传 / 凭票下载 |
| `src/photos.js` / `src/PhotoView.jsx` | 照片的存取 / 显示组件（主应用和导师端共用） |
| `src/comments.js` / `src/Comments.jsx` | 回复与点赞的纯逻辑 / UI |
| `src/seen.js` | 导师端「哪些记录还没看」，只存本机 |
| `src/Calendar.jsx` | 日历：月视图 / 周日程 / 重点节点编辑 |
| `src/time.js` | 北京时间原语（全组按同一时区归日） |
| `src/SyncUI.jsx` | 同步状态条、登录/注册表单、导师视图 |

**关键设计**：业务代码里那 23 处 `setData` 一处都没改。`todo-notes-app.jsx`
把 `setData` 包了一层，每次状态更新自动 diff 出变化的实验记录、盖 `updatedAt`、
给删掉的留墓碑，结果塞进 `data._sync`。渲染代码看不见它。

同步合并的结果走另一条通道 `applySync`（不过 `stampChanges`）——否则刚从服务器
拉下来的记录会被当成本地新改动，下一轮又推回去。

### 测试

```bash
node src/sync.test.mjs      # 同步引擎纯逻辑（54 项）
node src/sync.e2e.mjs       # 前端引擎 × 真实后端，模拟多设备（74 项）
python3 server/test_server.py   # 服务端 API（174 项；服务器上多一项 scrypt，共 175）
```

### 推送

到点提醒之外，**导师点赞或点评学生的记录时，会推给记录的作者**。发送时机在
`/api/sync` 写入之后：

- 只在评论是**新增**时发。客户端偶尔会重推同一条（推送记账丢了），按
  `updatedAt` 判断的话对方会被同一个赞反复吵醒。
- 落库提交完再发，且丢到后台线程里——占着写锁做网络 I/O 会把整个同步卡住，
  发到一半回滚则会让对方收到一条并不存在的点评。
- 自己评自己的记录不发（学生回导师的话，通知不该回到他自己手机上）。

`server/test_push_e2e.py` 把这条链路整个走了一遍：起一个假的推送端点，让服务器
真推一条过来，再按 RFC 8291 解密回明文，核对标题正文。**这个测试要 cryptography，
Mac 上装的是 LibreSSL 跑不了，得在服务器上跑。**

### 排版自检

界面上的错测试基本抓不到。`dev/preview.html` 用**真实组件 + 造的数据**渲染，
配 `dev/shot.mjs`（CDP 驱动无头 Chrome）截图，改完界面能自己看一眼：

```bash
npm run dev
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9333 --user-data-dir=/tmp/mochi-shot --hide-scrollbars &
node dev/shot.mjs "http://localhost:5173/mochi-app/dev/preview.html?view=按项目" out.png
```

`?app=1` 看学生端，`?view=` 切页签，`?open=` 点进详情。

`migrateLab` 每次启动抹掉项目 `ownerId`/`members` 那个 bug 就是这么发现的——
渲染出学生端那一屏，看见本该是「组级项目」标签的位置摆着删除按钮。

`sync.e2e.mjs` 会自己起一个临时服务实例，不碰正式数据。它覆盖了多设备双向同步、
学生间隔离、导师只读、LWW 冲突、删除传播，以及**待办和计时数据确认不上传**。

## 推送通知

页面里的定时器在 app 退到后台后就被系统冻结了，所以「到点提醒」只能靠服务器
推过来唤醒 Service Worker。

**协议自己实现在 `webpush.py`**（RFC 8291 消息加密 + RFC 8292 VAPID），
只用系统已有的 `cryptography`，没有引入 pywebpush 那一串依赖——这台机器装包
一直不顺，能少一个是一个。

```
客户端订阅 → /api/push/subscribe 存下 endpoint 和密钥
客户端每次同步 → /api/reminders 整份上报「未来还会响的提醒」（全量替换）
后台线程每 30 秒 → 扫出到点的，加密后 POST 到 Apple/Google 的推送端点
设备收到 → 系统唤醒 SW → public/push-sw.js 弹出通知
```

| 项 | 值 |
|---|---|
| VAPID 密钥 | `~/mochi/vapid.json`（权限 600，**换掉的话所有人都要重新订阅**） |
| 扫描间隔 | 30 秒 |
| 补发窗口 | 只补最近 1 小时内到期的——机器关了一整晚，早上不该被隔夜提醒砸醒 |
| 失效清理 | 推送端点返回 404/410 即删除订阅；连续失败 10 次也删 |

### 前提（iOS）

- 必须是**添加到主屏幕**的 PWA，Safari 标签页里连 API 都没有
- iOS 16.4 以上
- 权限必须在用户手势里申请

### 隐私

推送内容是**端到端加密**的：用订阅自带的密钥加密，Apple / Google 转发时
解不开明文，只能看到「某设备在某时刻收到一条多大的消息」。

但任务标题会以明文存在**本服务器**的 `reminders` 表里（推送时要用）。
不开推送就不上报——服务器不需要知道你要做什么、什么时候做。

### 测试

```bash
python3 server/test_webpush.py    # 用 RFC 8291 官方测试向量逐字节比对加密结果（16 项）
python3 server/test_push_e2e.py   # 全链路：服务器真推一条 → 本地假端点接收 → 解密还原（28 项）
```

`test_push_e2e.py` 自己扮演浏览器（生成 P-256 订阅密钥、按 RFC 解密），
能解出原文就说明 VAPID 签名、消息加密、HTTP 格式三样都是对的。

## 还没做

- 权限细分（现在只有 学生 / 导师 两种角色）
- 服务端还没有清理无引用照片的机制
- 推送没有重试队列：单次发送失败就等下一条提醒，不会补发
