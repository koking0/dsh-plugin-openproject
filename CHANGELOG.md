# Changelog

本文件的格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-10-12

### 新增

- **多实例支持**：同一个 profile 可以同时接入多个 OpenProject（例如「实验室」与
  「团队 B」），在 profile 补丁里用不同的 `id` 插入多条本插件即可。新增两个配置项：
  - `toolPrefix`：工具名前缀（如 `lab_`），本实例的 `openproject_list_projects` 会注册成
    `lab_list_projects`，从而与其它实例共存；填 `lab` 会自动补成 `lab_`，形状非法时
    **直接报错**（静默忽略会导致同名工具互相覆盖，比加载失败更难排查）。
  - `label`：实例名称（如「实验室」），出现在系统提示词与每个工具描述的前缀里
    （`[实验室] 列出……`），让模型按用户提到的组织选对实例。实例地址是 IP 或域名时，
    模型光看地址认不出是哪个组织，建议配合 `label` 使用。
- `openproject_whoami` 在配置了 `label` / `toolPrefix` 时会一并回显，便于人工确认
  当前打到的是哪个实例。
- 每个实例的 `readOnly` / `writeProjects` / `requireConfirmForWrites` / Token 来源
  （`token` / `tokenFile` / `credentialRef`）独立生效。

### 兼容性

- 未配置 `label` / `toolPrefix` 时行为与 1.0.0 完全一致：工具名仍是 `openproject_*`，
  系统提示词区块名仍是 `plugin:openproject`。单实例用法无需改动任何配置。

### 实现说明

- 前缀在**注册边界**上逐条改写工具定义（`instanceContext()`），因此没有改动
  `lib/tools/*` 里的 35 处注册调用，工具模块保持原样。
- 已发布包的模块只会求值一次、多个实例**共享同一个 ESM 模块**，所以前缀刻意不放在
  模块级变量里（会互相串台），而是通过包装后的上下文逐实例传递。
- 系统提示词区块名按前缀区分（`plugin:openproject:<前缀>`）：区块名相同时，后注册的
  实例会覆盖前一个的文案，导致模型只看到其中一个实例。
- 工具模块只用到 `ctx.tools.register`，因此包装后的上下文用原型链转发其余属性，
  将来若工具模块需要 `ctx` 上的其它能力也不会失效。

## [1.0.0] - 2026-10-07

首个公开发布版本。

### 新增

- 36 个中文工具，覆盖四大能力域：
  - **项目与工作包**：列表、详情、创建（含子任务）、更新（含状态流转）、删除、评论、活动流、状态/类型/优先级字典、可指派成员
  - **工时**：查询、登记、修改、删除、活动类型字典、按成员/活动/项目/工作包聚合的统计报表
  - **成员与版本**：成员关系增删改、角色字典、用户检索、版本/里程碑增删改
  - **附件**：上传、列表、下载、删除
- `openproject_whoami` 连接自检工具。
- 把名字解析交给服务端：项目、状态、类型、负责人、版本等参数可直接传人类可读名称，歧义时返回候选列表。
- 三层写入保护：`readOnly` 全局只读 → `writeProjects` 项目白名单 → 删除类操作强制 `confirm: true`。
- `dryRun` 干运行：创建工作包/修改工作包可先经服务端表单端点预览将要提交的内容。
- 自动携带 `lockVersion`，并发修改会得到明确冲突提示而非静默覆盖。
- `suppressNotifications` / `notify: false`：批量操作不发通知邮件。

### 配置方式

- **不预设任何实例地址**，由使用方配置，避免把具体部署信息带进公开包：
  - 环境变量：`OPENPROJECT_BASE_URL`、`OPENPROJECT_API_TOKEN`、`OPENPROJECT_TOKEN_FILE`、`OPENPROJECT_REJECT_UNAUTHORIZED`
  - 或 profile 补丁里的 `config.baseUrl` 等字段
- Token 读取顺序：`config.token` → `config.tokenFile` → DSH 凭据服务 → 环境变量；
  每次调用重新读取，轮换后无需重启。
- 未配置实例地址时，工具会返回可操作的引导文案，而不是底层 URL 解析错误。

### 设计与实现说明

- **零运行时依赖**：不使用任何第三方库，HTTP 走 `node:https`，因此可以精确控制自签名证书策略。
- **不导出 `Config` schema**：避免依赖 DSH 内部包而把插件绑定到特定 DSH 版本；
  配置校验与默认值在 `normalizeConfig()` 中完成。
- **可移植默认值**：Token 文件默认推导为 `$DSH_HOME/openproject.token`，换电脑无需改配置。

### 已实测确认的实例特性

- 时间记录筛选工作包的筛选器字段名是 `entity`（不是 `workPackage`）。
- 工作包 `PATCH` 必须携带 `lockVersion`，否则一律返回 `409 UpdateConflict`。
- `/form` 端点不校验全部必填项，`dryRun` 只作预览。
- 时长的 ISO 8601 中 `1 天` 按实例的「每天工时」折算。
- 类型上的 `isDefault` 表示「通用类型」而非「项目默认类型」。
- 父级为自动排程时，新建子任务会被自动补出截止日期。
