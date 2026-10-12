/**
 * OpenProject 插件入口。
 *
 * 通过 OpenProject API v3 把项目、工作包、工时、成员/角色/版本与附件封装成 DSH 原生
 * 工具。不依赖任何第三方运行时库：HTTP 走 `node:https`，因此可以精确控制自签名
 * 证书策略，也不需要 Python/Node 中间服务。
 *
 * @module dsh-plugin-openproject
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createApi } from './lib/api.js';
import { createGuard } from './lib/guard.js';
import { textTool } from './lib/tools/common.js';
import { registerProjectTools } from './lib/tools/projects.js';
import { registerWorkPackageTools } from './lib/tools/work-packages.js';
import { registerTimeTools } from './lib/tools/time.js';
import { registerMemberTools } from './lib/tools/members.js';
import { registerAttachmentTools } from './lib/tools/attachments.js';

export const name = 'openproject';

/** 依赖工具注册表与系统提示词注册表（两者都由 dsh-base 提供）。 */
export const inject = ['tools', 'systemPrompt'];

/** 提示词区块的排序位；紧随 MCP 服务器区块（3100）之后。 */
const PROMPT_SECTION_ORDER = 3150;

/** 默认配置。 */
export const DEFAULT_CONFIG = {
  /**
   * OpenProject 实例地址。
   *
   * 刻意**不设默认值**：本插件面向任意 OpenProject 部署，实例地址由使用方自行配置
   * （环境变量 `OPENPROJECT_BASE_URL`，或 profile 补丁里的 `baseUrl`）。
   */
  baseUrl: '',
  /** 直接给出 Token（仅建议临时使用）。 */
  token: '',
  /** 从一个独立文件读取 Token；每次调用重新读取，便于轮换且不必重启。 */
  tokenFile: '',
  /** 交由 DSH 凭据服务解析的引用名。 */
  credentialRef: 'OPENPROJECT_API_TOKEN',
  /**
   * 实例名称（人类可读），例如「实验室」「速知启智」。
   *
   * 同一个 profile 接入多个实例时，它会出现在系统提示词和每个工具的描述前缀里
   * （如 `[实验室] 列出……`），让模型按用户提到的组织选对实例。
   */
  label: '',
  /**
   * 工具名前缀，例如 `lab_`：本实例的 `openproject_list_projects` 会注册成
   * `lab_list_projects`，从而在同一个 profile 里与其它实例共存。
   *
   * 未设置时保持原来的 `openproject_` 前缀（单实例用法完全不变）。
   */
  toolPrefix: '',
  /** 自签名证书实例需要设为 false。 */
  rejectUnauthorized: false,
  requestTimeoutMs: 30000,
  defaultPageSize: 25,
  maxPageSize: 100,
  /** 实例的「每天工时」，用于解析 ISO 8601 中的 `P1D`。 */
  hoursPerDay: 8,
  /** 全局只读开关。 */
  readOnly: false,
  /** 为 true 时所有写入都要求 confirm: true。 */
  requireConfirmForWrites: false,
  /** 为 true 时工作包写入默认不发通知邮件，避免批量操作打扰同事。 */
  suppressNotifications: false,
  /** 写入白名单：项目 ID、标识或名称；为空表示不限制。 */
  writeProjects: [],
};

/**
 * 推导 Token 文件的默认位置：`$DSH_HOME/openproject.token`（没有 DSH_HOME 时退回
 * `~/.dsh/openproject.token`）。
 *
 * 用本机主目录推导而不是写死绝对路径，这样在别的电脑上安装后无需修改任何配置——
 * 每位用户各自维护自己的一份 Token 文件。
 *
 * @returns {string} Token 文件的绝对路径。
 */
export function defaultTokenFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return join(home, 'openproject.token');
}

/**
 * 把 cordis.patch.yml 中的原始 config 归一化成完整配置。
 *
 * 本插件不导出 `Config` schema（那需要 `@deepseek-ai/schemastery`，会引入模块解析
 * 依赖，且把插件绑定到特定 DSH 版本），因此在这里做等价校验与默认值填充。
 *
 * @param {object} [raw] - 行配置。
 * @returns {object} 归一化后的配置。
 */
export function normalizeConfig(raw) {
  const merged = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  for (const key of ['requestTimeoutMs', 'defaultPageSize', 'maxPageSize', 'hoursPerDay']) {
    const value = Number(merged[key]);
    merged[key] = Number.isFinite(value) && value > 0 ? value : DEFAULT_CONFIG[key];
  }
  for (const key of ['rejectUnauthorized', 'readOnly', 'requireConfirmForWrites', 'suppressNotifications']) {
    merged[key] = merged[key] === true;
  }
  const allow = Array.isArray(merged.writeProjects) ? merged.writeProjects : [];
  merged.writeProjects = allow.map((value) => String(value).trim()).filter((value) => value.length > 0);
  for (const key of ['baseUrl', 'token', 'tokenFile', 'credentialRef', 'label', 'toolPrefix']) {
    if (typeof merged[key] !== 'string') merged[key] = DEFAULT_CONFIG[key];
  }
  // 工具名前缀需要补分隔符并校验形状：静默忽略会让多实例互相覆盖，比加载失败更难查。
  merged.toolPrefix = normalizeToolPrefix(merged.toolPrefix);

  /** 该字段是否由使用方显式配置（而非取默认值）。环境变量只在未显式配置时生效。 */
  const configured = (key) => raw !== null && raw !== undefined && Object.hasOwn(raw, key);

  // Token 文件：显式配置 > 环境变量 > 本机默认位置。
  if (merged.tokenFile.trim() === '') {
    const fromEnv = typeof process.env.OPENPROJECT_TOKEN_FILE === 'string'
      ? process.env.OPENPROJECT_TOKEN_FILE.trim()
      : '';
    merged.tokenFile = fromEnv !== '' ? fromEnv : defaultTokenFile();
  }

  // 实例地址：环境变量 OPENPROJECT_BASE_URL（未显式配置时生效）。
  if (merged.baseUrl.trim() === '' && typeof process.env.OPENPROJECT_BASE_URL === 'string') {
    merged.baseUrl = process.env.OPENPROJECT_BASE_URL.trim();
  }

  // 是否校验 TLS 证书：环境变量 OPENPROJECT_REJECT_UNAUTHORIZED（未显式配置时生效）。
  if (!configured('rejectUnauthorized') && typeof process.env.OPENPROJECT_REJECT_UNAUTHORIZED === 'string') {
    const flag = process.env.OPENPROJECT_REJECT_UNAUTHORIZED.trim().toLowerCase();
    if (flag !== '') merged.rejectUnauthorized = flag === 'true' || flag === '1' || flag === 'yes';
  }

  return merged;
}

/**
 * 规范化工具名前缀。
 *
 * 自动补上结尾的下划线（`lab` → `lab_`），这样 `lab_` + `openproject_list_projects`
 * 读起来自然。形状非法时**直接抛错**：静默忽略会让同 profile 里的多实例注册出同名
 * 工具而互相覆盖，那种故障比加载失败难排查得多。
 *
 * @param {string} value - 原始前缀。
 * @returns {string} 规范化后的前缀；未配置时返回空串。
 */
export function normalizeToolPrefix(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return '';
  const withSeparator = raw.endsWith('_') ? raw : `${raw}_`;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(withSeparator)) {
    throw new Error(
      `toolPrefix 非法：${JSON.stringify(raw)}；只允许字母、数字与下划线，且以字母开头（例如 "lab_"）。`,
    );
  }
  return withSeparator;
}

/**
 * 构造「带工具名前缀与实例标签」的插件上下文。
 *
 * 同一个 profile 里插入多条本插件（不同 id、不同 `toolPrefix`）即可同时接入多个
 * OpenProject 实例。已发布包的模块只会被求值一次，两个实例**共享同一个 ESM 模块**，
 * 所以前缀绝不能存放在模块级变量里（会互相串台）；这里改为在注册边界上逐条改写定义。
 *
 * 工具模块只用到 `ctx.tools.register`（共 35 处），因此用原型链转发其余属性即可，
 * 不必逐个改动工具模块。
 *
 * @param {object} ctx - 原始插件上下文。
 * @param {string} prefix - 已规范化的工具名前缀（可为空）。
 * @param {string} label - 实例名称（可为空）。
 * @returns {object} 供工具模块使用的上下文。
 */
function instanceContext(ctx, prefix, label) {
  if (!prefix && !label) return ctx;
  const tag = label ? `[${label}] ` : '';
  const tools = Object.create(ctx.tools, {
    register: {
      value: (definition) => ctx.tools.register({
        ...definition,
        ...(prefix ? { name: `${prefix}${definition.name}` } : {}),
        ...(tag ? { description: `${tag}${definition.description}` } : {}),
      }),
    },
  });
  return Object.create(ctx, { tools: { value: tools } });
}

/**
 * 注册 OpenProject 工具集。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} rawConfig - 行配置（未校验）。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger ?? undefined;

  /**
   * 解析 API Token。顺序：显式 token → tokenFile → DSH 凭据服务 → 进程环境变量。
   * 每次都重新解析，因此轮换 Token 后无需重启 Harness。
   * @returns {Promise<string|undefined>} Token。
   */
  async function resolveToken() {
    if (config.token) return config.token;
    if (config.tokenFile) {
      try {
        const text = (await readFile(config.tokenFile, 'utf8')).trim();
        if (text) return text;
      } catch (error) {
        logger?.debug?.('[openproject] 读取 tokenFile 失败', { tokenFile: config.tokenFile, message: error?.message });
      }
    }
    const credentials = ctx.get('credentials');
    if (credentials && config.credentialRef) {
      try {
        const resolved = await credentials.resolve(config.credentialRef);
        if (resolved?.value) return resolved.value;
      } catch (error) {
        logger?.debug?.('[openproject] 凭据服务解析失败', { ref: config.credentialRef, message: error?.message });
      }
    }
    if (config.credentialRef && process.env[config.credentialRef]) return process.env[config.credentialRef];
    return undefined;
  }

  const api = createApi({
    baseUrl: config.baseUrl,
    resolveToken,
    rejectUnauthorized: config.rejectUnauthorized,
    timeoutMs: Number(config.requestTimeoutMs) || 30000,
    defaultPageSize: Number(config.defaultPageSize) || 25,
    maxPageSize: Number(config.maxPageSize) || 100,
    hoursPerDay: Number(config.hoursPerDay) || 8,
    logger,
  });
  const guard = createGuard({ config });
  const deps = { api, guard, config, resolveToken };

  /**
   * 多实例：本实例的全部工具（含 whoami）都经由带前缀的上下文注册。
   * 未配置 `toolPrefix` / `label` 时 `instanceContext()` 原样返回 ctx，行为与 1.0.0 一致。
   */
  const toolCtx = instanceContext(ctx, config.toolPrefix, config.label);

  registerProjectTools(toolCtx, deps);
  registerWorkPackageTools(toolCtx, deps);
  registerTimeTools(toolCtx, deps);
  registerMemberTools(toolCtx, deps);
  registerAttachmentTools(toolCtx, deps);

  toolCtx.tools.register(textTool({
    name: 'openproject_whoami',
    description: '检查 OpenProject 连接是否正常，并返回当前 Token 对应的账号：用户 ID、姓名、登录名与是否为管理员。'
      + '在开始其它操作前可以用它确认连接与权限。',
    kind: 'read',
    title: '检查 OpenProject 连接',
    parameters: {},
    async run() {
      const response = await api.request.get('/api/v3/configuration');
      const me = await api.request.get('/api/v3/users/me');
      const lines = [
        `已连接 OpenProject${config.label ? `（${config.label}）` : ''}：${config.baseUrl}`,
        `当前账号：#${me.id} ${me.name}（${me.login}）${me.admin ? ' · 管理员' : ''}`,
        `实例设置：每天 ${config.hoursPerDay} 小时、每周起始日 ${response.startOfWeek ?? '未设置'}`,
        `写入状态：${guard.readOnly ? '只读模式（config.readOnly = true）' : '允许写入'}`,
        `目标时区：${response.userDefaultTimezone ?? '未设置'}`,
        ...(config.toolPrefix
          ? [`工具名前缀：${config.toolPrefix}（本实例工具名形如 ${config.toolPrefix}openproject_list_projects）`]
          : []),
      ];
      return {
        text: lines.join('\n'),
        data: {
          baseUrl: config.baseUrl,
          label: config.label || null,
          toolPrefix: config.toolPrefix || null,
          user: { id: me.id, name: me.name, login: me.login, admin: me.admin === true },
          readOnly: guard.readOnly,
          hoursPerDay: config.hoursPerDay,
        },
      };
    },
  }));

  /**
   * 每个实例注册自己的提示词区块，因此区块名必须唯一：区块名相同时后注册的实例会
   * 覆盖前一个的文案，导致模型只看到其中一个实例。
   *
   * 未配置 `toolPrefix` 时沿用 1.0.0 的 `plugin:openproject`，保持单实例行为不变。
   */
  const sectionName = config.toolPrefix
    ? `plugin:openproject:${config.toolPrefix.replace(/_+$/, '')}`
    : 'plugin:openproject';
  const toolNamePrefix = `${config.toolPrefix}openproject_`;
  ctx.systemPrompt.section({
    name: sectionName,
    order: PROMPT_SECTION_ORDER,
    text: () => {
      const mode = guard.readOnly
        ? '当前为只读模式，写入类工具会直接拒绝。'
        : '写入类工具可用；删除类操作必须显式传 confirm: true。';
      return [
        config.label ? `## OpenProject 项目管理（${config.label}）` : '## OpenProject 项目管理',
        `${config.label ? `本区块对应实例「${config.label}」，` : ''}已接入 OpenProject 实例 ${config.baseUrl}，`
        + `工具名以 ${toolNamePrefix} 开头。`,
        '用它们管理项目、工作包（任务/缺陷/里程碑）、工时、成员角色、版本与附件。',
        '引用资源时可以直接使用人类可读的名字（项目名、状态名、负责人姓名、版本名），插件会在服务端解析；'
        + '解析出现歧义时工具会返回候选列表。',
        '先读后写：不确定状态、类型或成员时，先用对应的 list 工具获取字典，再执行写入。',
        '写入前如需预览，可给创建工作包/修改工作包传 dryRun: true，让服务端校验而不落库。',
        ...(config.toolPrefix
          ? ['同时配置了多个 OpenProject 实例时，各实例的工具名前缀不同：请按用户提到的组织、公司或项目所属'
            + `选择对应前缀的工具（本实例为 ${toolNamePrefix}），不要跨实例混用，也不要把一个实例的工作包 ID 用到另一个实例。`]
          : []),
        mode,
      ].join(' ');
    },
  });

  logger?.info?.('[openproject] 插件已激活', {
    baseUrl: config.baseUrl,
    label: config.label,
    toolPrefix: config.toolPrefix,
    readOnly: guard.readOnly,
    writeProjects: config.writeProjects,
  });
}
