/**
 * OpenProject API v3 访问层。
 *
 * 负责鉴权、分页、HAL 解引用、过滤条件构造，以及把用户输入（项目名、状态名、
 * 人名、版本名）解析成 API 需要的 ID —— 让模型用自然语言就能驱动接口。
 *
 * @module dsh-plugin-openproject/lib/api
 */

import { createHttpClient, HttpError } from './http.js';

/** OpenProject 侧的语义化错误，携带原始错误标识便于排查。 */
export class OpenProjectError extends Error {
  /**
   * @param {string} message - 面向模型的中文说明。
   * @param {object} [details] - 诊断上下文。
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'OpenProjectError';
    Object.assign(this, details);
  }
}

const DICTIONARY_TTL_MS = 60000;

/** 构造 OpenProject filters 参数值的辅助函数。 */
export const filter = {
  /** 等于某个 ID 集合。 */
  eq: (values) => ({ operator: '=', values: values.map(String) }),
  /** 包含关键字。 */
  contains: (values) => ({ operator: '~', values: values.map(String) }),
  /** 为空。 */
  isNull: () => ({ operator: '!*', values: [] }),
  /** 不为空。 */
  notNull: () => ({ operator: '*', values: [] }),
  /** 日期区间。 */
  between: (from, to) => ({ operator: '<>d', values: [from, to] }),
  /** 早于 / 晚于。 */
  before: (date) => ({ operator: '<d', values: [date] }),
  after: (date) => ({ operator: '>d', values: [date] }),
  /** 今天。 */
  today: () => ({ operator: 't', values: [] }),
};

/** 把 ID 或 href 变成 `/api/v3/...` 链接对象。 */
export function link(href) {
  return { href };
}

/**
 * 创建 OpenProject API 客户端。
 *
 * @param {object} options - 连接与策略配置。
 * @returns {object} API 客户端。
 */
export function createApi(options) {
  const {
    baseUrl,
    resolveToken,
    rejectUnauthorized = true,
    timeoutMs = 30000,
    defaultPageSize = 25,
    maxPageSize = 100,
    hoursPerDay = 8,
    logger,
  } = options;

  const root = String(baseUrl ?? '').replace(/\/+$/, '');
  const http = createHttpClient({ timeoutMs, rejectUnauthorized });
  const cache = new Map();

  /**
   * 未配置实例地址时给出可操作的指引。
   *
   * 插件不预设任何实例地址，因此「没配 baseUrl」是最常见的首次使用状态；
   * 这里主动抛错，避免拼出相对 URL 后得到难以理解的底层报错。
   */
  function assertConfigured() {
    if (root === '') {
      throw new OpenProjectError(
        '未配置 OpenProject 实例地址。请任选一种方式配置：'
        + '（1）设置环境变量 OPENPROJECT_BASE_URL，例如 https://openproject.example.com；'
        + '（2）在你 profile 的 cordis.patch.yml 中为 openproject 行配置 baseUrl。',
      );
    }
  }

  /** 读取字典缓存，避免每次调用都重新拉取状态/类型等低频数据。 */
  async function cached(key, loader) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await loader();
    cache.set(key, { value, expires: Date.now() + DICTIONARY_TTL_MS });
    return value;
  }

  /** 生成鉴权头。Token 每次操作重新解析，轮换后无需重启。 */
  async function authHeaders(extra = {}) {
    // 所有请求都会经过这里，因此实例地址的检查放在这一处即可覆盖全部工具。
    assertConfigured();
    const token = await resolveToken();
    if (!token) {
      throw new OpenProjectError(
        '未配置 OpenProject API Token。请把 Token 写入 config.tokenFile 指定的文件，'
        + '或保存到凭据服务中 config.credentialRef 指向的名称，或设置 config.token。',
      );
    }
    const basic = Buffer.from(`apikey:${token}`, 'utf8').toString('base64');
    return { authorization: `Basic ${basic}`, ...extra };
  }

  /** GET 一个 API 路径。 */
  async function get(path, { query, headers } = {}) {
    const auth = await authHeaders(headers);
    const { data } = await http.json('GET', `${root}${path}`, { query, headers: auth });
    return data;
  }

  /** POST 一个 API 路径。 */
  async function post(path, body, { query, headers } = {}) {
    const auth = await authHeaders(headers);
    const { data } = await http.json('POST', `${root}${path}`, { query, body, headers: auth });
    return data;
  }

  /** PATCH 一个 API 路径。 */
  async function patch(path, body, { query, headers } = {}) {
    const auth = await authHeaders(headers);
    const { data } = await http.json('PATCH', `${root}${path}`, { query, body, headers: auth });
    return data;
  }

  /** DELETE 一个 API 路径。 */
  async function remove(path) {
    const auth = await authHeaders();
    const { data } = await http.json('DELETE', `${root}${path}`, { headers: auth });
    return data;
  }

  /** 以 multipart/form-data 上传（OpenProject 附件接口的形态）。 */
  async function upload(path, { fields, file }) {
    const auth = await authHeaders();
    const { data } = await http.multipart('POST', `${root}${path}`, { fields, file, headers: auth });
    return data;
  }

  /** 下载二进制内容；接受绝对 URL 或 `/api/v3/...` 相对路径。 */
  async function download(target) {
    const url = String(target).startsWith('http') ? String(target) : `${root}${target}`;
    const auth = await authHeaders();
    return await http.buffer('GET', url, { headers: auth });
  }

  /** 分页拉取集合，直到 maxItems 或取完。 */
  async function paginate(path, { filters, sortBy, select, groupBy, pageSize, maxItems = 100, query = {} } = {}) {
    const size = Math.min(Math.max(1, pageSize ?? defaultPageSize), maxPageSize);
    const collected = [];
    let page = 1;
    let total = 0;
    for (;;) {
      const response = await get(path, {
        query: {
          ...query,
          offset: page,
          pageSize: size,
          ...(filters ? { filters } : {}),
          ...(sortBy ? { sortBy } : {}),
          ...(select ? { select } : {}),
          ...(groupBy ? { groupBy } : {}),
        },
      });
      total = Number(response?.total ?? collected.length);
      const batch = elementsOf(response);
      collected.push(...batch);
      if (collected.length >= maxItems) return { elements: collected.slice(0, maxItems), total, truncated: total > maxItems };
      if (batch.length === 0 || collected.length >= total) return { elements: collected, total, truncated: false };
      page += 1;
      if (page > 100) return { elements: collected, total, truncated: true };
    }
  }

  /** 取 HAL 集合元素。 */
  function elementsOf(response) {
    return response?._embedded?.elements ?? [];
  }

  /** 取某个链接的 href。 */
  function hrefOf(resource, name) {
    return resource?._links?.[name]?.href;
  }

  /** 从 href 尾部取数字 ID。 */
  function idFromHref(href) {
    const match = /\/(\d+)(?:[?#].*)?$/.exec(String(href ?? ''));
    return match ? Number(match[1]) : undefined;
  }

  /** 取资源标题。 */
  function titleOf(resource, name) {
    return resource?._links?.[name]?.title;
  }

  /** 从 ID 或 href 构造链接。 */
  function linkFromId(prefix, id) {
    return id === undefined || id === null ? undefined : { href: `${prefix}/${id}` };
  }

  /** 解析项目：接受数字 ID、项目标识(identifier) 或项目名称。 */
  async function resolveProject(reference) {
    const raw = String(reference).trim();
    if (raw === '') throw new OpenProjectError('项目不能为空。');
    if (/^\d+$/.test(raw)) {
      const project = await get(`/api/v3/projects/${raw}`);
      return project;
    }
    // 项目标识是 URL 安全的短名，先直接尝试。
    try {
      return await get(`/api/v3/projects/${encodeURIComponent(raw)}`);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
    }
    const byName = await paginate('/api/v3/projects', {
      filters: [{ name: filter.contains([raw]) }],
      maxItems: 25,
    });
    const exact = byName.elements.filter((p) => String(p.name).trim() === raw);
    const candidates = exact.length > 0 ? exact : byName.elements;
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) {
      throw new OpenProjectError(`找不到项目「${raw}」。可用 openproject_list_projects 查看你可见的项目。`);
    }
    const list = candidates.slice(0, 10).map((p) => `#${p.id} ${p.name}(${p.identifier})`).join('、');
    throw new OpenProjectError(`项目「${raw}」匹配到多个结果，请改用 ID 或标识：${list}`);
  }

  /** 解析用户：接受数字 ID、`me`、登录名、姓名或邮箱。 */
  async function resolveUser(reference) {
    const raw = String(reference).trim();
    if (/^\d+$/.test(raw)) return await get(`/api/v3/users/${raw}`);
    if (raw.toLowerCase() === 'me') return await get('/api/v3/users/me');
    const users = await cached('users', async () => {
      const page = await paginate('/api/v3/users', { maxItems: 1000, pageSize: maxPageSize });
      return page.elements;
    });
    const lower = raw.toLowerCase();
    const matched = users.filter((user) => {
      const name = String(user.name ?? '').toLowerCase();
      const login = String(user.login ?? '').toLowerCase();
      const email = String(user.email ?? '').toLowerCase();
      return name === lower || login === lower || email === lower
        || name.includes(lower) || login.includes(lower) || email.includes(lower);
    });
    const exact = matched.filter((user) => {
      const fields = [user.name, user.login, user.email].map((v) => String(v ?? '').toLowerCase());
      return fields.includes(lower);
    });
    const candidates = exact.length > 0 ? exact : matched;
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) {
      throw new OpenProjectError(`找不到用户「${raw}」。可用 openproject_list_users 按关键字查询。`);
    }
    const list = candidates.slice(0, 10).map((u) => `#${u.id} ${u.name}(${u.login})`).join('、');
    throw new OpenProjectError(`用户「${raw}」匹配到多个结果，请改用 ID：${list}`);
  }

  /** 解析工作包状态。 */
  async function resolveStatus(reference) {
    const statuses = await cached('statuses', async () => elementsOf(await get('/api/v3/statuses', { query: { pageSize: maxPageSize } })));
    return pickFromDictionary(statuses, reference, '工作包状态', 'openproject_list_work_package_statuses');
  }

  /** 解析工作包类型（可按项目限定）。 */
  async function resolveType(reference, projectId) {
    const key = `types:${projectId ?? 'global'}`;
    const types = await cached(key, async () => elementsOf(await get(
      projectId ? `/api/v3/projects/${projectId}/types` : '/api/v3/types',
      { query: { pageSize: maxPageSize } },
    )));
    return pickFromDictionary(types, reference, '工作包类型', 'openproject_list_work_package_types');
  }

  /** 解析优先级。 */
  async function resolvePriority(reference) {
    const priorities = await cached('priorities', async () => elementsOf(await get('/api/v3/priorities', { query: { pageSize: maxPageSize } })));
    return pickFromDictionary(priorities, reference, '优先级', 'openproject_list_priorities');
  }

  /** 解析角色。 */
  async function resolveRole(reference) {
    const roles = await cached('roles', async () => elementsOf(await get('/api/v3/roles', { query: { pageSize: maxPageSize } })));
    return pickFromDictionary(roles, reference, '角色', 'openproject_list_roles');
  }

  /** 解析工时活动类型；需要项目上下文才能取到可选值。 */
  async function resolveActivity(reference, projectId) {
    const activities = await listTimeActivities(projectId);
    return pickFromDictionary(activities, reference, '工时活动类型', 'openproject_list_time_activities');
  }

  /** 列出工时活动类型（通过表单端点获取，实例已本地化为中文）。 */
  async function listTimeActivities(projectId) {
    const key = `activities:${projectId ?? 'none'}`;
    return await cached(key, async () => {
      const body = projectId ? { _links: { project: { href: `/api/v3/projects/${projectId}` } } } : {};
      const form = await post('/api/v3/time_entries/form', body);
      const allowed = form?._embedded?.schema?.activity?._embedded?.allowedValues;
      return Array.isArray(allowed) ? allowed : [];
    });
  }

  /** 解析版本（里程碑/版本）。 */
  async function resolveVersion(reference, projectId) {
    if (/^\d+$/.test(String(reference).trim())) return await get(`/api/v3/versions/${reference}`);
    const versions = await cached(`versions:${projectId ?? 'global'}`, async () => {
      const path = projectId ? `/api/v3/projects/${projectId}/versions` : '/api/v3/versions';
      return elementsOf(await get(path, { query: { pageSize: maxPageSize } }));
    });
    return pickFromDictionary(versions, reference, '版本/里程碑', 'openproject_list_versions');
  }

  /** 在字典中按 ID → 精确名 → 包含 的顺序查找。 */
  function pickFromDictionary(items, reference, label, listTool) {
    const raw = String(reference ?? '').trim();
    if (raw === '') throw new OpenProjectError(`${label}不能为空。`);
    if (/^\d+$/.test(raw)) {
      const byId = items.find((item) => Number(item.id) === Number(raw));
      if (byId) return byId;
    }
    const lower = raw.toLowerCase();
    const byExactName = items.find((item) => String(item.name ?? '').trim().toLowerCase() === lower);
    if (byExactName) return byExactName;
    const byContains = items.filter((item) => String(item.name ?? '').toLowerCase().includes(lower));
    if (byContains.length === 1) return byContains[0];
    const available = items.map((item) => `${item.id}=${item.name}`).join('、') || '（空）';
    if (byContains.length === 0) {
      throw new OpenProjectError(`找不到${label}「${raw}」。可选值：${available}。也可调用 ${listTool} 获取完整列表。`);
    }
    throw new OpenProjectError(`${label}「${raw}」匹配到多个：${byContains.map((i) => `${i.id}=${i.name}`).join('、')}。`);
  }

  /**
   * 把工作包资源压缩成模型友好的摘要对象。
   * `statusId` 供调用方结合状态字典判断“是否已关闭”，避免每个工作包都带完整链接。
   */
  function summarizeWorkPackage(workPackage) {
    return {
      id: workPackage.id,
      subject: workPackage.subject,
      type: titleOf(workPackage, 'type'),
      status: titleOf(workPackage, 'status'),
      statusId: idFromHref(hrefOf(workPackage, 'status')) ?? null,
      priority: titleOf(workPackage, 'priority'),
      project: titleOf(workPackage, 'project'),
      assignee: titleOf(workPackage, 'assignee') ?? null,
      responsible: titleOf(workPackage, 'responsible') ?? null,
      parent: titleOf(workPackage, 'parent') ?? null,
      parentId: idFromHref(hrefOf(workPackage, 'parent')) ?? null,
      version: titleOf(workPackage, 'version') ?? null,
      startDate: workPackage.startDate ?? null,
      dueDate: workPackage.dueDate ?? null,
      percentageDone: workPackage.percentageDone ?? null,
      estimatedTime: workPackage.estimatedTime ?? null,
      spentTime: workPackage.spentTime ?? null,
      createdAt: workPackage.createdAt,
      updatedAt: workPackage.updatedAt,
      url: `${root}/work_packages/${workPackage.id}`,
    };
  }

  /** 用状态字典补全 `isClosed`，让模型不必再查一次状态表。 */
  async function annotateClosed(summaries) {
    if (summaries.length === 0) return summaries;
    const statuses = await cached('statuses', async () => elementsOf(await get('/api/v3/statuses', { query: { pageSize: maxPageSize } })));
    const closed = new Map(statuses.map((status) => [Number(status.id), Boolean(status.isClosed)]));
    for (const summary of summaries) {
      if (summary.statusId !== null) summary.isClosed = closed.get(Number(summary.statusId)) ?? null;
    }
    return summaries;
  }

  logger?.debug?.('[openproject] API 客户端已创建', { baseUrl: root });

  return {
    root,
    request: { get, post, patch, remove, upload, download },
    paginate,
    elementsOf,
    hrefOf,
    idFromHref,
    titleOf,
    linkFromId,
    resolveProject,
    resolveUser,
    resolveStatus,
    resolveType,
    resolvePriority,
    resolveRole,
    resolveActivity,
    resolveVersion,
    listTimeActivities,
    pickFromDictionary,
    summarizeWorkPackage,
    annotateClosed,
    clearCache: () => cache.clear(),
  };
}
