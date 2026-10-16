#!/usr/bin/env node
/**
 * OpenProject MCP Server 可执行入口（stdio 传输）。
 *
 * 任何 MCP 客户端都可以用 `openproject-mcp`（或 `npx -y @liu_zhao_feng_alex/dsh-plugin-openproject`
 * 的 bin）拉起本服务：
 *   { "mcpServers": { "openproject": { "command": "openproject-mcp" } } }
 */

import '../mcp/server.js';
