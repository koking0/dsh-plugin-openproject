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
  baseUrl: 'https://106.55.103.208:22560',
  /** 直接给出 Token（仅建议临时使用）。 */
  token: '',
  /** 从一个独立文件读取 Token；每次调用重新读取，便于轮换且不必重启。 */
  tokenFile: '',
  /** 交由 DSH 凭据服务解析的引用名。 */
  credentialRef: 'OPENPROJECT_API_TOKEN',
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
  for (const key of ['baseUrl', 'token', 'tokenFile', 'credentialRef']) {
    if (typeof merged[key] !== 'string') merged[key] = DEFAULT_CONFIG[key];
  }
  // 便携默认值：Token 文件放在本机 DSH 主目录下，换电脑无需改配置。
  if (merged.tokenFile.trim() === '') merged.tokenFile = defaultTokenFile();
  // 允许用环境变量指定实例地址，便于在多个 OpenProject 环境间切换或在 CI 中使用。
  if (merged.baseUrl.trim() === '' && typeof process.env.OPENPROJECT_BASE_URL === 'string') {
    merged.baseUrl = process.env.OPENPROJECT_BASE_URL.trim();
  }
  return merged;
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

  registerProjectTools(ctx, deps);
  registerWorkPackageTools(ctx, deps);
  registerTimeTools(ctx, deps);
  registerMemberTools(ctx, deps);
  registerAttachmentTools(ctx, deps);

  ctx.tools.register(textTool({
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
        `已连接 OpenProject：${config.baseUrl}`,
        `当前账号：#${me.id} ${me.name}（${me.login}）${me.admin ? ' · 管理员' : ''}`,
        `实例设置：每天 ${config.hoursPerDay} 小时、每周起始日 ${response.startOfWeek ?? '未设置'}`,
        `写入状态：${guard.readOnly ? '只读模式（config.readOnly = true）' : '允许写入'}`,
        `目标时区：${response.userDefaultTimezone ?? '未设置'}`,
      ];
      return {
        text: lines.join('\n'),
        data: {
          baseUrl: config.baseUrl,
          user: { id: me.id, name: me.name, login: me.login, admin: me.admin === true },
          readOnly: guard.readOnly,
          hoursPerDay: config.hoursPerDay,
        },
      };
    },
  }));

  ctx.systemPrompt.section({
    name: 'plugin:openproject',
    order: PROMPT_SECTION_ORDER,
    text: () => {
      const mode = guard.readOnly
        ? '当前为只读模式，写入类工具会直接拒绝。'
        : '写入类工具可用；删除类操作必须显式传 confirm: true。';
      return [
        '## OpenProject 项目管理',
        `已接入 OpenProject 实例 ${config.baseUrl}，工具名以 openproject_ 开头。`,
        '用它们管理项目、工作包（任务/缺陷/里程碑）、工时、成员角色、版本与附件。',
        '引用资源时可以直接使用人类可读的名字（项目名、状态名、负责人姓名、版本名），插件会在服务端解析；'
        + '解析出现歧义时工具会返回候选列表。',
        '先读后写：不确定状态、类型或成员时，先用对应的 list 工具获取字典，再执行写入。',
        '写入前如需预览，可给创建工作包/修改工作包传 dryRun: true，让服务端校验而不落库。',
        mode,
      ].join(' ');
    },
  });

  logger?.info?.('[openproject] 插件已激活', {
    baseUrl: config.baseUrl,
    readOnly: guard.readOnly,
    writeProjects: config.writeProjects,
  });
}
