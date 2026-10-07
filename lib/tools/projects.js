/**
 * 项目域工具。
 * @module dsh-plugin-openproject/lib/tools/projects
 */

import { textTool, stringParam, intParam, boolParam, clampLimit, listHeader } from './common.js';
import { fmt, truncate, dateOnly, bulletList } from '../format.js';

/** 把项目资源压成摘要。 */
function projectBrief(project) {
  return {
    id: project.id,
    identifier: project.identifier,
    name: project.name,
    active: project.active ?? null,
    public: project.public ?? null,
    parent: project._links?.parent?.title ?? null,
    description: truncate(project.description?.raw ?? '', 200),
    createdAt: dateOnly(project.createdAt),
    updatedAt: dateOnly(project.updatedAt),
    url: project._links?.self?.href ?? null,
  };
}

/**
 * 注册项目域工具。
 * @param {object} ctx - 插件上下文。
 * @param {object} deps - 依赖（api / guard / config）。
 */
export function registerProjectTools(ctx, deps) {
  const { api, guard } = deps;

  ctx.tools.register(textTool({
    name: 'openproject_list_projects',
    description: '列出 OpenProject 中当前账号可见的项目。可用 keyword 按名称模糊过滤。'
      + '返回项目 ID、标识（identifier）与名称；其他工具的项目参数可以传 ID、标识或名称。',
    kind: 'read',
    title: '查询 OpenProject 项目',
    parameters: {
      keyword: stringParam('按项目名称模糊过滤，例如「实验室」。'),
      limit: intParam('最多返回多少条，默认 50，上限 200。'),
    },
    async run(args) {
      const limit = clampLimit(args.limit, 50);
      const page = await api.paginate('/api/v3/projects', {
        filters: args.keyword ? [{ name: { operator: '~', values: [String(args.keyword)] } }] : undefined,
        sortBy: [['name', 'asc']],
        maxItems: limit,
      });
      const lines = [listHeader('项目', page.total, page.elements.length, page.truncated)];
      for (const project of page.elements) {
        const archived = project.active === false ? ' · 已归档' : '';
        lines.push(`- #${project.id} ${project.name}（标识 ${project.identifier}）${archived}`);
      }
      return { text: lines.join('\n'), data: page.elements.map(projectBrief) };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_get_project',
    description: '读取单个 OpenProject 项目的详细信息：名称、标识、描述、父项目、创建与更新时间。',
    kind: 'read',
    title: '读取 OpenProject 项目详情',
    parameters: {
      project: stringParam('项目 ID、标识或名称。', true),
    },
    async run(args) {
      const project = await api.resolveProject(args.project);
      const brief = projectBrief(project);
      const lines = [
        `#${brief.id} ${brief.name}`,
        ...bulletList([
          ['标识', brief.identifier],
          ['状态', brief.active === false ? '已归档' : '启用中'],
          ['可见性', brief.public === true ? '公开' : '内部'],
          ['父项目', brief.parent],
          ['创建', brief.createdAt],
          ['更新', brief.updatedAt],
        ]),
      ];
      if (brief.description) lines.push(`描述：${brief.description}`);
      return { text: lines.join('\n'), data: brief };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_create_project',
    description: '在 OpenProject 中新建项目。identifier 是项目在 URL 中使用的短标识，'
      + '省略时由 OpenProject 按名称自动生成。',
    kind: 'edit',
    title: '新建 OpenProject 项目',
    parameters: {
      name: stringParam('项目名称，必填。', true),
      identifier: stringParam('项目标识（URL 短名，仅小写字母、数字、连字符与下划线）。省略则自动生成。'),
      description: stringParam('项目描述，支持 Markdown。'),
      parent: stringParam('父项目 ID、标识或名称，用于创建子项目。'),
      public: boolParam('是否对所有人公开，默认 false。'),
    },
    async run(args, exec) {
      guard.assertConfirm(args, '新建项目');
      const body = { name: String(args.name).trim() };
      if (args.identifier) body.identifier = String(args.identifier).trim();
      if (args.description) body.description = { raw: String(args.description) };
      if (args.public !== undefined) body.public = args.public === true;
      if (args.parent) {
        const parent = await api.resolveProject(args.parent);
        guard.assertProjectWritable(parent);
        body._links = { parent: api.linkFromId('/api/v3/projects', parent.id) };
      } else {
        guard.assertWritable();
      }
      const created = await api.request.post('/api/v3/projects', body);
      const brief = projectBrief(created);
      return {
        text: `已创建项目 #${brief.id} ${brief.name}（标识 ${brief.identifier}）。`,
        data: brief,
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_update_project',
    description: '修改项目属性：名称、描述、归档状态或父项目。只修改传入的字段。',
    kind: 'edit',
    title: '修改 OpenProject 项目',
    parameters: {
      project: stringParam('项目 ID、标识或名称。', true),
      name: stringParam('新的项目名称。'),
      description: stringParam('新的项目描述。'),
      active: boolParam('false 表示归档该项目，true 表示恢复。'),
      parent: stringParam('父项目 ID、标识或名称。'),
    },
    async run(args) {
      const project = await api.resolveProject(args.project);
      guard.assertProjectWritable(project);
      guard.assertConfirm(args, '修改项目');
      const body = {};
      if (args.name !== undefined) body.name = String(args.name);
      if (args.description !== undefined) body.description = { raw: String(args.description) };
      if (args.active !== undefined) body.active = args.active === true;
      if (args.parent !== undefined) {
        const parent = await api.resolveProject(args.parent);
        guard.assertProjectWritable(parent);
        body._links = { parent: api.linkFromId('/api/v3/projects', parent.id) };
      }
      if (Object.keys(body).length === 0) {
        throw new Error('没有传入任何需要修改的字段。');
      }
      const updated = await api.request.patch(`/api/v3/projects/${project.id}`, body);
      const brief = projectBrief(updated);
      return { text: `已更新项目 #${brief.id} ${brief.name}${args.active === false ? '（已归档）' : ''}。`, data: brief };
    },
  }));
}

export { projectBrief };
