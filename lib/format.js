/**
 * 面向模型的紧凑渲染工具。
 *
 * OpenProject 的原始 HAL 响应单个对象就有约 20 个字段和 46 个链接；直接回灌给
 * 模型非常浪费上下文。这里统一把资源压成中文摘要行。
 *
 * @module dsh-plugin-openproject/lib/format
 */

const EMPTY = '—';

/** 空值占位。 */
export function fmt(value) {
  if (value === null || value === undefined || value === '') return EMPTY;
  return String(value);
}

/** 截断过长文本。 */
export function truncate(text, max = 200) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…（已截断，共 ${value.length} 字）`;
}

/**
 * 把小时数转成 OpenProject 使用的 ISO 8601 duration（如 2.5 → PT2H30M）。
 * @param {number} hours - 小时数，允许小数。
 * @returns {string} ISO 8601 duration。
 */
export function isoDurationFromHours(hours) {
  const total = Math.round(Number(hours) * 60);
  if (!Number.isFinite(total) || total <= 0) return 'PT0H';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `PT${h}${h > 0 || m >= 0 ? 'H' : ''}${m > 0 ? `${m}M` : ''}`;
}

/**
 * 把 OpenProject 返回的时长解析成小时数，支持 ISO duration 与 "8:30" 形式。
 * ISO 中的 `P1D` 按实例配置的「每天工时」折算（本实例为 8 小时）。
 * @param {string|number} value - 原始时长。
 * @param {number} [hoursPerDay] - 每天工时，默认 8。
 * @returns {number|null} 小时数。
 */
export function hoursFromDuration(value, hoursPerDay = 8) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (text === '') return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const iso = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(text);
  if (iso) {
    const [, d, h, m, s] = iso;
    return (Number(d ?? 0) * hoursPerDay) + Number(h ?? 0) + Number(m ?? 0) / 60 + Number(s ?? 0) / 3600;
  }
  const clock = /^(\d+):(\d+)$/.exec(text);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  return null;
}

/** 把小时数渲染成 `8 小时` / `8.5 小时`。 */
export function hoursText(value, hoursPerDay = 8) {
  const hours = hoursFromDuration(value, hoursPerDay);
  if (hours === null) return EMPTY;
  const rounded = Math.round(hours * 100) / 100;
  return `${rounded} 小时`;
}

/** 只保留日期部分。 */
export function dateOnly(value) {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return match ? match[1] : String(value);
}

/** 生成一个文本内容块。 */
export function textBlock(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  return [{ type: 'text', text }];
}

/** 返回本机当天日期，格式 YYYY-MM-DD。 */
export function todayLocal(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 渲染工作包标题行：`#101 [任务] 修复登录`。 */
export function workPackageTitle(workPackage) {
  return `#${workPackage.id} [${fmt(workPackage.type)}] ${fmt(workPackage.subject)}`;
}

/** 渲染工作包详情摘要行。 */
export function workPackageMeta(workPackage, { hoursPerDay = 8 } = {}) {
  const parts = [
    `状态 ${fmt(workPackage.status)}`,
    `优先级 ${fmt(workPackage.priority)}`,
  ];
  // 术语与 OpenProject 中文界面保持一致：assignee=受理人，responsible=负责人。
  if (workPackage.assignee) parts.push(`受理人 ${workPackage.assignee}`);
  if (workPackage.responsible && workPackage.responsible !== workPackage.assignee) parts.push(`负责人 ${workPackage.responsible}`);
  if (workPackage.parent) parts.push(`父任务 ${workPackage.parent}`);
  if (workPackage.version) parts.push(`版本 ${workPackage.version}`);
  if (workPackage.startDate) parts.push(`开始 ${dateOnly(workPackage.startDate)}`);
  if (workPackage.dueDate) parts.push(`截止 ${dateOnly(workPackage.dueDate)}`);
  if (workPackage.percentageDone !== null && workPackage.percentageDone !== undefined) parts.push(`完成 ${workPackage.percentageDone}%`);
  const estimated = hoursFromDuration(workPackage.estimatedTime, hoursPerDay);
  if (estimated) parts.push(`预估 ${hoursText(workPackage.estimatedTime, hoursPerDay)}`);
  const spent = hoursFromDuration(workPackage.spentTime, hoursPerDay);
  if (spent) parts.push(`已登记 ${hoursText(workPackage.spentTime, hoursPerDay)}`);
  return parts.join(' · ');
}

/** 渲染分页页脚。 */
export function paginationFooter(result) {
  if (!result) return '';
  const shown = result.elements.length;
  if (result.truncated) return `（共 ${result.total} 条，已显示前 ${shown} 条，可用过滤条件进一步缩小范围）`;
  return `（共 ${result.total} 条）`;
}

/** 把键值对渲染成 `- 键：值`。 */
export function bulletList(entries) {
  return entries
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `- ${key}：${value}`);
}
