# @liu_zhao_feng_alex/dsh-plugin-openproject

把 **OpenProject** 接进 [DeepSeek Harness](https://www.deepseek.com/)（DSH）的原生插件：
36 个中文工具，让你直接**用对话管理项目、工作包、工时、成员、版本与附件**。

- 🧩 **原生 DSH 插件** —— 不是 MCP 转发，工具直接注册进 DSH 工具表
- 📦 **零运行时依赖** —— 只用 Node 内置模块，HTTP 走 `node:https`，可精确控制自签名证书
- 🀄 **全中文工具与输出** —— 工具名、描述、渲染结果都按 OpenProject 中文界面术语对齐
- 🧠 **服务端名字解析** —— 项目名、状态名、负责人姓名、版本名都可直接传，歧义时返回候选
- 🛡️ **三层写入保护** —— 全局只读 → 项目白名单 → 删除强制二次确认
- 🔍 **先预览后写入** —— 创建工作包/修改工作包支持 `dryRun`，先看服务端校验结果

> 本插件**不预设任何 OpenProject 实例地址**，适用于任意自建或云端部署，装好后按下方
> 「配置」一节填上你自己的地址与 Token 即可。

> 为什么不用官方 MCP？OpenProject 官方 MCP 是 Enterprise 付费功能，Community Edition 上
> `/mcp` 会返回 `MCP server is not available.`。社区 MCP 服务器（如 `openproject-ce-mcp`）
> 虽可复用，但工具名为英文、数量上百、且需额外引入 Python 运行时。

---

## 安装

### 1. 让 DSH 的 Agent 装（最省事）

对 DSH 说一句：

> 帮我安装插件 `@liu_zhao_feng_alex/dsh-plugin-openproject`

Agent 会调用 `plugin_manager` 的 `install_bundle` 完成安装与注册。

### 2. 图形界面

**设置 → 插件**（Settings → Plugins）里搜索并安装 `@liu_zhao_feng_alex/dsh-plugin-openproject`。

### 3. 命令行

```bash
# 装进你的 profile（把 web 换成你实际使用的 profile 名）
dsh plugin --profile web add @liu_zhao_feng_alex/dsh-plugin-openproject
```

装完重启 DSH（或重载插件），然后**必须做下面的配置**，否则工具会提示未配置实例地址。

---

# 配置

## 第一步：拿到 API Token

在 OpenProject 里：**我的账号 → 访问令牌 → 新建**，复制生成的 token。

## 第二步：告诉插件连哪个实例

**插件不预设实例地址，必须由你配置。** 下面两种方式任选一种即可。

### 方式 A：环境变量（推荐，跨机器最省事）

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `OPENPROJECT_BASE_URL` | ✅ | 你的 OpenProject 地址，例如 `https://openproject.example.com`（结尾不要带 `/`） |
| `OPENPROJECT_API_TOKEN` | ✅ | 上一步拿到的 API Token |
| `OPENPROJECT_TOKEN_FILE` | — | 改用文件存放 Token 时指定路径（覆盖默认位置） |
| `OPENPROJECT_REJECT_UNAUTHORIZED` | — | `true` 时校验证书；**自签名证书的实例用 `false`（默认即 false）** |

各系统写法：

```powershell
# Windows PowerShell（仅当前会话）
$env:OPENPROJECT_BASE_URL = 'https://openproject.example.com'
$env:OPENPROJECT_API_TOKEN = 'opapi-xxxxxxxx'

# Windows 永久生效（新开终端后有效）
setx OPENPROJECT_BASE_URL "https://openproject.example.com"
setx OPENPROJECT_API_TOKEN "opapi-xxxxxxxx"
```

```bash
# macOS / Linux
export OPENPROJECT_BASE_URL='https://openproject.example.com'
export OPENPROJECT_API_TOKEN='opapi-xxxxxxxx'
```

也可以用 `.env` 文件（DSH 会读取 `$DSH_HOME/.env` 与项目根目录的 `.env`）：

```dotenv
OPENPROJECT_BASE_URL=https://openproject.example.com
OPENPROJECT_API_TOKEN=opapi-xxxxxxxx
```

> 环境变量只在**你没有在配置里显式写该字段**时生效，因此不会被旧配置意外覆盖。

### 方式 B：profile 配置（不想用环境变量时）

在**你自己 profile 的 `cordis.patch.yml`** 里追加：

```yaml
- id: openproject
  name: "@liu_zhao_feng_alex/dsh-plugin-openproject"
  config:
    baseUrl: 'https://openproject.example.com'
    # 自签名证书实例保持 false；有受信任证书时改为 true
    rejectUnauthorized: false
    # Token 也可以直接读文件（每次调用重新读取，便于轮换）
    tokenFile: '/home/you/.dsh/openproject.token'
    # 凭据服务中的引用名（默认值）
    credentialRef: 'OPENPROJECT_API_TOKEN'
    readOnly: false
    # 只想允许在特定项目里写入时，填项目标识或 ID
    writeProjects: []
```

> ⚠️ profile 补丁层会**整体替换** `config`（不是深合并），所以要把需要保留的字段一并写全。

### 方式 C：DSH 凭据服务

在 DSH 的凭据设置里保存一个名为 `OPENPROJECT_API_TOKEN` 的密钥即可，
插件会通过 `credentialRef` 自动读取，无需落明文文件。

### Token 的读取顺序

`config.token` → `config.tokenFile` → DSH 凭据服务 → 环境变量。
**每次调用都会重新读取**，所以轮换 Token 后无需重启 DSH。

### 配置项一览

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | **（空，必填）** | OpenProject 实例地址；也可由 `OPENPROJECT_BASE_URL` 提供 |
| `token` | — | 直接给出 Token（不建议，容易进版本库） |
| `tokenFile` | `$DSH_HOME/openproject.token` | Token 文件路径，按本机主目录自动推导 |
| `credentialRef` | `OPENPROJECT_API_TOKEN` | DSH 凭据服务中的引用名 |
| `rejectUnauthorized` | `false` | 是否校验 TLS 证书 |
| `requestTimeoutMs` | `30000` | 单次请求超时 |
| `defaultPageSize` / `maxPageSize` | `25` / `100` | 分页大小 |
| `hoursPerDay` | `8` | 解析 ISO 8601 时长时 `1 天` 折算的小时数 |
| `readOnly` | `false` | 全局只读开关，开启后拒绝一切写入 |
| `requireConfirmForWrites` | `false` | 为 `true` 时所有写入都要求 `confirm: true` |
| `suppressNotifications` | `false` | 为 `true` 时工作包写入默认不发通知邮件 |
| `writeProjects` | `[]` | 写入白名单（项目 ID/标识/名称），为空表示不限制 |

## 第三步：验证

对 DSH 说「**检查一下 OpenProject 连接**」，它会调用 `openproject_whoami`，
正常会返回你的账号名与实例地址：

```
已连接 OpenProject：https://openproject.example.com
当前账号：#12 张三（zhangsan） · 管理员
写入状态：允许写入
```

---

## 工具清单（36 个）

**连接与项目**
`openproject_whoami` · `openproject_list_projects` · `openproject_get_project` ·
`openproject_create_project` · `openproject_update_project`

**工作包**
`openproject_list_work_packages` · `openproject_get_work_package` ·
`openproject_create_work_package` · `openproject_update_work_package` ·
`openproject_delete_work_package` · `openproject_add_work_package_comment` ·
`openproject_list_work_package_comments` · `openproject_list_work_package_statuses` ·
`openproject_list_work_package_types` · `openproject_list_priorities` ·
`openproject_list_assignable_users`

**工时**
`openproject_list_time_entries` · `openproject_log_time` · `openproject_update_time_entry` ·
`openproject_delete_time_entry` · `openproject_list_time_activities` · `openproject_time_report`

**成员、角色与版本**
`openproject_list_memberships` · `openproject_add_membership` ·
`openproject_update_membership` · `openproject_delete_membership` · `openproject_list_roles` ·
`openproject_list_users` · `openproject_list_versions` · `openproject_create_version` ·
`openproject_update_version` · `openproject_delete_version`

**附件**
`openproject_upload_attachment` · `openproject_list_attachments` ·
`openproject_download_attachment` · `openproject_delete_attachment`

---

## 用法示例

直接说人话即可，插件负责把自然语言翻译成 OpenProject API 调用：

- 「列出我负责的、还没关闭的工作包」
- 「在实验室官网项目下建一个任务，标题叫 X，负责人是 Y」
- 「把 #123 的状态改成已关闭，说明一下原因」
- 「统计 9 月各成员在这个项目上的工时」
- 「看一下 #456 的评论和变更记录」
- 「把这个文件传到 #789 上」

---

## 设计要点

- **名字解析**：所有引用类参数都接受人类可读名称，插件在服务端解析；
  出现歧义时返回候选列表而不是猜。
- **先读后写**：字典类工具（状态、类型、优先级、角色、活动类型）让模型先取真实取值。
- **干运行**：给创建工作包/修改工作包传 `dryRun: true`，经服务端表单端点校验并回显将提交的内容。
- **乐观锁**：更新工作包时自动带上刚读到的 `lockVersion`；期间若有人改过会返回明确的冲突提示。
- **零依赖**：不 import 任何 DSH 内部包，因此不绑定具体 DSH 版本，也不受包管理器
  模块解析方式影响。

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 「未配置 OpenProject 实例地址」 | 按上方「配置 → 第二步」设置 `OPENPROJECT_BASE_URL` 或 profile 的 `baseUrl` |
| 「未配置 OpenProject API Token」 | 设置 `OPENPROJECT_API_TOKEN`，或写入 `$DSH_HOME/openproject.token`，或用凭据服务 |
| 连接失败 / 证书被拒 | 自签名证书实例需 `rejectUnauthorized: false`（或 `OPENPROJECT_REJECT_UNAUTHORIZED=false`） |
| 401 / 403 | Token 失效或无权限，重新生成 Token |
| 更新返回 409 冲突 | 有人在你读取之后改过该工作包，重新读取后再改（插件已内置该提示） |

## 已知的 OpenProject 行为（实测）

这些是写插件时踩过的坑，供二次开发参考：

1. **时间记录筛选工作包用 `entity`** 而不是 `workPackage`（后者报「筛选器不存在」）；
   但资源链接里两者同时存在。
2. **工作包 `PATCH` 必须携带 `lockVersion`**，否则一律返回 `409 UpdateConflict`。
3. **`/form` 端点不校验全部必填项**，因此 `dryRun` 只作预览；插件已在客户端补上必填校验。
4. **`hours` 是 ISO 8601 duration**，且 `1 天` 按实例的 `hoursPerDay` 折算。
5. **类型上的 `isDefault` 表示「通用类型」而非「项目默认类型」**。
6. **父级为自动排程时，新建子任务会被自动补出截止日期**。

---

## 开发

```bash
git clone https://github.com/koking0/dsh-plugin-openproject.git
cd dsh-plugin-openproject
# 无需安装依赖：本插件零运行时依赖
node --check index.js    # 语法检查
npm pack --dry-run       # 查看将发布的文件清单
```

目录结构：

```
index.js              插件入口：配置归一化、Token 解析、工具注册、系统提示词区块
cordis.patch.yml      bundle 补丁：向 profile 插入一条 Host 插件行
lib/http.js           零依赖 HTTP 客户端（node:http/node:https、multipart、下载）
lib/api.js            OpenProject API 层：鉴权、分页、HAL、名字解析、字典缓存
lib/guard.js          写入保护
lib/format.js         面向模型的紧凑中文渲染
lib/tools/*.js        按能力域拆分的工具定义（含内联的 defineTool 实现）
```

发布新版本：改 `package.json` 的 `version` 与 `CHANGELOG.md`，然后

```bash
npm publish --access public
# 或打 tag 由 GitHub Actions 自动发布：git tag v1.0.1 && git push origin v1.0.1
```

## 许可

[MIT](LICENSE)
