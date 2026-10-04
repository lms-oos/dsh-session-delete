# dsh-session-delete

在 DeepSeek Harness 侧边栏的对话列表里，给每条对话的 **「⋯」菜单**加一行 **删除对话**，确认后**永久删除**该对话在磁盘上的完整记录。

> DSH 自带归档（archive）、置顶、重命名、分叉，但**没有删除**：内核 0.2.0-rc.2 的两个 Remote 命名空间（`ctx.remote.session` / `ctx.remote.workspace`）里都没有 delete/remove/purge 会话的方法，官方 README 也写明"会话删除…尚未提供的功能"。本插件补上这一件事。

---

## 1. 用户看到什么

- 侧边栏任一对话行 → 悬停出现「⋯」→ 菜单最下方新增 **删除对话**（排在自带的 置顶 / 重命名 / 分叉 / 归档 之后，`order: 500`）。
- 点击弹出确认框：写明**永久删除、不可撤销、不进回收站**，可取消、可按 Esc 关闭。
- 确认后：磁盘上的会话目录被整目录删除，并且宿主广播 `api-session/removed`，侧边栏该行立即消失。
- 正在运行的对话由宿主拒绝（HTTP 409，提示先停止），不会删到一半。

---

## 2. 安装（已在本机执行）

```powershell
# 0) 备份（已执行，落在 D:\deepseek\backup\）
Copy-Item 'C:\Users\Lenovo\.dsh\profiles\desktop\package.json' 'D:\deepseek\backup\profile-desktop-package.json'
Copy-Item 'C:\Users\Lenovo\.dsh\profiles\desktop\pnpm-lock.yaml' 'D:\deepseek\backup\profile-desktop-pnpm-lock.yaml'

# 1) 把插件接进 profile（追加 link 依赖 + bundle 条目，其他字段与顺序不动）
node D:\deepseek\dsh-session-delete\scripts\install-profile.mjs `
     'C:\Users\Lenovo\.dsh\profiles\desktop' 'D:\deepseek\dsh-session-delete'

# 2) 安装（pnpm 11.7.0，exit=0）
node <runtime>\node.exe <runtime>\pnpm\bin\pnpm.mjs --dir 'C:\Users\Lenovo\.dsh\profiles\desktop' install
```

结果：`profiles\desktop\node_modules\dsh-session-delete` 是指向 `D:\deepseek\dsh-session-delete` 的 **Junction**，12 个 bundle 里新增 `dsh-session-delete`，其余插件（better-sidebar / ego-browser / cost-meter / dshmarket / approval-gate / modsearch …）全部健在。

`cordis.patch.yml` 由包的 `dsh.bundle.patch` 声明，loader 会自动把 `session-delete` 条目插进 profile 树，**无需手工改 `cordis.yml`**。

## 3. 生效与验证

宿主半要等 DSH 重新组合 profile 树：

1. **重启 DeepSeek Harness**（`desktop` profile 由 Electron 独占，`dsh --profile desktop --dump-config` 会被拒绝，因此无法在不重启的情况下验证树）。
2. 重启后自检：侧边栏 → 任一对话 → 「⋯」→ 应看到最下方的 **删除对话**。
   - 建议先拿一条不重要的对话试（或新建一条、发一句话、再删掉它）。
   - 客户端半由 `/plugins` 惰性装载，若宿主已加载而菜单没出现，刷新一次 GUI 页面即可。

## 4. 回滚

```powershell
# 方式一：脚本反做（移除 link 依赖与 bundle 条目）
node D:\deepseek\dsh-session-delete\scripts\install-profile.mjs --revert 'C:\Users\Lenovo\.dsh\profiles\desktop'
node <runtime>\node.exe <runtime>\pnpm\bin\pnpm.mjs --dir 'C:\Users\Lenovo\.dsh\profiles\desktop' install

# 方式二：直接还原备份（最保险）
Copy-Item 'D:\deepseek\backup\profile-desktop-package.json' 'C:\Users\Lenovo\.dsh\profiles\desktop\package.json' -Force
node <runtime>\node.exe <runtime>\pnpm\bin\pnpm.mjs --dir 'C:\Users\Lenovo\.dsh\profiles\desktop' install
```

两种方式之后都**重启 DeepSeek Harness**。插件源码目录 `D:\deepseek\dsh-session-delete` 可以随时删除；本插件没有改动 DSH 内核、`node_modules` 里的任何第三方包或 `cordis.yml`。

---

## 5. 它到底删了什么

一条已持久化的会话 = DSH home 下的一个目录：

```
<DSH_HOME>\sessions\<projectKey(cwd)>\<encodeSegment(sessionId)>\
    session.jsonl.zstd          旧格式世代
    session.v3.jsonl.zstd       旧格式世代
    session.v4.jsonl.zstd       当前格式世代
```

删除 = **整目录 `rm -r`**。只删当前代际会让旧代际在下次启动时被重新发现，所以必须整目录。

删完之后：

| 组件 | 行为 |
|---|---|
| `sessionPersistence.list()` | 每次调用重新扫描磁盘 → 立即不再返回该会话 |
| `sessionQuery`（SQLite 索引） | 本 profile 的索引根本没打开（`path: ':memory:'` + `openAt: never`，磁盘上零 `.db`）；即便启用，`_reconcile` 也会把 `persisted_sessions` 里消失的行删掉 |
| workspace registry 的 `sessionIds` | 读取时按 `sessionPath(id) === path` 过滤，重启后 stale id 自然消失 |
| 侧边栏那一行 | 由宿主 `ctx.emit('api-session/removed', id)` 立即移除 |
| 附件 | **不删**（内容寻址、跨会话共享，删了会伤到别的会话） |

## 6. 安全边界

- **id 白名单**：只接受"安全的单段目录名"（`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`，且不含 `..`）。既覆盖 `session-<uuid>`，也覆盖子会话的纯 UUID 形态，同时禁止任何穿越。
- **路径围栏**：目标必须是 `<root>/<project>/<sessionId>`，`path.resolve` 后仍须是该项目目录的**直属子项**且位于 sessions 根之内，否则跳过。
- **只删会话**：不碰项目目录本身、不碰同级其它会话、不碰根外同名目录（有测试覆盖）。
- **运行中保护**：宿主侧 `agents.get(id)?.status === 'running'` → 409，不删。
- **删除前静默**：对仍在内存里的空闲会话先 `sessions.flush()`，再 `liveEntryFor()` + `detachEntered()`（内核自己的顺序），全部防御性调用。
- **删后复核**：删完再扫一次，仍存在则如实报 500（`incomplete`），不谎报成功。
- **只服务本机 UI**：Host 必须 loopback，且 `Sec-Fetch-Site` 不得是跨站（防 DNS rebinding / 跨站删除）。
- **不碰内核**：无 `node_modules` 补丁、无 `cordis.yml` 改动，卸载即彻底还原。

## 7. 源码地图

| 文件 | 职责 |
|---|---|
| [`lib/delete-core.js`](lib/delete-core.js) | 纯逻辑：id 校验、目录定位、整目录删除（无 Cordis、无 HTTP） |
| [`lib/index.js`](lib/index.js) | 宿主半：`POST /session-delete/api/delete` + 信任校验 + 运行中保护 + flush/detach + 删后复核 + `api-session/removed` |
| [`lib/client.js`](lib/client.js) | 客户端半：手写 bundle，注册菜单行 + 确认对话框 + 删除调用 |
| [`cordis.patch.yml`](cordis.patch.yml) | 把自己插进 profile 树 |
| [`scripts/install-profile.mjs`](scripts/install-profile.mjs) | 接线 / `--revert` 反接线 |
| [`test/delete-core.test.mjs`](test/delete-core.test.mjs) | 19 项：id 校验 / 定位 / 删除 / 围栏 |
| [`test/host-route.test.mjs`](test/host-route.test.mjs) | 26 项：路由守卫 / 运行中保护 / 广播 / 纯 UUID id / live 空闲会话 |
| [`test/client-bundle.test.mjs`](test/client-bundle.test.mjs) | 25 项：bundle 协议 / 两个 slot 注册 / 字典完整性 |

```powershell
cd D:\deepseek\dsh-session-delete
node test/delete-core.test.mjs
node test/host-route.test.mjs
node test/client-bundle.test.mjs
```

## 8. 依赖的宿主契约（0.2.0-rc.2 实测）

- Slot `sidebar.workspaces.session.menu.item`（list，scope root）：`id` / `order` / `locale`；owner props 为 `{ sessionId, displayTitle }`，并注入 `useMenuOpenState`、`shortcuts` 钩子。
- Slot `shell.overlay`（list，scope root）：承载确认对话框。
- 客户端服务：`ctx.slots`、`ctx.locale`；宿主服务：`ctx.webServer`、`ctx.agents`、`ctx.sessions`。
- 客户端 bundle 只 require 基座模块（React、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`）。
- `package.json` 的 `dsh.client = { platform: 'web', inject: [...] }`；bundle 的 `window.__ModuleLoader__.load({ id })` 必须等于包名。

## 9. 已知限制

- 删除**不进回收站**，确认后无法恢复（这是你选的语义）。
- **工作区记账会残留一个 id**：`workspace.json` 里 `archivedSessionIds` / `sessionIds` 的该项不会被本插件重写（直接写内核存储域要踩 `validateStoredState` 不变式，代价大于收益）。后果：侧边栏不显示它；已被归档过的会话可能在归档视图里留下一条点不开的幽灵行；重启后 `sessionPath` 过滤会把它清掉。
- 投影缓存 `~/.dsh/storages/session_projcache/sessions/<id>.json` 会残留（内核没有删除 API，且该行有 lifecycle-identity 守卫，不会误命中，只占几十 KB）。
- 若该会话在**别处仍被打开**（例如另一个 DSH 进程持有日志句柄），Windows 上 `rm` 可能失败：此时接口返回 500 且目录未被部分提交的假象掩盖——按提示重试即可。
- 菜单行对「运行中」的对话不做置灰，而是点击确认后由宿主拒绝并给出原因。
