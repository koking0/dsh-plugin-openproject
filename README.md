# dsh-plugin-openproject

> npm 包名：`@koking0/dsh-plugin-openproject`

把 **OpenProject** 接进 [DeepSeek Harness](https://www.deepseek.com/)（DSH）的原生插件：
36 个中文工具，让你直接**用对话管理项目、工作包、工时、成员、版本与附件**。

- 🧩 **原生 DSH 插件** —— 不是 MCP 转发，工具直接注册进 DSH 工具表
- 📦 **零运行时依赖** —— 只用 Node 内置模块，HTTP 走 `node:https`，可精确控制自签名证书
- 🀄 **全中文工具与输出** —— 工具名、描述、渲染结果都按 OpenProject 中文界面术语对齐
- 🧠 **服务端名字解析** —— 项目名、状态名、负责人姓名、版本名都可直接传，歧义时返回候选
- 🛡️ **三层写入保护** —— 全局只读 → 项目白名单 → 删除强制二次确认
- 🔍 **先预览后写入** —— 创建工作包/修改工作包支持 `dryRun`，先看服务端校验结果

> 为什么不用官方 MCP？OpenProject 官方 MCP 是 Enterprise 付费功能，Community Edition 上
> `/mcp` 会返回 `MCP server is not available.`。社区 MCP 服务器（如 `openproject-ce-mcp`）
> 虽可复用，但工具名为英文、数量上百、且需额外引入 Python 运行时。

---

## 安装

在目标电脑上，任选一种方式：

### 1. 让 DSH 的 Agent 装（最省事）

对 DSH 说一句：

> 帮我安装插件 `@koking0/dsh-plugin-openproject`

Agent 会调用 `plugin_manager` 的 `install_bundle` 完成安装与注册。

### 2. 图形界面

**设置 → 插件**（Settings → Plugins）里搜索并安装 `@koking0/dsh-plugin-openproject`。

### 3. 命令行

```bash
# 装进你的 profile（把 web 换成你实际使用的 profile 名）
dsh plugin --profile web add @koking0/dsh-plugin-openproject
```

安装后重启 DSH（或重载插件），对 DSH 说「**检查一下 OpenProject 连接**」，
它会调用 `openproject_whoami` 自检。

---

## 配置

### 第一步：准备 API Token（每人一份）

在 OpenProject 里：**我的账号 → 访问令牌 → 新建**，复制生成的 token。

然后三选一（按优先级从高到低）：

| 方式 | 做法 | 适用场景 |
|---|---|---|
| **凭据服务**（推荐） | 在 DSH 的凭据设置里保存名为 `OPENPROJECT_API_TOKEN` 的密钥 | 图形化、不落明文文件 |
| **Token 文件** | 把 token 写入 `$DSH_HOME/openproject.token`（Windows 通常是 `C:\Users\<你>\.dsh\openproject.token`） | 便于脚本轮换 |
| **环境变量** | 设置 `OPENPROJECT_API_TOKEN` | CI / 容器 |

> Token 会在**每次调用时重新读取**，所以轮换后无需重启 DSH。

### 第二步：按需覆盖默认配置

插件默认指向 Matrix 工作室的 OpenProject 实例，通常只需配 Token 即可。
要换实例或调整行为，在**你自己 profile 的 `cordis.patch.yml`** 里追加：

```yaml
- id: openproject
  name: "@koking0/dsh-plugin-openproject"
  config:
    baseUrl: 'https://your-openproject.example.com'
    rejectUnauthorized: true     # 实例使用受信任证书时打开校验
    readOnly: false
    writeProjects: []            # 填项目标识可把写入限制在指定项目
```

> 注意：profile 补丁层会**整体替换** `config`，不是深合并，所以要把需要保留的字段一并写全。

### 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `https://106.55.103.208:22560` | OpenProject 实例地址，也可用环境变量 `OPENPROJECT_BASE_URL` 指定 |
| `token` | — | 直接给出 Token（仅建议临时使用） |
| `tokenFile` | `$DSH_HOME/openproject.token` | Token 文件路径，自动按本机主目录推导 |
| `credentialRef` | `OPENPROJECT_API_TOKEN` | DSH 凭据服务中的引用名 |
| `rejectUnauthorized` | `false` | 是否校验 TLS 证书；自签名实例保持 `false` |
| `requestTimeoutMs` | `30000` | 单次请求超时 |
| `defaultPageSize` / `maxPageSize` | `25` / `100` | 分页大小 |
| `hoursPerDay` | `8` | 解析 ISO 8601 时长时 `P1D` 折算的小时数 |
| `readOnly` | `false` | 全局只读开关，开启后拒绝一切写入 |
| `requireConfirmForWrites` | `false` | 为 `true` 时所有写入都要求 `confirm: true` |
| `suppressNotifications` | `false` | 为 `true` 时工作包写入默认不发通知邮件 |
| `writeProjects` | `[]` | 写入白名单（项目 ID/标识/名称），为空表示不限制 |

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
- **零依赖**：不 import 任何 `@deepseek-ai/*` 包，因此不绑定具体 DSH 版本，也不受
  包管理器的模块解析方式影响。

---

## 已知的 OpenProject 实例行为

以下都是实测确认、写插件时最容易踩的点，记录下来备查：

1. **时间记录筛选工作包用 `entity`**，不是 `workPackage`（后者报「筛选器不存在」）。
   但资源链接里两者同时存在。
2. **工作包 `PATCH` 必须携带 `lockVersion`**，否则一律返回 `409 UpdateConflict`。
3. **`/form` 端点不校验全部必填项**：空标题在表单端点无报错，因此 `dryRun` 只作预览，
   不能当作「一定可创建」的保证；插件已在客户端补上必填校验。
4. **`hours` 是 ISO 8601 duration**，且 `P1D` 按实例的 `hoursPerDay` 折算。
5. **类型上的 `isDefault` 表示「通用类型」而非「项目默认类型」**，展示时不予采用。
6. **父级为自动排程时，新建子任务会被自动补出截止日期**。

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 「未配置 OpenProject API Token」 | 按上文任选一种方式提供 Token；也可先调用 `openproject_whoami` 确认 |
| 连接失败 / 自签名证书被拒 | 确认 `rejectUnauthorized: false`，或为该实例安装受信任证书 |
| `failed to import` | 插件以链接方式安装且宿主环境无法解析 `@deepseek-ai/*` 时会出现；本插件零依赖，正常安装不会触发 |
| 401 / 403 | Token 失效或无权限，重新生成 Token |
| 更新返回 409 冲突 | 有人在你读取之后改过该工作包，重新读取后再改（插件已内置该提示） |

---

## 开发

```bash
git clone <repo> && cd dsh-openproject-plugin
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

## 许可

[MIT](LICENSE)
