/**
 * 工具定义的公共骨架（自带实现，零外部依赖）。
 *
 * 为什么不 import `@deepseek-ai/dsh-tools`：
 * 该插件以 `link:` 方式安装进 profile，Node 会按链接的真实路径（工作区）解析裸模块名，
 * 而工作区没有 DSH 安装目录下的 `@deepseek-ai/*`，导致 `ERR_MODULE_NOT_FOUND` 与
 * “failed to import”。这里内联等价的 `defineTool`（参数 DSL 编译 + 入参校验），
 * 使插件只依赖 `node:*` 内置模块，可以放在任何位置加载。
 *
 * 全部工具统一返回 `{ text, data }`：`text` 是给模型看的中文摘要，`data` 是结构化数据。
 * 输出 schema 使用 DSL 的 `json` 节点，接受任意 JSON 值。
 *
 * @module dsh-plugin-openproject/lib/tools/common
 */

import { textBlock } from '../format.js';

/** 允许出现在任意 schema 节点上的注解字段。 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

/** 拼接校验错误路径。 */
function joinPath(path, key) {
  return path ? `${path}.${key}` : key;
}

/** 复制注解字段。 */
function copyAnnotations(source, target) {
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(source, key)) target[key] = source[key];
  }
}

/** 校验一个节点是 schema 对象。 */
function assertSchemaNode(node, path) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${path} 必须是 schema 对象`);
  }
}

/**
 * 编译单个取值节点。
 * @param {object} node - DSL 节点。
 * @param {string} path - 诊断路径。
 * @returns {object} 原始 JSON Schema 子集。
 */
function compileValue(node, path) {
  assertSchemaNode(node, path);
  const out = {};

  if (Object.hasOwn(node, 'oneOf')) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      throw new Error(`${path}.oneOf 至少需要两个分支`);
    }
    copyAnnotations(node, out);
    out.oneOf = node.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`));
    return out;
  }

  copyAnnotations(node, out);
  switch (node.type) {
    case 'json':
      // 注解式节点：接受任意 JSON 值。
      return out;
    case 'object': {
      out.type = 'object';
      out.additionalProperties = node.additionalProperties === true;
      const compiled = compilePropertyMap(node.properties ?? {}, `${path}.properties`);
      out.properties = compiled.properties;
      if (compiled.required.length > 0) out.required = compiled.required;
      return out;
    }
    case 'array': {
      out.type = 'array';
      if (Object.hasOwn(node, 'items')) out.items = compileValue(node.items, `${path}.items`);
      return out;
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      out.type = node.type;
      if (Object.hasOwn(node, 'enum')) {
        if (!Array.isArray(node.enum) || node.enum.length === 0) {
          throw new Error(`${path}.enum 必须是非空数组`);
        }
        out.enum = Array.from(node.enum);
      }
      if (Object.hasOwn(node, 'const')) out.const = node.const;
      return out;
    }
    default:
      throw new Error(`${path}.type 不受支持：${JSON.stringify(node.type)}`);
  }
}

/**
 * 编译隐式属性表，并收集 `required: true` 的字段。
 * @param {object} spec - 属性表。
 * @param {string} path - 诊断路径。
 * @returns {{properties: object, required: string[]}} 编译结果。
 */
function compilePropertyMap(spec, path) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path} 必须是属性表`);
  }
  const properties = {};
  const required = [];
  for (const [key, node] of Object.entries(spec)) {
    assertSchemaNode(node, `${path}.${key}`);
    if (Object.hasOwn(node, 'required') && node.required !== true) {
      throw new Error(`${path}.${key}.required 只能为 true`);
    }
    const { required: _required, ...rest } = node;
    properties[key] = compileValue(rest, `${path}.${key}`);
    if (node.required === true) required.push(key);
  }
  return { properties, required };
}

/**
 * 把参数 DSL 编译成对象根 JSON Schema。
 * @param {object} spec - 隐式属性表。
 * @returns {object} JSON Schema。
 */
export function parametersToJsonSchema(spec) {
  const compiled = compilePropertyMap(spec ?? {}, 'parameters');
  const schema = { type: 'object', properties: compiled.properties };
  if (compiled.required.length > 0) schema.required = compiled.required;
  return schema;
}

/**
 * 递归校验取值；把违规项写入 violations。
 * @param {object} schema - 已编译 schema。
 * @param {unknown} value - 待校验值。
 * @param {string} path - 诊断路径。
 * @param {string[]} violations - 违规收集器。
 */
function validateValue(schema, value, path, violations) {
  if (!schema || typeof schema !== 'object') return;

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.some((branch) => {
      const local = [];
      validateValue(branch, value, path, local);
      return local.length === 0;
    });
    if (!matched) violations.push(`${path || '参数'} 不匹配任何 oneOf 分支`);
    return;
  }

  const type = schema.type;
  if (!type) return;

  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`${path || '参数'} 必须是对象`);
      return;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${joinPath(path, key)} 为必填`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) {
        validateValue(sub, value[key], joinPath(path, key), violations);
      }
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${path || '参数'} 必须是数组`);
      return;
    }
    if (schema.items) {
      value.forEach((item, index) => validateValue(schema.items, item, `${path}[${index}]`, violations));
    }
    return;
  }

  if (type === 'integer' && !Number.isInteger(value)) {
    violations.push(`${path} 必须是整数`);
    return;
  }
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    violations.push(`${path} 必须是数字`);
    return;
  }
  if (type === 'string' && typeof value !== 'string') {
    violations.push(`${path} 必须是字符串`);
    return;
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    violations.push(`${path} 必须是布尔值`);
    return;
  }
  if (type === 'null' && value !== null) {
    violations.push(`${path} 必须为 null`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path} 必须是 ${schema.enum.join(' / ')} 之一`);
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    violations.push(`${path} 必须为 ${JSON.stringify(schema.const)}`);
  }
}

/**
 * 等价于 `@deepseek-ai/dsh-tools` 的 `defineTool`：编译参数 DSL、校验入参、
 * 产出注册表可直接消费的工具定义。
 *
 * @param {object} options - 工具定义。
 * @returns {object} 注册表可用的工具定义。
 */
export function defineTool(options) {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs 必须是正数`);
  }
  const parameters = parametersToJsonSchema(options.parameters);
  const outputSchema = compileValue(options.output?.schema ?? { type: 'json' }, 'output.schema');

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
      ...(options.output.presentationMeta
        ? { presentationMeta: (args, value) => options.output.presentationMeta(args, value) }
        : {}),
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      const violations = [];
      validateValue(parameters, args ?? {}, '', violations);
      if (violations.length > 0) {
        throw new Error(`参数校验失败：${violations.join('；')}`);
      }
      return options.execute(args, exec);
    },
    ...(options.presentCall ? { presentCall: (args) => options.presentCall(args) } : {}),
  };
}

/** 统一的输出 schema。 */
const OUTPUT_SCHEMA = { type: 'json', description: '返回 text（中文摘要）与 data（结构化数据）。' };

/**
 * 定义一个文本结果工具。
 *
 * @param {object} spec - 工具定义。
 * @param {string} spec.name - 工具名。
 * @param {string} spec.description - 面向模型的描述。
 * @param {object} spec.parameters - 参数 DSL（隐式属性表）。
 * @param {(args: object, exec: object) => Promise<{text: string, data?: unknown}>} spec.run - 执行体。
 * @param {string} [spec.kind] - UI 卡片类型。
 * @param {string} [spec.title] - UI 卡片标题。
 * @param {number} [spec.timeoutMs] - 单次调用超时。
 * @returns {object} 注册用的工具定义。
 */
export function textTool(spec) {
  const { name, description, parameters, run, kind = 'other', title, timeoutMs } = spec;
  return defineTool({
    name,
    description,
    parameters,
    ...(timeoutMs ? { timeoutMs } : {}),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value?.text ?? '(空结果)'),
    },
    async execute(args, exec) {
      const result = await run(args ?? {}, exec);
      return {
        text: result?.text ?? '(空结果)',
        data: result?.data ?? null,
      };
    },
    presentCall: (args) => ({ card: 'generic', title: title ?? name, kind, rawInput: args }),
  });
}

/**
 * 定义只读工具时复用的参数片段。
 * @param {string} description - 参数说明。
 * @param {boolean} [required] - 是否必填。
 * @returns {object} 参数节点。
 */
export function stringParam(description, required = false) {
  return required ? { type: 'string', required: true, description } : { type: 'string', description };
}

/** 整数参数节点。 */
export function intParam(description, required = false) {
  return required ? { type: 'integer', required: true, description } : { type: 'integer', description };
}

/** 布尔参数节点。 */
export function boolParam(description) {
  return { type: 'boolean', description };
}

/** 字符串数组参数节点。 */
export function stringListParam(description) {
  return { type: 'array', items: { type: 'string' }, description };
}

/** 所有写入工具共用的 `confirm` 参数说明。 */
export const CONFIRM_PARAM = {
  type: 'boolean',
  description: '必填且必须为 true：本操作会修改或删除 OpenProject 中的数据，用于二次确认。',
};

/**
 * 校验并返回一个正整数 ID。
 *
 * 模型可能漏传或传成 null/undefined，此时拼出的 URL 会变成 `/undefined`，
 * 服务端只会给出含糊的 404；这里提前给出明确的中文错误。
 *
 * @param {unknown} value - 待校验的值。
 * @param {string} label - 字段名，用于错误信息。
 * @returns {number} 校验通过的 ID。
 */
export function requireId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}必须是正整数 ID，实际收到 ${JSON.stringify(value ?? null)}。`);
  }
  return parsed;
}

/**
 * 归一化 `limit` 参数，避免模型传入过大或非法的值。
 * @param {unknown} value - 模型传入的值。
 * @param {number} fallback - 默认值。
 * @param {number} [ceiling] - 上限。
 * @returns {number} 合法条数。
 */
export function clampLimit(value, fallback, ceiling = 200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), ceiling);
}

/**
 * 渲染列表结果的中文表头。
 * @param {string} label - 资源名称。
 * @param {number} total - 总数。
 * @param {number} shown - 实际展示数。
 * @param {boolean} truncated - 是否被截断。
 * @returns {string} 表头文本。
 */
export function listHeader(label, total, shown, truncated) {
  if (total === 0) return `未找到符合条件的${label}。`;
  return truncated
    ? `共 ${total} 个${label}，已显示前 ${shown} 个（可用过滤条件缩小范围）：`
    : `共 ${total} 个${label}：`;
}
