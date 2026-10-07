/**
 * 成员、角色与版本/里程碑域工具。
 * @module dsh-plugin-openproject/lib/tools/members
 */

import {
  textTool, stringParam, intParam, stringListParam, clampLimit, listHeader, requireId,
} from './common.js';
import { fmt, dateOnly, truncate, bulletList } from '../format.js';

/**
 * 注册成员与版本域工具。
 * @param {object} ctx - 插件上下文。
 * @param {object} deps - 依赖。
 */
export function registerMemberTools(ctx, deps) {
  const { api, guard } = deps;

  ctx.tools.register(textTool({
    name: 'openproject_list_memberships',
    description: '列出项目成员关系（谁在哪个项目里担任什么角色）。可按项目或成员过滤。',
    kind: 'read',
    title: '查询项目成员',
    parameters: {
      project: stringParam('项目 ID、标识或名称。'),
      user: stringParam('成员用户名、ID 或 `me`。'),
      limit: intParam('最多返回多少条，默认 50，上限 200。'),
    },
    async run(args) {
      const filters = [];
      let project = null;
      if (args.project) {
        project = await api.resolveProject(args.project);
        filters.push({ project: { operator: '=', values: [String(project.id)] } });
      }
      if (args.user) {
        const value = String(args.user).trim() === 'me' ? 'me' : String((await api.resolveUser(args.user)).id);
        filters.push({ principal: { operator: '=', values: [value] } });
      }
      const page = await api.paginate('/api/v3/memberships', {
        filters: filters.length > 0 ? filters : undefined,
        maxItems: clampLimit(args.limit, 50),
      });
      const memberships = page.elements.map((membership) => ({
        id: membership.id,
        project: membership._links?.project?.title ?? null,
        projectId: api.idFromHref(api.hrefOf(membership, 'project')),
        principal: membership._links?.principal?.title ?? null,
        principalId: api.idFromHref(api.hrefOf(membership, 'principal')),
        roles: (membership._links?.roles ?? []).map((role) => role.title),
      }));
      const lines = [listHeader('成员关系', page.total, memberships.length, page.truncated)];
      for (const membership of memberships) {
        lines.push(`- #${membership.id} ${fmt(membership.principal)} @ ${fmt(membership.project)}：${membership.roles.join('、') || '（无角色）'}`);
      }
      return { text: lines.join('\n'), data: memberships };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_add_membership',
    description: '把某个用户加入项目并分配角色。roles 可传多个角色名称或 ID。',
    kind: 'edit',
    title: '添加项目成员',
    parameters: {
      project: stringParam('项目 ID、标识或名称。', true),
      user: stringParam('用户名、ID 或邮箱。', true),
      roles: stringListParam('角色名称或 ID，例如 ["成员"] 或 ["项目经理","成员"]。'),
    },
    async run(args) {
      const project = await api.resolveProject(args.project);
      guard.assertProjectWritable(project);
      guard.assertConfirm(args, '添加项目成员');
      const user = await api.resolveUser(args.user);
      const roleRefs = args.roles?.length ? args.roles : ['成员'];
      const roleLinks = [];
      for (const reference of roleRefs) {
        roleLinks.push(api.linkFromId('/api/v3/roles', (await api.resolveRole(reference)).id));
      }
      const created = await api.request.post('/api/v3/memberships', {
        _links: {
          project: api.linkFromId('/api/v3/projects', project.id),
          principal: api.linkFromId('/api/v3/users', user.id),
          roles: roleLinks,
        },
      });
      return {
        text: `已把 ${user.name} 加入项目「${project.name}」，角色：${roleRefs.join('、')}（成员关系 #${created?.id}）。`,
        data: { id: created?.id ?? null, project: project.name, user: user.name, roles: roleRefs },
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_update_membership',
    description: '修改某个成员在项目中的角色。roles 会整体替换原有角色集合。',
    kind: 'edit',
    title: '修改成员角色',
    parameters: {
      membership: intParam('成员关系 ID（可由 openproject_list_memberships 获取）。', true),
      roles: stringListParam('新的角色名称或 ID 列表。'),
    },
    async run(args) {
      const id = requireId(args.membership, 'membership');
      const current = await api.request.get(`/api/v3/memberships/${id}`);
      const project = await api.request.get(`/api/v3/projects/${api.idFromHref(api.hrefOf(current, 'project'))}`);
      guard.assertProjectWritable(project);
      guard.assertConfirm(args, '修改成员角色');
      const roleRefs = args.roles ?? [];
      if (roleRefs.length === 0) throw new Error('roles 不能为空：成员至少需要一个角色。');
      const roleLinks = [];
      for (const reference of roleRefs) {
        roleLinks.push(api.linkFromId('/api/v3/roles', (await api.resolveRole(reference)).id));
      }
      const updated = await api.request.patch(`/api/v3/memberships/${id}`, { _links: { roles: roleLinks } });
      const principal = updated?._links?.principal?.title ?? current._links?.principal?.title;
      return {
        text: `已把 ${principal} 在项目「${project.name}」中的角色改为：${roleRefs.join('、')}。`,
        data: { id, roles: roleRefs },
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_delete_membership',
    description: '把成员从项目中移除。必须带 confirm: true。',
    kind: 'delete',
    title: '移除项目成员',
    parameters: {
      membership: intParam('成员关系 ID。', true),
      confirm: { type: 'boolean', required: true, description: '必须为 true，确认移除该成员。' },
    },
    async run(args) {
      const id = requireId(args.membership, 'membership');
      guard.assertDestructive(args, '移除项目成员');
      const current = await api.request.get(`/api/v3/memberships/${id}`);
      const project = await api.request.get(`/api/v3/projects/${api.idFromHref(api.hrefOf(current, 'project'))}`);
      guard.assertProjectWritable(project);
      const principal = current._links?.principal?.title;
      await api.request.remove(`/api/v3/memberships/${id}`);
      return { text: `已把 ${fmt(principal)} 从项目「${project.name}」移除。`, data: { id, deleted: true } };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_list_roles',
    description: '列出该实例所有可用角色。添加或修改成员时 roles 参数可传这里的名称或 ID。',
    kind: 'read',
    title: '查看角色字典',
    parameters: {},
    async run() {
      const response = await api.request.get('/api/v3/roles', { query: { pageSize: 100 } });
      const roles = api.elementsOf(response).map((role) => ({
        id: role.id,
        name: role.name,
        isBuiltin: role._links?.self?.href ? undefined : true,
      }));
      const lines = [`共 ${roles.length} 个角色：`];
      for (const role of roles) lines.push(`- ${role.id}=${role.name}`);
      return { text: lines.join('\n'), data: roles.map((role) => ({ id: role.id, name: role.name })) };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_list_users',
    description: '按关键字查询用户（姓名、登录名或邮箱），用于确定成员与负责人参数。',
    kind: 'search',
    title: '查询用户',
    parameters: {
      keyword: stringParam('姓名、登录名或邮箱关键字，例如「刘」。'),
      limit: intParam('最多返回多少条，默认 25，上限 100。'),
    },
    async run(args) {
      const limit = clampLimit(args.limit, 25, 100);
      const page = await api.paginate('/api/v3/users', { pageSize: 100, maxItems: 1000 });
      const lower = String(args.keyword ?? '').trim().toLowerCase();
      /** 匹配度排序：完全相等 > 前缀 > 包含，同档按名字长度升序。 */
      const score = (user) => {
        const fields = [user.name, user.login, user.email].map((value) => String(value ?? '').toLowerCase());
        if (fields.includes(lower)) return 0;
        if (fields.some((field) => field.startsWith(lower))) return 1;
        return 2;
      };
      const matched = (lower
        ? page.elements.filter((user) => [user.name, user.login, user.email]
          .some((field) => String(field ?? '').toLowerCase().includes(lower)))
          .sort((a, b) => score(a) - score(b) || String(a.name).length - String(b.name).length)
        : page.elements).slice(0, limit);
      const users = matched.map((user) => ({
        id: user.id,
        name: user.name,
        login: user.login ?? null,
        email: user.email ?? null,
        admin: user.admin === true,
        status: user.status ?? null,
      }));
      const header = lower
        ? `在 ${page.total} 个用户中匹配到 ${users.length} 个（关键字「${args.keyword}」）：`
        : `共 ${page.total} 个用户，显示前 ${users.length} 个：`;
      const lines = [header];
      for (const user of users) {
        lines.push(`- #${user.id} ${user.name}${user.login ? `（${user.login}）` : ''}${user.email ? ` ${user.email}` : ''}${user.admin ? ' · 管理员' : ''}`);
      }
      return { text: lines.join('\n'), data: users };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_list_versions',
    description: '列出版本/里程碑。传入 project 只列出该项目的版本。',
    kind: 'read',
    title: '查询版本与里程碑',
    parameters: {
      project: stringParam('项目 ID、标识或名称；省略时列出所有可见版本。'),
      limit: intParam('最多返回多少条，默认 50，上限 200。'),
    },
    async run(args) {
      const project = args.project ? await api.resolveProject(args.project) : null;
      const path = project ? `/api/v3/projects/${project.id}/versions` : '/api/v3/versions';
      const page = await api.paginate(path, { maxItems: clampLimit(args.limit, 50) });
      const versions = page.elements.map((version) => ({
        id: version.id,
        name: version.name,
        status: version.status ?? null,
        startDate: dateOnly(version.startDate),
        endDate: dateOnly(version.endDate),
        sharing: version.sharing ?? null,
        project: version._links?.definingProject?.title ?? project?.name ?? null,
        description: truncate(version.description?.raw ?? '', 200),
      }));
      const scope = project ? `项目「${project.name}」` : '全部项目';
      const lines = [`${scope}共 ${page.total} 个版本/里程碑${page.truncated ? `，已显示前 ${versions.length} 个` : ''}：`];
      for (const version of versions) {
        const statusLabel = { open: '进行中', locked: '已锁定', closed: '已关闭' }[version.status] ?? version.status;
        lines.push(`- #${version.id} ${version.name}｜${fmt(statusLabel)}｜${fmt(version.startDate)}~${fmt(version.endDate)}`);
      }
      return { text: lines.join('\n'), data: versions };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_create_version',
    description: '在项目中创建版本或里程碑。status 可选 open（进行中）/ locked（锁定）/ closed（已关闭）。',
    kind: 'edit',
    title: '创建版本/里程碑',
    parameters: {
      project: stringParam('所属项目 ID、标识或名称。', true),
      name: stringParam('版本名称，必填。', true),
      description: stringParam('版本说明。'),
      startDate: stringParam('开始日期 YYYY-MM-DD。'),
      endDate: stringParam('结束日期 YYYY-MM-DD。'),
      status: { type: 'string', enum: ['open', 'locked', 'closed'], description: '版本状态，默认 open。' },
      sharing: { type: 'string', enum: ['none', 'descendants', 'hierarchy', 'tree', 'system'], description: '共享范围，默认 none。' },
    },
    async run(args) {
      const project = await api.resolveProject(args.project);
      guard.assertProjectWritable(project);
      guard.assertConfirm(args, '创建版本');
      const body = {
        name: String(args.name),
        _links: { definingProject: api.linkFromId('/api/v3/projects', project.id) },
      };
      if (args.description) body.description = { raw: String(args.description) };
      if (args.startDate) body.startDate = String(args.startDate);
      if (args.endDate) body.endDate = String(args.endDate);
      if (args.status) body.status = String(args.status);
      if (args.sharing) body.sharing = String(args.sharing);
      const created = await api.request.post('/api/v3/versions', body);
      return {
        text: `已在项目「${project.name}」创建版本 #${created?.id} ${created?.name}。`,
        data: { id: created?.id ?? null, name: created?.name ?? args.name, project: project.name },
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_update_version',
    description: '修改版本/里程碑的名称、说明、日期或状态。项目参数用于解析同名版本。',
    kind: 'edit',
    title: '修改版本/里程碑',
    parameters: {
      version: stringParam('版本名称或 ID。', true),
      project: stringParam('版本所属项目，用于解析同名版本。'),
      name: stringParam('新名称。'),
      description: stringParam('新说明。'),
      startDate: stringParam('新的开始日期 YYYY-MM-DD。'),
      endDate: stringParam('新的结束日期 YYYY-MM-DD。'),
      status: { type: 'string', enum: ['open', 'locked', 'closed'], description: '新的状态。' },
    },
    async run(args) {
      const project = args.project ? await api.resolveProject(args.project) : null;
      const version = await api.resolveVersion(args.version, project?.id);
      const owningProject = await api.request.get(`/api/v3/projects/${api.idFromHref(api.hrefOf(version, 'definingProject'))}`);
      guard.assertProjectWritable(owningProject);
      guard.assertConfirm(args, '修改版本');
      const body = {};
      if (args.name !== undefined) body.name = String(args.name);
      if (args.description !== undefined) body.description = { raw: String(args.description) };
      if (args.startDate !== undefined) body.startDate = String(args.startDate);
      if (args.endDate !== undefined) body.endDate = String(args.endDate);
      if (args.status !== undefined) body.status = String(args.status);
      if (Object.keys(body).length === 0) throw new Error('没有传入任何需要修改的字段。');
      const updated = await api.request.patch(`/api/v3/versions/${version.id}`, body);
      const brief = {
        id: updated?.id ?? version.id,
        name: updated?.name ?? version.name,
        status: updated?.status ?? version.status,
        startDate: dateOnly(updated?.startDate),
        endDate: dateOnly(updated?.endDate),
      };
      return {
        text: [
          `已更新版本 #${brief.id} ${brief.name}`,
          ...bulletList([['状态', brief.status], ['开始', brief.startDate], ['结束', brief.endDate]]),
        ].join('\n'),
        data: brief,
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_delete_version',
    description: '删除版本/里程碑。必须带 confirm: true。',
    kind: 'delete',
    title: '删除版本/里程碑',
    parameters: {
      version: stringParam('版本名称或 ID。', true),
      project: stringParam('版本所属项目，用于解析同名版本。'),
      confirm: { type: 'boolean', required: true, description: '必须为 true，确认删除。' },
    },
    async run(args) {
      guard.assertDestructive(args, '删除版本');
      const project = args.project ? await api.resolveProject(args.project) : null;
      const version = await api.resolveVersion(args.version, project?.id);
      const owningProject = await api.request.get(`/api/v3/projects/${api.idFromHref(api.hrefOf(version, 'definingProject'))}`);
      guard.assertProjectWritable(owningProject);
      await api.request.remove(`/api/v3/versions/${version.id}`);
      return { text: `已删除版本 #${version.id} ${version.name}。`, data: { id: version.id, deleted: true } };
    },
  }));
}
