/**
 * 工时域工具：时间记录与统计。
 *
 * 注意 OpenProject 的两处易错点：
 * - 时间记录关联工作包的筛选器字段名是 `entity`（不是 `workPackage`）；
 * - `hours` 使用 ISO 8601 duration，且 `P1D` 按实例「每天工时」折算。
 *
 * @module dsh-plugin-openproject/lib/tools/time
 */

import {
  textTool, stringParam, intParam, boolParam, clampLimit, listHeader, requireId,
} from './common.js';
import { fmt, truncate, dateOnly, hoursText, isoDurationFromHours, hoursFromDuration, todayLocal } from '../format.js';

/** 从链接里取标题。 */
function linkTitle(resource, name) {
  return resource?._links?.[name]?.title ?? null;
}

/**
 * 注册工时域工具。
 * @param {object} ctx - 插件上下文。
 * @param {object} deps - 依赖。
 */
export function registerTimeTools(ctx, deps) {
  const { api, guard, config } = deps;
  const hoursPerDay = Number(config?.hoursPerDay) || 8;

  /** 把时间记录压成摘要。 */
  const brief = (entry) => ({
    id: entry.id,
    spentOn: dateOnly(entry.spentOn),
    hours: hoursFromDuration(entry.hours, hoursPerDay),
    hoursRaw: entry.hours,
    user: linkTitle(entry, 'user'),
    project: linkTitle(entry, 'project'),
    workPackage: linkTitle(entry, 'entity') ?? linkTitle(entry, 'workPackage'),
    workPackageId: api.idFromHref(api.hrefOf(entry, 'entity') ?? api.hrefOf(entry, 'workPackage')),
    activity: linkTitle(entry, 'activity'),
    comment: entry.comment?.raw ?? '',
    ongoing: entry.ongoing === true,
  });

  ctx.tools.register(textTool({
    name: 'openproject_list_time_entries',
    description: '查询工时记录。可按项目、工作包、成员与日期区间过滤。',
    kind: 'search',
    title: '查询工时记录',
    parameters: {
      project: stringParam('项目 ID、标识或名称。'),
      workPackage: intParam('工作包 ID，只看登记在该工作包上的工时。'),
      user: stringParam('成员用户名、ID 或 `me`。'),
      activity: stringParam('工时活动类型名称或 ID，例如「开发」。'),
      from: stringParam('起始日期 YYYY-MM-DD（含）。'),
      to: stringParam('结束日期 YYYY-MM-DD（含）。'),
      limit: intParam('最多返回多少条，默认 50，上限 200。'),
    },
    async run(args) {
      const filters = [];
      let project = null;
      if (args.project) {
        project = await api.resolveProject(args.project);
        filters.push({ project: { operator: '=', values: [String(project.id)] } });
      }
      if (args.workPackage !== undefined && args.workPackage !== null) {
        filters.push({ entity: { operator: '=', values: [String(args.workPackage)] } });
      }
      if (args.user) {
        const value = String(args.user).trim() === 'me' ? 'me' : String((await api.resolveUser(args.user)).id);
        filters.push({ user: { operator: '=', values: [value] } });
      }
      if (args.activity) {
        const activity = await api.resolveActivity(args.activity, project?.id);
        filters.push({ activity: { operator: '=', values: [String(activity.id)] } });
      }
      if (args.from && args.to) {
        filters.push({ spentOn: { operator: '<>d', values: [String(args.from), String(args.to)] } });
      } else if (args.from) {
        filters.push({ spentOn: { operator: '>d', values: [String(args.from)] } });
      } else if (args.to) {
        filters.push({ spentOn: { operator: '<d', values: [String(args.to)] } });
      }

      const page = await api.paginate('/api/v3/time_entries', {
        filters: filters.length > 0 ? filters : undefined,
        sortBy: [['spentOn', 'desc']],
        maxItems: clampLimit(args.limit, 50),
      });
      const entries = page.elements.map(brief);
      const totalHours = entries.reduce((sum, entry) => sum + (entry.hours ?? 0), 0);
      const lines = [listHeader('工时记录', page.total, entries.length, page.truncated)];
      for (const entry of entries) {
        lines.push(
          `- ${entry.spentOn} ${hoursText(entry.hoursRaw, hoursPerDay)}｜${fmt(entry.user)}｜`
          + `${fmt(entry.project)}｜${fmt(entry.workPackage)}｜${fmt(entry.activity)}`
          + `${entry.comment ? `｜${truncate(entry.comment, 120)}` : ''}`,
        );
      }
      if (entries.length > 0) {
        lines.push(`本次返回记录合计：${Math.round(totalHours * 100) / 100} 小时。`);
      }
      return {
        text: lines.join('\n'),
        data: { total: page.total, listedHours: Math.round(totalHours * 100) / 100, entries },
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_log_time',
    description: '登记一条工时记录。可以只给工作包（自动带出所属项目），也可以只给项目。'
      + 'activity 省略时使用该项目的默认活动类型。',
    kind: 'edit',
    title: '登记工时',
    parameters: {
      hours: { type: 'number', required: true, description: '工时小时数，例如 4 或 1.5。' },
      workPackage: intParam('工作包 ID；给出后会自动带出所属项目。'),
      project: stringParam('项目 ID、标识或名称；未给工作包时必须提供。'),
      spentOn: stringParam('工时归属日期 YYYY-MM-DD，省略表示今天。'),
      activity: stringParam('活动类型名称或 ID，例如「开发」「测试」。'),
      comment: stringParam('工作内容说明。'),
      user: stringParam('代替其他成员登记（需要管理员权限）；省略表示当前用户。'),
    },
    async run(args) {
      if (!args.workPackage && !args.project) {
        throw new Error('必须至少提供 workPackage 或 project 之一。');
      }
      const hours = Number(args.hours);
      if (!Number.isFinite(hours) || hours <= 0) {
        throw new Error('hours 必须是大于 0 的数字。');
      }

      let workPackage = null;
      let project = null;
      if (args.workPackage) {
        workPackage = await api.request.get(`/api/v3/work_packages/${requireId(args.workPackage, 'workPackage')}`);
        project = await api.request.get(`/api/v3/projects/${api.idFromHref(api.hrefOf(workPackage, 'project'))}`);
      } else {
        project = await api.resolveProject(args.project);
      }
      guard.assertProjectWritable(project);
      guard.assertConfirm(args, '登记工时');

      let activityReference = args.activity;
      if (activityReference === undefined || activityReference === null || activityReference === '') {
        const available = await api.listTimeActivities(project.id);
        if (available.length === 0) {
          throw new Error(`项目「${project.name}」没有可用的工时活动类型，请显式传入 activity。`);
        }
        activityReference = available[0].name;
      }
      const activity = await api.resolveActivity(activityReference, project.id);
      const links = {
        project: api.linkFromId('/api/v3/projects', project.id),
        activity: api.linkFromId('/api/v3/time_entries/activities', activity.id),
      };
      if (workPackage) links.entity = api.linkFromId('/api/v3/work_packages', workPackage.id);
      if (args.user) links.user = api.linkFromId('/api/v3/users', (await api.resolveUser(args.user)).id);

      const body = {
        hours: isoDurationFromHours(hours),
        // OpenProject 要求 spentOn 必填；省略时按本机当天记账。
        spentOn: String(args.spentOn ?? todayLocal()),
        _links: links,
      };
      if (args.comment) body.comment = { raw: String(args.comment) };

      const created = await api.request.post('/api/v3/time_entries', body);
      const entry = brief(created);
      return {
        text: `已登记工时：${dateOnly(entry.spentOn)} ${hoursText(entry.hoursRaw, hoursPerDay)}`
          + `｜${fmt(entry.project)}｜${fmt(entry.workPackage)}｜${fmt(entry.activity)}`
          + `${entry.comment ? `｜${entry.comment}` : ''}（记录 #${entry.id}）`,
        data: entry,
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_update_time_entry',
    description: '修改已有工时记录：小时数、归属日期、活动类型、工作包或说明。',
    kind: 'edit',
    title: '修改工时记录',
    parameters: {
      timeEntry: intParam('工时记录 ID。', true),
      hours: { type: 'number', description: '新的工时小时数。' },
      spentOn: stringParam('新的归属日期 YYYY-MM-DD。'),
      activity: stringParam('新的活动类型名称或 ID。'),
      workPackage: intParam('改挂到另一个工作包。'),
      comment: stringParam('新的工作内容说明。'),
    },
    async run(args) {
      const id = requireId(args.timeEntry, 'timeEntry');
      const current = await api.request.get(`/api/v3/time_entries/${id}`);
      const project = await api.request.get(`/api/v3/projects/${api.idFromHref(api.hrefOf(current, 'project'))}`);
      guard.assertProjectWritable(project);
      guard.assertConfirm(args, '修改工时记录');

      const body = { _links: {} };
      if (args.hours !== undefined) body.hours = isoDurationFromHours(Number(args.hours));
      if (args.spentOn !== undefined) body.spentOn = String(args.spentOn);
      if (args.comment !== undefined) body.comment = { raw: String(args.comment) };
      if (args.activity !== undefined) {
        const activity = await api.resolveActivity(args.activity, project.id);
        body._links.activity = api.linkFromId('/api/v3/time_entries/activities', activity.id);
      }
      if (args.workPackage !== undefined) {
        body._links.entity = api.linkFromId('/api/v3/work_packages', requireId(args.workPackage, 'workPackage'));
      }
      if (Object.keys(body._links).length === 0) delete body._links;
      if (Object.keys(body).length === 0) throw new Error('没有传入任何需要修改的字段。');

      const updated = await api.request.patch(`/api/v3/time_entries/${id}`, body);
      const entry = brief(updated);
      return { text: `已更新工时记录 #${entry.id}：${hoursText(entry.hoursRaw, hoursPerDay)}。`, data: entry };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_delete_time_entry',
    description: '永久删除一条工时记录。必须带 confirm: true。',
    kind: 'delete',
    title: '删除工时记录',
    parameters: {
      timeEntry: intParam('工时记录 ID。', true),
      confirm: { type: 'boolean', required: true, description: '必须为 true，确认永久删除。' },
    },
    async run(args) {
      const id = requireId(args.timeEntry, 'timeEntry');
      guard.assertDestructive(args, '删除工时记录');
      const current = await api.request.get(`/api/v3/time_entries/${id}`);
      const project = await api.request.get(`/api/v3/projects/${api.idFromHref(api.hrefOf(current, 'project'))}`);
      guard.assertProjectWritable(project);
      await api.request.remove(`/api/v3/time_entries/${id}`);
      return { text: `已删除工时记录 #${id}。`, data: { id, deleted: true } };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_list_time_activities',
    description: '列出工时活动类型（开发、测试、管理…）。传入 project 可获取该项目可用的活动类型。',
    kind: 'read',
    title: '查看工时活动类型',
    parameters: {
      project: stringParam('项目 ID、标识或名称。'),
    },
    async run(args) {
      const project = args.project ? await api.resolveProject(args.project) : null;
      const activities = project
        ? await api.listTimeActivities(project.id)
        : await api.listTimeActivities();
      const list = activities.map((activity) => ({ id: activity.id, name: activity.name }));
      const lines = list.length > 0
        ? [`共 ${list.length} 个工时活动类型：`, ...list.map((item) => `- ${item.id}=${item.name}`)]
        : ['未获取到工时活动类型，请传入 project 参数重试。'];
      return { text: lines.join('\n'), data: list };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_time_report',
    description: '按维度汇总工时。先按项目与日期区间拉取时间记录，再按 member / activity / project / '
      + 'workPackage 分组求和，用于回答「谁在哪个项目上花了多少时间」。',
    kind: 'read',
    title: '工时统计报表',
    parameters: {
      project: stringParam('项目 ID、标识或名称。'),
      from: stringParam('起始日期 YYYY-MM-DD（含）。'),
      to: stringParam('结束日期 YYYY-MM-DD（含）。'),
      user: stringParam('只看某个成员。'),
      groupBy: { type: 'string', enum: ['member', 'activity', 'project', 'workPackage'], description: '分组维度，默认 member。' },
      limit: intParam('最多拉取多少条原始记录用于统计，默认 500，上限 2000。'),
    },
    async run(args) {
      const groupBy = args.groupBy ?? 'member';
      const filters = [];
      let project = null;
      if (args.project) {
        project = await api.resolveProject(args.project);
        filters.push({ project: { operator: '=', values: [String(project.id)] } });
      }
      if (args.user) {
        const value = String(args.user).trim() === 'me' ? 'me' : String((await api.resolveUser(args.user)).id);
        filters.push({ user: { operator: '=', values: [value] } });
      }
      if (args.from && args.to) {
        filters.push({ spentOn: { operator: '<>d', values: [String(args.from), String(args.to)] } });
      } else if (args.from) {
        filters.push({ spentOn: { operator: '>d', values: [String(args.from)] } });
      } else if (args.to) {
        filters.push({ spentOn: { operator: '<d', values: [String(args.to)] } });
      }

      const page = await api.paginate('/api/v3/time_entries', {
        filters: filters.length > 0 ? filters : undefined,
        sortBy: [['spentOn', 'desc']],
        maxItems: clampLimit(args.limit, 500, 2000),
      });
      const entries = page.elements.map(brief);
      const buckets = new Map();
      for (const entry of entries) {
        let key = '未知';
        if (groupBy === 'member') key = entry.user ?? '未知成员';
        else if (groupBy === 'activity') key = entry.activity ?? '未指定活动';
        else if (groupBy === 'project') key = entry.project ?? '未知项目';
        else if (groupBy === 'workPackage') key = entry.workPackage ? `#${entry.workPackageId} ${entry.workPackage}` : '未关联工作包';
        const bucket = buckets.get(key) ?? { key, hours: 0, count: 0 };
        bucket.hours += entry.hours ?? 0;
        bucket.count += 1;
        buckets.set(key, bucket);
      }
      const rows = [...buckets.values()]
        .map((bucket) => ({ ...bucket, hours: Math.round(bucket.hours * 100) / 100 }))
        .sort((a, b) => b.hours - a.hours);
      const totalHours = Math.round(rows.reduce((sum, row) => sum + row.hours, 0) * 100) / 100;
      const scope = [
        project ? `项目「${project.name}」` : '全部项目',
        args.from || args.to ? `日期 ${args.from ?? '开始'}~${args.to ?? '今天'}` : '全部日期',
        args.user ? `成员 ${args.user}` : null,
      ].filter(Boolean).join('，');
      const groupLabel = { member: '成员', activity: '活动类型', project: '项目', workPackage: '工作包' }[groupBy] ?? groupBy;
      const lines = [`工时统计（${scope}，按${groupLabel}分组）：`, `合计 ${totalHours} 小时，共 ${entries.length} 条记录${page.truncated ? '（已截断，结果偏小）' : ''}。`];
      for (const row of rows) {
        lines.push(`- ${row.key}：${row.hours} 小时（${row.count} 条）`);
      }
      return { text: lines.join('\n'), data: { groupBy, scope, totalHours, totalEntries: entries.length, truncated: page.truncated, rows } };
    },
  }));
}
