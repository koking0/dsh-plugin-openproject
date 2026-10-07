/**
 * 工作包（Work Package）域工具：任务、子任务、状态流转与评论。
 * @module dsh-plugin-openproject/lib/tools/work-packages
 */

import {
  textTool, stringParam, intParam, boolParam, stringListParam, clampLimit, listHeader, requireId,
} from './common.js';
import {
  fmt, truncate, dateOnly, isoDurationFromHours, workPackageTitle, workPackageMeta,
} from '../format.js';

/** 解析 `字段:方向` 形式的排序表达式。 */
export function parseSortBy(text, fallback) {
  if (!text) return fallback;
  const parts = String(text).split(',').map((piece) => piece.trim()).filter(Boolean);
  const parsed = [];
  for (const part of parts) {
    const [field, direction] = part.split(':').map((piece) => piece.trim());
    if (!field) continue;
    parsed.push([field, direction === 'desc' ? 'desc' : 'asc']);
  }
  return parsed.length > 0 ? parsed : fallback;
}

/** 提取表单端点的校验错误。 */
export function formValidationErrors(response) {
  const errors = response?._embedded?.validationErrors;
  if (!errors || typeof errors !== 'object') return [];
  return Object.entries(errors).map(([field, detail]) => {
    const message = detail && typeof detail === 'object' ? detail.message : detail;
    return `${field}：${String(message ?? '').trim()}`;
  });
}

/**
 * 构造工作包写入体（创建与更新共用）。
 * @param {object} api - API 客户端。
 * @param {object} args - 工具参数。
 * @param {object} context - `forCreate` 表示创建；`projectId` 为已解析的项目 ID。
 * @returns {Promise<object>} 请求体。
 */
async function buildWorkPackageBody(api, args, { forCreate, projectId }) {
  const body = {};
  if (args.subject !== undefined) body.subject = String(args.subject);
  if (args.description !== undefined) body.description = { raw: String(args.description) };
  if (args.startDate !== undefined) body.startDate = args.startDate ? String(args.startDate) : null;
  if (args.dueDate !== undefined) body.dueDate = args.dueDate ? String(args.dueDate) : null;
  if (args.estimatedHours !== undefined) {
    body.estimatedTime = args.estimatedHours === null ? null : isoDurationFromHours(Number(args.estimatedHours));
  }
  if (args.percentageDone !== undefined) body.percentageDone = Number(args.percentageDone);

  const links = {};
  if (forCreate) {
    const project = await api.resolveProject(args.project);
    links.project = api.linkFromId('/api/v3/projects', project.id);
  }
  if (args.type !== undefined) {
    const type = await api.resolveType(args.type, projectId);
    links.type = api.linkFromId('/api/v3/types', type.id);
  }
  if (args.status !== undefined) {
    const status = await api.resolveStatus(args.status);
    links.status = api.linkFromId('/api/v3/statuses', status.id);
  }
  if (args.assignee !== undefined) {
    links.assignee = args.assignee === null || args.assignee === ''
      ? { href: null }
      : api.linkFromId('/api/v3/users', (await api.resolveUser(args.assignee)).id);
  }
  if (args.responsible !== undefined) {
    links.responsible = args.responsible === null || args.responsible === ''
      ? { href: null }
      : api.linkFromId('/api/v3/users', (await api.resolveUser(args.responsible)).id);
  }
  if (args.priority !== undefined) {
    const priority = await api.resolvePriority(args.priority);
    links.priority = api.linkFromId('/api/v3/priorities', priority.id);
  }
  if (args.parent !== undefined) {
    links.parent = args.parent === null ? { href: null } : api.linkFromId('/api/v3/work_packages', Number(args.parent));
  }
  if (args.version !== undefined) {
    if (args.version === null || args.version === '') {
      links.version = { href: null };
    } else {
      const version = await api.resolveVersion(args.version, projectId);
      links.version = api.linkFromId('/api/v3/versions', version.id);
    }
  }
  if (Object.keys(links).length > 0) body._links = links;
  return body;
}

/**
 * 注册工作包域工具。
 * @param {object} ctx - 插件上下文。
 * @param {object} deps - 依赖。
 */
export function registerWorkPackageTools(ctx, deps) {
  const { api, guard, config } = deps;
  /** 按实例配置的「每天工时」渲染工作包摘要。 */
  const meta = (summary) => workPackageMeta(summary, { hoursPerDay: Number(config?.hoursPerDay) || 8 });
  /** 组装工作包写入的查询参数；静默模式下去掉通知邮件。 */
  const notifyQuery = (args) => ((args?.notify === false || config?.suppressNotifications === true) ? { notify: false } : undefined);

  ctx.tools.register(textTool({
    name: 'openproject_list_work_packages',
    description: '查询工作包（任务/缺陷/里程碑等）。支持按项目、状态、类型、受理人、优先级、版本、父任务、'
      + '标题关键字与截止日期区间过滤。受理人可传用户名、ID 或 `me` 表示当前用户。',
    kind: 'search',
    title: '查询工作包',
    parameters: {
      project: stringParam('项目 ID、标识或名称。'),
      status: stringListParam('状态名称或 ID，可多个（例如 ["正在处理","已确认"]）。'),
      type: stringListParam('类型名称或 ID，可多个（例如 ["任务","缺陷"]）。'),
      assignee: stringParam('受理人：用户名、ID 或 `me`。'),
      priority: stringParam('优先级名称或 ID。'),
      version: stringParam('版本/里程碑名称或 ID。'),
      parent: intParam('父工作包 ID，用它查询某个任务的全部子任务。'),
      keyword: stringParam('工作包标题关键字。'),
      dueBefore: stringParam('截止日期早于该日期（YYYY-MM-DD）。'),
      dueAfter: stringParam('截止日期晚于该日期（YYYY-MM-DD）。'),
      onlyOpen: boolParam('只返回未关闭的工作包。'),
      sortBy: stringParam('排序，格式 `字段:方向`，例如 `updatedAt:desc` 或 `dueDate:asc,id:asc`。'),
      limit: intParam('最多返回多少条，默认 30，上限 200。'),
    },
    async run(args) {
      const filters = [];
      let project = null;
      if (args.project) {
        project = await api.resolveProject(args.project);
        filters.push({ project: { operator: '=', values: [String(project.id)] } });
      }
      if (args.status?.length) {
        const ids = [];
        for (const reference of args.status) ids.push((await api.resolveStatus(reference)).id);
        filters.push({ status: { operator: '=', values: ids.map(String) } });
      }
      if (args.type?.length) {
        const ids = [];
        for (const reference of args.type) ids.push((await api.resolveType(reference, project?.id)).id);
        filters.push({ type: { operator: '=', values: ids.map(String) } });
      }
      if (args.assignee) {
        const value = String(args.assignee).trim() === 'me' ? 'me' : String((await api.resolveUser(args.assignee)).id);
        filters.push({ assignee: { operator: '=', values: [value] } });
      }
      if (args.priority) {
        const priority = await api.resolvePriority(args.priority);
        filters.push({ priority: { operator: '=', values: [String(priority.id)] } });
      }
      if (args.version) {
        const version = await api.resolveVersion(args.version, project?.id);
        filters.push({ version: { operator: '=', values: [String(version.id)] } });
      }
      if (args.parent !== undefined && args.parent !== null) {
        filters.push({ parent: { operator: '=', values: [String(args.parent)] } });
      }
      if (args.keyword) {
        filters.push({ subject: { operator: '~', values: [String(args.keyword)] } });
      }
      if (args.dueBefore) {
        filters.push({ dueDate: { operator: '<d', values: [String(args.dueBefore)] } });
      }
      if (args.dueAfter) {
        filters.push({ dueDate: { operator: '>d', values: [String(args.dueAfter)] } });
      }
      if (args.onlyOpen) {
        filters.push({ status: { operator: 'o', values: [] } });
      }

      const page = await api.paginate('/api/v3/work_packages', {
        filters: filters.length > 0 ? filters : undefined,
        sortBy: parseSortBy(args.sortBy, [['updatedAt', 'desc']]),
        maxItems: clampLimit(args.limit, 30),
      });
      const summaries = await api.annotateClosed(page.elements.map((wp) => api.summarizeWorkPackage(wp)));
      const lines = [listHeader('工作包', page.total, summaries.length, page.truncated)];
      for (const summary of summaries) {
        lines.push(`- ${workPackageTitle(summary)}\n  ${meta(summary)}`);
      }
      const response = {
        total: page.total,
        project: project ? { id: project.id, name: project.name } : null,
        workPackages: summaries,
      };
      return { text: lines.join('\n'), data: response };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_get_work_package',
    description: '读取单个工作包的完整信息：描述、状态、受理人、负责人、日期、预估与已登记工时、父任务与子任务列表。',
    kind: 'read',
    title: '读取工作包详情',
    parameters: {
      workPackage: intParam('工作包 ID。', true),
      includeDescription: boolParam('是否包含描述正文，默认 true。'),
    },
    async run(args) {
      const workPackage = await api.request.get(`/api/v3/work_packages/${requireId(args.workPackage, 'workPackage')}`);
      const summary = (await api.annotateClosed([api.summarizeWorkPackage(workPackage)]))[0];
      const children = Array.isArray(workPackage._links?.children)
        ? workPackage._links.children.map((child) => ({ title: child.title, url: child.href }))
        : [];
      const lines = [
        workPackageTitle(summary),
        meta(summary),
      ];
      if (summary.isClosed !== null && summary.isClosed !== undefined) {
        lines.push(`- 是否已关闭：${summary.isClosed ? '是' : '否'}`);
      }
      if (children.length > 0) {
        lines.push(`子任务（${children.length}）：${children.map((child) => child.title).join('、')}`);
      }
      if (args.includeDescription !== false) {
        const raw = workPackage.description?.raw ?? '';
        lines.push(raw.trim() ? `描述：\n${truncate(raw, 4000)}` : '描述：（空）');
      }
      return {
        text: lines.join('\n'),
        data: { ...summary, description: workPackage.description?.raw ?? '', children },
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_create_work_package',
    description: '创建新的工作包或子任务。project 指定所属项目；传 parent 即成为该工作包的子任务。'
      + 'dryRun 为 true 时只做服务端校验并返回校验结果，不实际创建。',
    kind: 'edit',
    title: '创建工作包',
    parameters: {
      project: stringParam('所属项目 ID、标识或名称，必填。', true),
      subject: stringParam('工作包标题，必填。', true),
      type: stringParam('类型名称或 ID，例如「任务」「缺陷」「里程碑」。省略时使用项目默认类型。'),
      description: stringParam('描述正文，支持 Markdown。'),
      status: stringParam('初始状态名称或 ID，例如「新增」。'),
      assignee: stringParam('受理人用户名或 ID。'),
      responsible: stringParam('负责人（Accountable）用户名或 ID。'),
      priority: stringParam('优先级名称或 ID，例如「高」。'),
      parent: intParam('父工作包 ID。传入即创建为子任务。'),
      version: stringParam('版本/里程碑名称或 ID。'),
      startDate: stringParam('开始日期，YYYY-MM-DD。'),
      dueDate: stringParam('截止日期，YYYY-MM-DD。'),
      estimatedHours: { type: 'number', description: '预估工时（小时），例如 8 或 2.5。' },
      percentageDone: intParam('完成百分比，0-100。'),
      dryRun: boolParam('为 true 时仅校验不创建。'),
      notify: boolParam('为 false 时不发送通知邮件，默认发送。'),
    },
    async run(args) {
      if (args.subject === undefined || String(args.subject).trim() === '') {
        throw new Error('subject（工作包标题）不能为空。');
      }
      if (args.parent !== undefined && args.parent !== null) {
        requireId(args.parent, 'parent');
      }
      if (args.estimatedHours !== undefined && !(Number(args.estimatedHours) > 0)) {
        throw new Error('estimatedHours 必须是大于 0 的数字。');
      }
      const projectRef = await api.resolveProject(args.project);
      guard.assertProjectWritable(projectRef);
      guard.assertConfirm(args, '创建工作包');
      const body = await buildWorkPackageBody(api, args, { forCreate: true, projectId: projectRef.id });

      if (args.dryRun === true) {
        const form = await api.request.post('/api/v3/work_packages/form', body);
        const errors = formValidationErrors(form);
        const preview = form?._embedded?.payload ?? null;
        const payloadText = JSON.stringify(preview ?? body, null, 1);
        return {
          text: [
            'dryRun：未写入任何数据。',
            errors.length === 0
              ? '服务端表单端点未报告校验错误（注意：该端点不校验全部必填项，实际写入仍可能被拒绝）。'
              : `服务端表单报告以下问题：\n${errors.map((line) => `- ${line}`).join('\n')}`,
            `将要提交的内容：\n${payloadText}`,
          ].join('\n'),
          data: { dryRun: true, valid: errors.length === 0, errors, payload: preview ?? body },
        };
      }

      const created = await api.request.post('/api/v3/work_packages', body, { query: notifyQuery(args) });
      const summary = (await api.annotateClosed([api.summarizeWorkPackage(created)]))[0];
      return {
        text: `已创建工作包 ${workPackageTitle(summary)}\n  ${meta(summary)}`,
        data: summary,
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_update_work_package',
    description: '修改工作包：标题、描述、状态、受理人、负责人、优先级、类型、父任务、版本、日期、'
      + '完成度与预估工时。只修改传入的字段。传 status 即可完成状态流转（如「正在处理」改「已关闭」）。',
    kind: 'edit',
    title: '修改工作包',
    parameters: {
      workPackage: intParam('要修改的工作包 ID。', true),
      subject: stringParam('新标题。'),
      description: stringParam('新描述。'),
      status: stringParam('新状态名称或 ID。'),
      assignee: stringParam('受理人用户名或 ID；传空字符串表示清空。'),
      responsible: stringParam('负责人（Accountable）用户名或 ID；传空字符串表示清空。'),
      priority: stringParam('优先级名称或 ID。'),
      type: stringParam('类型名称或 ID。'),
      parent: intParam('父工作包 ID；传 0 表示清空父任务。'),
      version: stringParam('版本/里程碑名称或 ID；传空字符串表示清空。'),
      startDate: stringParam('开始日期 YYYY-MM-DD。'),
      dueDate: stringParam('截止日期 YYYY-MM-DD。'),
      estimatedHours: { type: 'number', description: '预估工时（小时）。' },
      percentageDone: intParam('完成百分比 0-100。'),
      lockVersion: intParam('乐观锁版本号；并发修改冲突时可从报错或详情中获取。'),
      dryRun: boolParam('为 true 时仅校验不修改。'),
      notify: boolParam('为 false 时不发送通知邮件，默认发送。'),
    },
    async run(args) {
      const id = requireId(args.workPackage, 'workPackage');
      const current = await api.request.get(`/api/v3/work_packages/${id}`);
      const projectId = api.idFromHref(api.hrefOf(current, 'project'));
      const project = await api.request.get(`/api/v3/projects/${projectId}`);
      guard.assertProjectWritable(project);
      guard.assertConfirm(args, '修改工作包');

      const normalized = { ...args };
      if (normalized.parent === 0) normalized.parent = null;
      const body = await buildWorkPackageBody(api, normalized, { forCreate: false, projectId });
      // 本实例要求 PATCH 必须携带 lockVersion，否则一律返回 409 UpdateConflict。
      // 默认使用刚刚读到的版本号，因此真正的并发修改仍会被检出。
      body.lockVersion = normalized.lockVersion !== undefined
        ? Number(normalized.lockVersion)
        : Number(current.lockVersion);
      if (Object.keys(body).length === 0) throw new Error('没有传入任何需要修改的字段。');

      if (args.dryRun === true) {
        const form = await api.request.post(`/api/v3/work_packages/${id}/form`, body);
        const errors = formValidationErrors(form);
        const preview = form?._embedded?.payload ?? null;
        return {
          text: [
            'dryRun：未修改任何数据。',
            errors.length === 0
              ? '服务端表单端点未报告校验错误（注意：该端点不校验全部必填项，实际写入仍可能被拒绝）。'
              : `服务端表单报告以下问题：\n${errors.map((line) => `- ${line}`).join('\n')}`,
            `将要提交的内容：\n${JSON.stringify(preview ?? body, null, 1)}`,
          ].join('\n'),
          data: { dryRun: true, valid: errors.length === 0, errors, payload: preview ?? body },
        };
      }

      const updated = await api.request.patch(`/api/v3/work_packages/${id}`, body, { query: notifyQuery(args) })
        .catch((error) => {
          if (error?.status === 409) {
            throw new Error('更新冲突：该工作包在你读取之后已被他人修改。请重新调用 openproject_get_work_package 获取最新内容后重试。');
          }
          throw error;
        });
      const summary = (await api.annotateClosed([api.summarizeWorkPackage(updated)]))[0];
      return {
        text: `已更新工作包 ${workPackageTitle(summary)}\n  ${meta(summary)}`,
        data: summary,
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_delete_work_package',
    description: '永久删除一个工作包。此操作不可撤销，必须带 confirm: true。',
    kind: 'delete',
    title: '删除工作包',
    parameters: {
      workPackage: intParam('要删除的工作包 ID。', true),
      confirm: { type: 'boolean', required: true, description: '必须为 true，确认永久删除。' },
    },
    async run(args) {
      const id = requireId(args.workPackage, 'workPackage');
      guard.assertDestructive(args, '删除工作包');
      const current = await api.request.get(`/api/v3/work_packages/${id}`);
      const projectId = api.idFromHref(api.hrefOf(current, 'project'));
      const project = await api.request.get(`/api/v3/projects/${projectId}`);
      guard.assertProjectWritable(project);
      const summary = api.summarizeWorkPackage(current);
      await api.request.remove(`/api/v3/work_packages/${id}`);
      return { text: `已删除工作包 ${workPackageTitle(summary)}。`, data: { id, deleted: true } };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_add_work_package_comment',
    description: '给工作包添加评论。可标记为内部评论（仅内部成员可见）。',
    kind: 'edit',
    title: '添加工作包评论',
    parameters: {
      workPackage: intParam('工作包 ID。', true),
      comment: stringParam('评论正文，支持 Markdown。', true),
      internal: boolParam('是否为内部评论，默认 false。'),
      notify: boolParam('为 false 时不发送通知邮件，默认发送。'),
    },
    async run(args) {
      const id = requireId(args.workPackage, 'workPackage');
      const current = await api.request.get(`/api/v3/work_packages/${id}`);
      const project = await api.request.get(`/api/v3/projects/${api.idFromHref(api.hrefOf(current, 'project'))}`);
      guard.assertProjectWritable(project);
      guard.assertConfirm(args, '添加评论');
      const response = await api.request.post(`/api/v3/work_packages/${id}/activities`, {
        comment: { raw: String(args.comment) },
        internal: args.internal === true,
      }, { query: notifyQuery(args) });
      const summary = api.summarizeWorkPackage(current);
      return {
        text: `已给 ${workPackageTitle(summary)} 添加${args.internal === true ? '内部' : ''}评论。`,
        data: { workPackage: id, activityId: response?.id ?? null, internal: args.internal === true },
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_list_work_package_comments',
    description: '列出工作包的评论与变更记录（活动流）。',
    kind: 'read',
    title: '查看工作包评论',
    parameters: {
      workPackage: intParam('工作包 ID。', true),
      includeChanges: boolParam('是否包含字段变更记录，默认 false（只看评论）。'),
      limit: intParam('最多返回多少条，默认 30。'),
    },
    async run(args) {
      const id = requireId(args.workPackage, 'workPackage');
      const page = await api.paginate(`/api/v3/work_packages/${id}/activities`, {
        maxItems: clampLimit(args.limit, 30),
        sortBy: [['id', 'asc']],
      });
      const items = page.elements
        .map((activity) => ({
          id: activity.id,
          kind: activity._type,
          author: activity._links?.user?.title ?? null,
          createdAt: activity.createdAt,
          comment: activity.comment?.raw ?? '',
          internal: activity.internal === true,
        }))
        .filter((item) => args.includeChanges === true || item.comment.trim().length > 0);
      const lines = [listHeader('活动', items.length, items.length, false)];
      for (const item of items) {
        if (item.comment) {
          lines.push(`- ${fmt(item.author)} @ ${dateOnly(item.createdAt)}${item.internal ? '（内部）' : ''}：${truncate(item.comment, 500)}`);
        } else {
          lines.push(`- ${fmt(item.author)} @ ${dateOnly(item.createdAt)}：${item.kind}`);
        }
      }
      return { text: lines.join('\n'), data: items };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_list_work_package_statuses',
    description: '列出该实例所有可用的工作包状态（已本地化），包含是否为已关闭状态与默认状态。'
      + '其他工具的 status 参数可传这里的名称或 ID。',
    kind: 'read',
    title: '查看工作包状态字典',
    parameters: {},
    async run() {
      const response = await api.request.get('/api/v3/statuses', { query: { pageSize: 100 } });
      const statuses = api.elementsOf(response).map((status) => ({
        id: status.id,
        name: status.name,
        isClosed: Boolean(status.isClosed),
        isDefault: Boolean(status.isDefault),
      }));
      const lines = [`共 ${statuses.length} 个状态：`];
      for (const status of statuses) {
        lines.push(`- ${status.id}=${status.name}${status.isClosed ? '（已关闭）' : ''}${status.isDefault ? '（默认）' : ''}`);
      }
      return { text: lines.join('\n'), data: statuses };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_list_work_package_types',
    description: '列出工作包类型（任务、缺陷、里程碑等）。传入 project 可只列出该项目启用的类型。',
    kind: 'read',
    title: '查看工作包类型字典',
    parameters: {
      project: stringParam('项目 ID、标识或名称；省略时列出全局类型。'),
    },
    async run(args) {
      const project = args.project ? await api.resolveProject(args.project) : null;
      const path = project ? `/api/v3/projects/${project.id}/types` : '/api/v3/types';
      const response = await api.request.get(path, { query: { pageSize: 100 } });
      const types = api.elementsOf(response).map((type) => ({
        id: type.id,
        name: type.name,
        isMilestone: Boolean(type.isMilestone),
      }));
      const scope = project ? `项目「${project.name}」` : '全局';
      const lines = [`${scope}共 ${types.length} 个类型：`];
      for (const type of types) {
        lines.push(`- ${type.id}=${type.name}${type.isMilestone ? '（里程碑）' : ''}`);
      }
      return { text: lines.join('\n'), data: types };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_list_priorities',
    description: '列出工作包优先级字典。',
    kind: 'read',
    title: '查看优先级字典',
    parameters: {},
    async run() {
      const response = await api.request.get('/api/v3/priorities', { query: { pageSize: 100 } });
      const priorities = api.elementsOf(response).map((priority) => ({
        id: priority.id,
        name: priority.name,
        isDefault: Boolean(priority.isDefault),
      }));
      const lines = [`共 ${priorities.length} 个优先级：`];
      for (const priority of priorities) {
        lines.push(`- ${priority.id}=${priority.name}${priority.isDefault ? '（默认）' : ''}`);
      }
      return { text: lines.join('\n'), data: priorities };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_list_assignable_users',
    description: '列出某个项目中可以被指派工作包的用户，用于确定受理人参数该传谁。',
    kind: 'read',
    title: '查看项目可指派人员',
    parameters: {
      project: stringParam('项目 ID、标识或名称。', true),
    },
    async run(args) {
      const project = await api.resolveProject(args.project);
      const page = await api.paginate(`/api/v3/projects/${project.id}/available_assignees`, { maxItems: 200 });
      const users = page.elements.map((user) => ({
        id: user.id,
        name: user.name,
        login: user.login ?? null,
        email: user.email ?? null,
      }));
      const lines = [`项目「${project.name}」共有 ${page.total} 名可指派成员：`];
      for (const user of users) {
        lines.push(`- #${user.id} ${user.name}${user.login ? `（${user.login}）` : ''}${user.email ? ` ${user.email}` : ''}`);
      }
      return { text: lines.join('\n'), data: users };
    },
  }));
}
