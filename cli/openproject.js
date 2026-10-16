/**
 * OpenProject 命令行工具（多实例）。
 *
 * 复用本包的零依赖 API 层（lib/api.js）与格式化函数，让任意 Agent / 脚本通过一条
 * 命令读写**一个或多个** OpenProject 实例——不装 DSH、不走 MCP 也能用。
 *
 * 用法：
 *   node cli/openproject.js <实例名> <命令> [--键=值 ...] [--json='{...}'] [--json-file=path]
 *   node cli/openproject.js instances                列出已配置的实例
 *   node cli/openproject.js help                     查看全部命令
 *
 * 中文参数在 Windows 控制台可能被转码，建议用 --json-file 传一个 UTF-8 的 JSON 文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApi, filter } from '../lib/api.js';
import {
  isoDurationFromHours,
  hoursFromDuration,
  hoursText,
  dateOnly,
  truncate,
} from '../lib/format.js';

// 抑制 Node 关闭证书校验时的告警噪声（仅在实例显式配置 rejectUnauthorized=false 时才会触发）。
process.env.NODE_NO_WARNINGS = process.env.NODE_NO_WARNINGS || '1';

/** 配置文件的查找顺序：`OPENPROJECT_CONFIG` → `~/.openproject/op.config.json` → 当前目录 `op.config.json`。 */
export function configPath() {
  const fromEnv = typeof process.env.OPENPROJECT_CONFIG === 'string'
    ? process.env.OPENPROJECT_CONFIG.trim()
    : '';
  if (fromEnv !== '') return path.resolve(fromEnv);
  const candidates = [
    path.join(homedir(), '.openproject', 'op.config.json'),
    path.join(process.cwd(), 'op.config.json'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? '';
}

/** 读取环境变量中的布尔值；未设置时返回 undefined。 */
function envFlag(name) {
  const raw = typeof process.env[name] === 'string' ? process.env[name].trim().toLowerCase() : '';
  if (raw === '') return undefined;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * 载入多实例配置。
 *
 * 没有配置文件时退回「环境变量单实例」，这样容器/CI 里只配一个实例也能直接用
 * （与本包的 DSH 插件、以及社区常见做法保持同一套变量名）。
 */
export function loadConfig() {
  const found = configPath();
  if (found !== '') {
    return JSON.parse(fs.readFileSync(found, 'utf8'));
  }
  const baseUrl = typeof process.env.OPENPROJECT_BASE_URL === 'string'
    ? process.env.OPENPROJECT_BASE_URL.trim()
    : '';
  const token = typeof process.env.OPENPROJECT_API_TOKEN === 'string'
    ? process.env.OPENPROJECT_API_TOKEN.trim()
    : '';
  if (baseUrl !== '' || token !== '') {
    return {
      default: 'default',
      instances: {
        default: {
          label: process.env.OPENPROJECT_LABEL || '',
          baseUrl,
          token,
          rejectUnauthorized: envFlag('OPENPROJECT_REJECT_UNAUTHORIZED') ?? false,
          timeoutMs: Number(process.env.OPENPROJECT_TIMEOUT_MS) || 30000,
          hoursPerDay: Number(process.env.OPENPROJECT_HOURS_PER_DAY) || 8,
        },
      },
    };
  }
  throw new Error(
    `未找到 OpenProject 配置。请任选其一：\n`
    + `  1) 把 op.config.example.json 复制到 ${path.join(homedir(), '.openproject', 'op.config.json')}（或当前目录 op.config.json）并填入实例地址与 Token；\n`
    + `  2) 用 OPENPROJECT_CONFIG 指向你的配置文件；\n`
    + `  3) 直接设环境变量 OPENPROJECT_BASE_URL 与 OPENPROJECT_API_TOKEN。`,
  );
}

function resolveInstance(config, name) {
  const instances = config.instances || {};
  const key = name || config.default || Object.keys(instances)[0];
  const inst = instances[key];
  if (!inst) {
    throw new Error(
      `未找到实例「${key}」。已配置：${Object.keys(instances).join('、') || '（空）'}`,
    );
  }
  return { key, ...inst };
}

function buildApi(inst) {
  return createApi({
    baseUrl: inst.baseUrl,
    resolveToken: async () => inst.token || process.env.OPENPROJECT_API_TOKEN || '',
    // 默认校验证书；自建实例用自签名证书时，在配置里把该实例的 rejectUnauthorized 设为 false。
    rejectUnauthorized: inst.rejectUnauthorized ?? true,
    timeoutMs: inst.timeoutMs ?? 30000,
    defaultPageSize: inst.defaultPageSize ?? 25,
    maxPageSize: inst.maxPageSize ?? 100,
    hoursPerDay: inst.hoursPerDay ?? 8,
  });
}

// ---------------------------------------------------------------- 参数解析

/** 解析命令行：--k=v、--k v、--flag、以及 --json / --json-file。 */
function parseArgs(argv) {
  const args = {};
  const flags = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    let key = body;
    let value;
    const eq = body.indexOf('=');
    if (eq !== -1) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    } else {
      flags.push(key);
      continue;
    }
    args[key] = value;
  }
  if (args['json-file']) {
    Object.assign(args, JSON.parse(fs.readFileSync(args['json-file'], 'utf8')));
    delete args['json-file'];
  }
  if (args.json) {
    Object.assign(args, JSON.parse(args.json));
    delete args.json;
  }
  return { args, flags };
}

function num(args, key, fallback) {
  const v = args[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------- 输出

const EMPTY = '（空）';

// 输出可被重定向到数组（供 MCP server 收集为文本结果）。
let sink = null;

function out(text) {
  if (sink) sink.push(String(text));
  else process.stdout.write(`${text}\n`);
}

function outJson(value) {
  const text = JSON.stringify(value, null, 2);
  if (sink) sink.push(text);
  else process.stdout.write(`${text}\n`);
}

/** 取 HAL 链接上的标题。 */
function linkTitle(resource, name) {
  return resource?._links?.[name]?.title ?? undefined;
}

function linkHref(resource, name) {
  return resource?._links?.[name]?.href ?? undefined;
}

/** 把工作包渲染成一行 + 一行摘要，避免把整份 HAL 丢给模型。 */
function renderWorkPackage(wp, { hoursPerDay = 8 } = {}) {
  const subject = wp.subject ?? EMPTY;
  const type = linkTitle(wp, 'type') ?? '?';
  const status = linkTitle(wp, 'status') ?? '?';
  const priority = linkTitle(wp, 'priority') ?? '?';
  const parts = [`状态 ${status}`, `优先级 ${priority}`];
  const assignee = linkTitle(wp, 'assignee');
  if (assignee) parts.push(`受理人 ${assignee}`);
  const responsible = linkTitle(wp, 'responsible');
  if (responsible && responsible !== assignee) parts.push(`负责人 ${responsible}`);
  const version = linkTitle(wp, 'version');
  if (version) parts.push(`版本 ${version}`);
  if (wp.startDate) parts.push(`开始 ${dateOnly(wp.startDate)}`);
  if (wp.dueDate) parts.push(`截止 ${dateOnly(wp.dueDate)}`);
  const done = wp.percentageDone;
  if (done !== null && done !== undefined && done !== '') parts.push(`完成 ${done}%`);
  if (wp.estimatedTime) parts.push(`预估 ${hoursText(wp.estimatedTime, hoursPerDay)}`);
  if (wp.remainingTime) parts.push(`剩余 ${hoursText(wp.remainingTime, hoursPerDay)}`);
  return `#${wp.id} [${type}] ${subject}\n    ${parts.join(' · ')}`;
}

function renderProject(p) {
  const parent = linkTitle(p, 'parent');
  // 状态可能来自 _links.status.title，或 statusExplanation（后者是 {format, raw} 富文本）。
  let rawStatus = linkTitle(p, 'status') || (typeof p.status === 'string' ? p.status : '');
  if (!rawStatus && p.statusExplanation) {
    rawStatus = typeof p.statusExplanation === 'string'
      ? p.statusExplanation
      : (p.statusExplanation.raw ?? '');
  }
  const status = rawStatus ? ` · 状态 ${rawStatus}` : '';
  const active = p.active === false ? ' · 已归档' : '';
  return `#${p.id} ${p.name}${parent ? `（父项目 ${parent}）` : ''}${p.identifier ? ` · 标识 ${p.identifier}` : ''}${status}${active}`;
}

function renderTimeEntry(t, { hoursPerDay = 8 } = {}) {
  const wp = linkTitle(t, 'workPackage') ?? t._links?.workPackage?.href ?? EMPTY;
  const user = linkTitle(t, 'user') ?? EMPTY;
  const activity = linkTitle(t, 'activity') ?? EMPTY;
  const spent = t.spentOn ? dateOnly(t.spentOn) : '?';
  // comment 是 {format, raw} 结构，取 raw。
  const comment = typeof t.comment === 'string' ? t.comment : t.comment?.raw;
  return `#${t.id} ${spent} · ${hoursText(t.hours, hoursPerDay)} · ${user} · ${activity} · ${wp}${comment ? `\n    备注：${truncate(comment, 120)}` : ''}`;
}

// ---------------------------------------------------------------- 命令实现

const commands = {};

commands.instances = async () => {
  const config = loadConfig();
  const list = Object.entries(config.instances || {}).map(([key, inst]) => ({
    实例: key,
    名称: inst.label || key,
    地址: inst.baseUrl,
    默认: key === config.default ? '是' : '',
    已配Token: inst.token ? '是' : '否',
  }));
  outJson(list);
};

commands.whoami = async (api) => {
  const me = await api.request.get('/api/v3/users/me');
  out(`已连接：${api.root}`);
  out(`当前账号：#${me.id} ${me.name}（${me.login}）${me.admin ? ' · 管理员' : ''} · ${me.email || EMPTY}`);
};

commands.projects = async (api, args) => {
  // 各版本项目筛选字段名不一致（subjectOrName / name_and_identifier），改为取回后本地匹配，最稳。
  const res = await api.paginate('/api/v3/projects', {
    pageSize: num(args, 'pageSize', 100),
    maxItems: num(args, 'scan', 500),
  });
  const keyword = args.q ? String(args.q).toLowerCase() : '';
  let list = res.elements;
  if (keyword) {
    list = list.filter((p) =>
      [p.name, p.identifier].some((v) => String(v ?? '').toLowerCase().includes(keyword)));
  }
  const limit = num(args, 'limit', 100);
  const shown = list.slice(0, limit);
  if (shown.length === 0) {
    out(keyword ? `没有名称包含「${args.q}」的项目。` : '没有项目。');
    return;
  }
  for (const p of shown) out(renderProject(p));
  out(`（匹配 ${list.length} 条，显示 ${shown.length} 条${list.length > limit ? '，已截断' : ''}）`);
};

/** 组装工作包过滤条件。 */
function wpFilters(api, args) {
  const filters = [];
  if (args.project) {
    filters.push({ project: filter.eq([args.project]) });
  }
  if (args.status && args.status !== 'all') {
    if (args.status === 'open') filters.push({ status: { operator: 'o', values: [] } });
    else if (args.status === 'closed') filters.push({ status: { operator: 'c', values: [] } });
    else filters.push({ status: filter.contains([args.status]) });
  }
  if (args.type) filters.push({ type: filter.contains([args.type]) });
  if (args.q) filters.push({ subjectOrId: filter.contains([args.q]) });
  if (args.assignee) {
    filters.push({ assignee: filter.eq([args.assignee === 'me' ? 'me' : args.assignee]) });
  }
  if (args.version) filters.push({ version: filter.contains([args.version]) });
  if (args.overdue === 'true') filters.push({ dueDate: filter.before(new Date().toISOString().slice(0, 10)) });
  if (args.updatedSince) filters.push({ updatedAt: { operator: '<>d', values: [args.updatedSince, '2999-12-31'] } });
  return filters.length ? filters : undefined;
}

commands['wp-list'] = async (api, args, inst) => {
  const res = await api.paginate('/api/v3/work_packages', {
    filters: wpFilters(api, args),
    sortBy: args.sort ? [args.sort] : [['updatedAt', 'desc']],
    pageSize: num(args, 'pageSize', 50),
    maxItems: num(args, 'limit', 50),
  });
  if (res.elements.length === 0) {
    out('没有匹配的工作包。');
    return;
  }
  for (const wp of res.elements) out(renderWorkPackage(wp, inst));
  out(`（共 ${res.total} 条，显示 ${res.elements.length} 条${res.truncated ? '，已截断' : ''}）`);
};

commands['wp-get'] = async (api, args, inst) => {
  const id = args.id;
  if (!id) throw new Error('需要 --id=工作包ID');
  const wp = await api.request.get(`/api/v3/work_packages/${id}`);
  out(renderWorkPackage(wp, inst));
  const lines = [
    ['项目', linkTitle(wp, 'project')],
    ['父任务', linkTitle(wp, 'parent')],
    ['版本', linkTitle(wp, 'version')],
    ['创建', wp.createdAt ? dateOnly(wp.createdAt) : undefined],
    ['更新', wp.updatedAt ? dateOnly(wp.updatedAt) : undefined],
    ['预估', wp.estimatedTime ? hoursText(wp.estimatedTime, inst.hoursPerDay) : undefined],
    ['已投入', wp.spentTime ? hoursText(wp.spentTime, inst.hoursPerDay) : undefined],
  ];
  for (const [k, v] of lines) if (v) out(`    ${k}：${v}`);
  const desc = wp.description?.raw ?? '';
  if (desc) out(`\n描述：\n${truncate(desc, 1500)}`);
};

/** 创建/更新时的链接装配。 */
async function buildWorkPackageLinks(api, args, existing) {
  const links = {};
  const setLink = (name, href) => {
    if (href) links[name] = { href };
  };
  if (args.project) {
    const project = await api.resolveProject(args.project);
    setLink('project', `/api/v3/projects/${project.id}`);
  } else if (existing) {
    setLink('project', linkHref(existing, 'project'));
  }
  if (args.type) {
    const type = await api.resolveType(args.type);
    setLink('type', `/api/v3/types/${type.id}`);
  }
  if (args.status) {
    const status = await api.resolveStatus(args.status);
    setLink('status', `/api/v3/statuses/${status.id}`);
  }
  if (args.priority) {
    const priority = await api.resolvePriority(args.priority);
    setLink('priority', `/api/v3/priorities/${priority.id}`);
  }
  if (args.assignee) {
    if (args.assignee === 'none' || args.assignee === 'null') {
      links.assignee = { href: null };
    } else {
      const user = await api.resolveUser(args.assignee);
      setLink('assignee', `/api/v3/users/${user.id}`);
    }
  }
  if (args.responsible) {
    const user = await api.resolveUser(args.responsible);
    setLink('responsible', `/api/v3/users/${user.id}`);
  }
  if (args.parent) setLink('parent', `/api/v3/work_packages/${args.parent}`);
  if (args.version) {
    const version = await api.resolveVersion(args.version);
    setLink('version', `/api/v3/versions/${version.id}`);
  }
  return links;
}

commands['wp-create'] = async (api, args, inst) => {
  if (!args.project) throw new Error('需要 --project=项目名或ID');
  if (!args.subject) throw new Error('需要 --subject=标题');
  const links = await buildWorkPackageLinks(api, args);
  const body = { ...links };
  if (args.subject) body.subject = args.subject;
  if (args.desc) body.description = { format: 'markdown', raw: args.desc };
  if (args.due) body.dueDate = args.due;
  if (args.start) body.startDate = args.start;
  if (args.estimate) body.estimatedTime = isoDurationFromHours(Number(args.estimate));
  if (args.progress !== undefined) body.percentageDone = Number(args.progress);
  if (args.dry === 'true' || args.dry === '1') {
    outJson({ 预览: 'dryRun，未写入', body });
    return;
  }
  const created = await api.request.post('/api/v3/work_packages', body, {
    query: args.notify === 'false' ? { notify: 'false' } : undefined,
  });
  out('已创建：');
  out(renderWorkPackage(created, inst));
};

commands['wp-update'] = async (api, args, inst) => {
  const id = args.id;
  if (!id) throw new Error('需要 --id=工作包ID');
  const current = await api.request.get(`/api/v3/work_packages/${id}`);
  const links = await buildWorkPackageLinks(api, args, current);
  const body = { lockVersion: current.lockVersion, ...links };
  if (args.subject) body.subject = args.subject;
  if (args.desc) body.description = { format: 'markdown', raw: args.desc };
  if (args.due !== undefined) body.dueDate = args.due;
  if (args.start !== undefined) body.startDate = args.start;
  if (args.estimate) body.estimatedTime = isoDurationFromHours(Number(args.estimate));
  if (args.progress !== undefined) body.percentageDone = Number(args.progress);
  if (args.dry === 'true' || args.dry === '1') {
    outJson({ 预览: 'dryRun，未写入', body });
    return;
  }
  const updated = await api.request.patch(`/api/v3/work_packages/${id}`, body, {
    query: args.notify === 'false' ? { notify: 'false' } : undefined,
  });
  out('已更新：');
  out(renderWorkPackage(updated, inst));
};

commands['wp-comment'] = async (api, args) => {
  const id = args.id;
  const text = args.text ?? args.comment;
  if (!id || !text) throw new Error('需要 --id=工作包ID --text=评论内容（可用 --text-file 或 --json-file 传长文本）');
  await api.request.post(`/api/v3/work_packages/${id}/activities`, {
    comment: { format: 'markdown', raw: text },
  });
  out(`已在 #${id} 添加评论。`);
};

commands['wp-delete'] = async (api, args) => {
  const id = args.id;
  if (!id) throw new Error('需要 --id=工作包ID');
  if (args.confirm !== 'true' && args.confirm !== '1') {
    throw new Error('删除需二次确认：加 --confirm=true');
  }
  await api.request.remove(`/api/v3/work_packages/${id}`);
  out(`已删除工作包 #${id}。`);
};

commands['time-list'] = async (api, args, inst) => {
  const filters = [];
  if (args.project) filters.push({ project: filter.eq([args.project]) });
  if (args.wp) filters.push({ workPackage: filter.eq([args.wp]) });
  if (args.user) filters.push({ user: filter.eq([args.user]) });
  if (args.from || args.to) {
    filters.push({ spentOn: filter.between(args.from || '2000-01-01', args.to || '2999-12-31') });
  }
  const res = await api.paginate('/api/v3/time_entries', {
    filters: filters.length ? filters : undefined,
    sortBy: [['spentOn', 'desc']],
    pageSize: num(args, 'pageSize', 50),
    maxItems: num(args, 'limit', 50),
  });
  if (res.elements.length === 0) {
    out('没有匹配的工时记录。');
    return;
  }
  let total = 0;
  for (const t of res.elements) {
    out(renderTimeEntry(t, inst));
    total += hoursFromDuration(t.hours, inst.hoursPerDay) || 0;
  }
  out(`（共 ${res.total} 条，显示 ${res.elements.length} 条，合计约 ${Math.round(total * 100) / 100} 小时）`);
};

commands['time-log'] = async (api, args, inst) => {
  const wp = args.wp;
  const hours = args.hours;
  if (!wp || !hours) throw new Error('需要 --wp=工作包ID --hours=小时数');
  const links = { workPackage: { href: `/api/v3/work_packages/${wp}` } };
  if (args.user && args.user !== 'me') {
    const user = await api.resolveUser(args.user);
    links.user = { href: `/api/v3/users/${user.id}` };
  }
  if (args.activity) {
    const activity = await api.resolveActivity(args.activity);
    links.activity = { href: `/api/v3/time_entries/activities/${activity.id}` };
  }
  const body = {
    ...links,
    hours: isoDurationFromHours(Number(hours)),
    spentOn: args.date || new Date().toISOString().slice(0, 10),
  };
  if (args.comment) body.comment = { format: 'plain', raw: args.comment };
  if (args.dry === 'true' || args.dry === '1') {
    outJson({ 预览: 'dryRun，未写入', body });
    return;
  }
  const created = await api.request.post('/api/v3/time_entries', body);
  out('已记录工时：');
  out(renderTimeEntry(created, inst));
};

commands.members = async (api, args) => {
  if (!args.project) throw new Error('需要 --project=项目名或ID');
  const project = await api.resolveProject(args.project);
  const res = await api.paginate(`/api/v3/projects/${project.id}/memberships`, {
    pageSize: num(args, 'pageSize', 50),
    maxItems: num(args, 'limit', 100),
  });
  for (const m of res.elements) {
    const who = linkTitle(m, 'principal');
    const roles = (m._links?.roles ?? []).map((r) => r.title).join('、') || EMPTY;
    out(`${who} · 角色：${roles}`);
  }
  out(`（共 ${res.total} 条）`);
};

commands.versions = async (api, args) => {
  if (!args.project) throw new Error('需要 --project=项目名或ID');
  const project = await api.resolveProject(args.project);
  const res = await api.paginate(`/api/v3/projects/${project.id}/versions`, {
    pageSize: num(args, 'pageSize', 50),
    maxItems: num(args, 'limit', 100),
  });
  for (const v of res.elements) {
    out(`#${v.id} ${v.name} · ${v.status ?? '?'} · ${v.startDate ?? '?'} ~ ${v.endDate ?? v.dueDate ?? '?'}`);
  }
  out(`（共 ${res.total} 条）`);
};

commands.dict = async (api, args) => {
  const what = args.what ?? args.type;
  const map = {
    statuses: '/api/v3/statuses',
    types: '/api/v3/types',
    priorities: '/api/v3/priorities',
    activities: '/api/v3/time_entries/activities',
    roles: '/api/v3/roles',
  };
  if (!map[what]) throw new Error(`可选：${Object.keys(map).join('、')}`);
  // 工时活动在部分实例上直连 /time_entries/activities 会 404，改用插件的表单端点取法。
  let list;
  if (what === 'activities') {
    const project = args.project ? await api.resolveProject(args.project) : null;
    list = await api.listTimeActivities(project?.id);
  } else {
    const data = await api.request.get(map[what]);
    list = data?._embedded?.elements ?? [];
  }
  for (const item of list) out(`#${item.id} ${item.name}`);
  out(`（共 ${list.length} 条）`);
};

commands.users = async (api, args) => {
  const res = await api.paginate('/api/v3/users', {
    filters: args.q ? [{ name: filter.contains([args.q]) }] : undefined,
    pageSize: num(args, 'pageSize', 50),
    maxItems: num(args, 'limit', 50),
  });
  for (const u of res.elements) out(`#${u.id} ${u.name}（${u.login}）${u.email ? ` · ${u.email}` : ''}`);
  out(`（共 ${res.total} 条）`);
};

/** 兜底：直接打 API。 */
commands.raw = async (api, args) => {
  const method = (args.method || 'GET').toUpperCase();
  const p = args.path;
  if (!p) throw new Error('需要 --path=/api/v3/...');
  let body;
  if (args.body) body = JSON.parse(args.body);
  const data = await api.request[method === 'DELETE' ? 'remove' : method.toLowerCase()](
    p,
    ...(method === 'GET' || method === 'DELETE' ? [] : [body]),
  );
  outJson(data);
};

// ---------------------------------------------------------------- 入口

/** 执行一次命令，返回给调用方（MCP 与 CLI 共用）。 */
export async function run(target, name, args = {}) {
  const config = loadConfig();
  if (name === 'instances') {
    const list = Object.entries(config.instances || {}).map(([key, inst]) => ({
      实例: key,
      名称: inst.label || key,
      地址: inst.baseUrl,
      默认: key === config.default ? '是' : '',
    }));
    return list;
  }
  const inst = resolveInstance(config, target);
  const cmd = commands[name];
  if (!cmd) throw new Error(`未知命令「${name}」。可用：${Object.keys(commands).join('、')}`);
  const api = buildApi(inst);
  const collected = [];
  sink = collected;
  try {
    await cmd(api, args, inst);
  } finally {
    sink = null;
  }
  return collected.join('\n');
}

export { commands };

/** CLI 入口：解析 argv 并执行一次命令。 */
export async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
    out(`OpenProject CLI（多实例）
用法：openproject <实例名> <命令> [--键=值 ...]
      openproject instances        列出已配置的实例（无需实例名）
      openproject help             显示本帮助
命令：${Object.keys(commands).join('、')}
配置：OPENPROJECT_CONFIG 指定的文件 > ~/.openproject/op.config.json > ./op.config.json > 环境变量（OPENPROJECT_BASE_URL / OPENPROJECT_API_TOKEN）
提示：中文/长文本参数建议写入 UTF-8 的 JSON 文件后用 --json-file=xxx.json 传入。`);
    return;
  }
  const [first, second, ...rest] = argv;
  const { args } = parseArgs(rest);
  // 「node op.js instances」不需要指定实例名。
  if (first === 'instances') {
    outJson(await run('', 'instances'));
    return;
  }
  const result = await run(first, second, args);
  if (typeof result === 'string' && result) out(result);
  else if (result !== undefined && result !== '') outJson(result);
}

// 仅作为脚本直接运行时才启动 CLI；被 import（如 MCP server）时不执行。
const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((error) => {
    process.stderr.write(`错误：${error?.message || error}\n`);
    if (process.env.OP_DEBUG === '1') process.stderr.write(`${error?.stack}\n`);
    process.exitCode = 1;
  });
}
