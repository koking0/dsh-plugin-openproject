#!/usr/bin/env node
/**
 * OpenProject CLI 可执行入口（多实例）。
 *
 * 安装后可直接：
 *   openproject instances
 *   openproject <实例名> wp-list --project=示例项目 --status=open --limit=20
 *   openproject <实例名> wp-create --json='{"project":"示例项目","subject":"新任务"}'
 *
 * 等价于 `node cli/openproject.js ...`，只是省去路径与 node 前缀。
 */

import { main } from '../cli/openproject.js';

main().catch((error) => {
  process.stderr.write(`错误：${error?.message || error}\n`);
  if (process.env.OP_DEBUG === '1') process.stderr.write(`${error?.stack}\n`);
  process.exitCode = 1;
});
