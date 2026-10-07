# Changelog

本文件的格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
