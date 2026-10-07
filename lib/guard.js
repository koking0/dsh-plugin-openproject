/**
 * 写入保护。
 *
 * 三层防线，按强度递增：
 * 1. `readOnly` 全局只读开关；
 * 2. `writeProjects` 项目级写入白名单；
 * 3. 删除类操作强制要求 `confirm: true`。
 *
 * @module dsh-plugin-openproject/lib/guard
 */

/** 读取配置中的项目白名单。 */
function allowedProjects(config) {
  const raw = config?.writeProjects;
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

/**
 * 创建写入守卫。
 *
 * @param {object} options - 依赖。
 * @param {object} options.config - 插件配置。
 * @returns {object} 守卫方法集合。
 */
export function createGuard({ config }) {
  const readOnly = config?.readOnly === true;

  /** 写入总开关。 */
  function assertWritable() {
    if (readOnly) {
      throw new Error('该插件当前处于只读模式（config.readOnly = true），已拒绝所有写入操作。');
    }
  }

  /**
   * 校验目标项目是否允许写入。
   * @param {object|null} project - 已解析的项目资源。
   */
  function assertProjectWritable(project) {
    assertWritable();
    const allow = allowedProjects(config);
    if (allow.length === 0) return;
    if (!project) {
      throw new Error(`写入范围已通过 config.writeProjects 限制为 ${allow.join('、')}，但本次操作无法确定目标项目，已拒绝。`);
    }
    const tokens = [String(project.id), String(project.identifier ?? ''), String(project.name ?? '')];
    if (!allow.some((entry) => tokens.includes(entry))) {
      throw new Error(
        `写入范围受限：config.writeProjects 只允许 ${allow.join('、')}，`
        + `而目标项目是「${project.name}」（${project.identifier ?? project.id}）。`,
      );
    }
  }

  /** 普通写入的可选二次确认。 */
  function assertConfirm(args, label) {
    if (config?.requireConfirmForWrites !== true) return;
    if (args?.confirm === true) return;
    throw new Error(`${label}属于写入操作。确认无误后请带 confirm: true 重新调用。`);
  }

  /** 删除类操作的强制二次确认。 */
  function assertDestructive(args, label) {
    assertWritable();
    if (args?.confirm === true) return;
    throw new Error(`${label}会永久删除数据且不可撤销。确认无误后请带 confirm: true 重新调用。`);
  }

  return { readOnly, assertWritable, assertProjectWritable, assertConfirm, assertDestructive };
}
