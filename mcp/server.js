/**
 * OpenProject MCP Server（零依赖，stdio 传输）。
 *
 * 把本包的 CLI 命令层（cli/openproject.js）暴露成标准 MCP 工具，任何 MCP 客户端
 * （WorkBuddy、Claude Desktop、Claude Code、Cursor、Continue…）都能直接接入，
 * 支持在配置文件里配置多个实例，用 `instance` 参数指定打到哪个实例。
 *
 * 客户端配置示例：
 *   {
 *     "mcpServers": {
 *       "openproject": {
 *         "command": "node",
 *         "args": ["--no-warnings", "/绝对路径/mcp/server.js"],
 *         "env": { "OPENPROJECT_CONFIG": "/绝对路径/op.config.json" }
 *       }
 *     }
 *   }
 *
 * `--no-warnings` 用于屏蔽自签名证书实例触发的 TLS 告警（仅告警，不影响功能）。
 * 没有配置文件时也可只用 `OPENPROJECT_BASE_URL` + `OPENPROJECT_API_TOKEN` 两个环境变量。
 */

import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run, commands, loadConfig, configPath } from '../cli/openproject.js';

/** 版本号直接读 package.json，避免两处手改不同步。 */
const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);

const SERVER_INFO = { name: 'openproject-mcp', version: PKG.version };

/** 命令 → 工具描述。 */
const DESCRIPTIONS = {
  instances: '列出 op.config.json 中已配置的所有 OpenProject 实例（名称与地址）',
  whoami: '检查与指定实例的连接，返回当前账号信息',
  projects: '列出项目。参数：q（名称关键字）、limit',
  'wp-list': '查询工作包。参数：project、status（open/closed/all 或状态名）、assignee（me 或用户名）、type、q（标题关键字）、version、overdue=true、limit、sort',
  'wp-get': '查看工作包详情。参数：id（必填）',
  'wp-create': '创建工作包。参数：project（必填）、subject（必填）、type、status、priority、assignee、responsible、parent、version、desc、due、start、estimate、progress、dry=true 可先看预览',
  'wp-update': '更新工作包。参数：id（必填），其余同 wp-create（status/assignee/progress/due/desc 等）',
  'wp-comment': '给工作包添加评论。参数：id（必填）、text（必填）',
  'wp-delete': '删除工作包。参数：id（必填）、confirm=true（必填，二次确认）',
  'time-list': '列出工时记录。参数：project、wp、user、from、to、limit',
  'time-log': '登记工时。参数：wp（必填，工作包ID）、hours（必填）、date（YYYY-MM-DD，默认今天）、comment、activity',
  members: '列出项目成员及其角色。参数：project（必填）',
  versions: '列出项目版本。参数：project（必填）',
  dict: '列出字典数据。参数：what（statuses/types/priorities/activities/roles，必填）',
  users: '列出用户。参数：q（姓名关键字）、limit',
  raw: '直接调用 OpenProject API。参数：path（如 /api/v3/projects）、method（GET/POST/PATCH/DELETE）、body（JSON 字符串）',
};

function instanceNames() {
  try {
    const config = loadConfig();
    return Object.keys(config.instances || {});
  } catch {
    return [];
  }
}

function toolsList() {
  const names = instanceNames();
  const instanceProp = {
    type: 'string',
    description: names.length
      ? `实例名，可选：${names.join('、')}；省略则用配置的默认实例`
      : '实例名（尚未配置实例，请设置 op.config.json 或 OPENPROJECT_BASE_URL / OPENPROJECT_API_TOKEN）',
    ...(names.length ? { enum: names } : {}),
  };
  return Object.keys(commands).map((name) => ({
    name: `op_${name.replace(/-/g, '_')}`,
    description: DESCRIPTIONS[name] || `OpenProject 命令 ${name}`,
    inputSchema: {
      type: 'object',
      properties: {
        instance: instanceProp,
        args: {
          type: 'object',
          description: '命令参数对象，例如 {"project":"示例项目","limit":20}；也可以把参数直接写成工具的同级参数',
        },
      },
    },
  }));
}

async function callTool(name, params) {
  const cmd = name.replace(/^op_/, '').replace(/_/g, '-');
  // 兼容两种写法：{"instance":"lab","args":{...}} 与 {"instance":"lab","project":"x"}。
  const { instance, args, ...rest } = params || {};
  const merged = { ...(args && typeof args === 'object' ? args : {}), ...rest };
  // instances 无需实例名。
  const text = await run(instance, cmd, merged);
  return typeof text === 'string' ? text : JSON.stringify(text, null, 2);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request) {
  const { id, method, params } = request;
  const respond = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize': {
      const names = instanceNames();
      const where = configPath();
      respond({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: [
          '通过 OpenProject API v3 读写项目、工作包、工时、成员、版本与附件。',
          names.length
            ? `已配置实例：${names.join('、')}；每次调用用 instance 参数指定目标实例。`
            : '尚未配置实例：请设置 op.config.json，或环境变量 OPENPROJECT_BASE_URL / OPENPROJECT_API_TOKEN。',
          where ? `配置文件：${where}` : '配置文件：未使用（走环境变量）。',
          '写入类操作（wp-create / wp-update / wp-delete / time-log）支持 dry=true 先预览；删除需 confirm=true。',
        ].join('\n'),
      });
      return;
    }
    case 'notifications/initialized':
    case 'initialized':
      return; // 通知类不回包
    case 'tools/list':
      respond({ tools: toolsList() });
      return;
    case 'tools/call': {
      const name = params?.name;
      if (!name) {
        fail(-32602, '缺少 params.name');
        return;
      }
      callTool(name, params.arguments || {})
        .then((text) => respond({ content: [{ type: 'text', text }], isError: false }))
        .catch((error) => respond({
          content: [{ type: 'text', text: `错误：${error?.message || error}` }],
          isError: true,
        }));
      return;
    }
    case 'ping':
      respond({});
      return;
    default:
      if (id === undefined) return; // 未知通知，忽略
      fail(-32601, `不支持的方法：${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch (error) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `解析失败：${error.message}` } });
  }
});
