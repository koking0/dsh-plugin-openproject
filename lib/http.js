/**
 * 零依赖 HTTP 客户端。
 *
 * 直接使用 `node:http` / `node:https`，因为 DSH 插件运行环境中并不保证存在
 * 可导入的 undici，而 OpenProject 自建实例通常使用自签名证书 —— 只有自建
 * Agent 才能精确控制 `rejectUnauthorized`。
 *
 * @module dsh-plugin-openproject/lib/http
 */

import http from 'node:http';
import https from 'node:https';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** 传输层或 HTTP 状态层失败。 */
export class HttpError extends Error {
  /**
   * @param {string} message - 面向模型的可读中文说明。
   * @param {object} [details] - 诊断上下文。
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'HttpError';
    Object.assign(this, details);
  }
}

/** 把查询值序列化为 OpenProject 期望的形式（对象/数组转 JSON 字符串）。 */
function serializeQueryValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** 拼接查询串，跳过 undefined / null。 */
export function buildQueryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    params.append(key, serializeQueryValue(value));
  }
  return params.toString();
}

/** 发出一次原始请求，不做重定向与解析。 */
function rawRequest(method, url, options) {
  const { headers, body, rejectUnauthorized, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new HttpError(`无效的 URL：${url}`, { url, method }));
      return;
    }
    const lib = target.protocol === 'http:' ? http : https;
    const requestOptions = {
      method,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      headers,
    };
    // 仅 https 需要 TLS 选项；自签名实例依赖这里放行。
    if (target.protocol === 'https:') requestOptions.rejectUnauthorized = rejectUnauthorized;

    const req = lib.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', (error) => reject(new HttpError(`读取响应失败：${error.message}`, { url, method })));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new HttpError(`请求超时（${timeoutMs}ms）：${method} ${url}`, { url, method }));
    });
    req.on('error', (error) => {
      if (error instanceof HttpError) {
        reject(error);
        return;
      }
      const hint = error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.code === 'SELF_SIGNED_CERT_IN_CHAIN'
        ? '（自签名证书被拒绝：把 config.rejectUnauthorized 设为 false，或为该实例安装受信任证书）'
        : '';
      reject(new HttpError(`连接 OpenProject 失败：${error.message}${hint}`, { url, method, code: error.code }));
    });

    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

/** 跟随重定向。303 与其他 301/302 的语义差异按 HTTP 规范处理。 */
async function send(method, url, options, redirects = 0) {
  const response = await rawRequest(method, url, options);
  const location = response.headers.location;
  if (REDIRECT_STATUS.has(response.status) && location && redirects < MAX_REDIRECTS) {
    const nextUrl = new URL(location, url).toString();
    const nextMethod = response.status === 303 ? 'GET' : method;
    const nextOptions = nextMethod === method ? options : { ...options, body: undefined };
    return send(nextMethod, nextUrl, nextOptions, redirects + 1);
  }
  return response;
}

/** 解析响应体中的错误信息，尽量给出 OpenProject 的原生结论。 */
function describeFailure(response) {
  const text = response.body.toString('utf8');
  if (!text) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text);
    const parts = [];
    if (parsed.message) parts.push(String(parsed.message).trim());
    if (parsed.errorIdentifier) parts.push(`[${parsed.errorIdentifier}]`);
    // 表单校验失败时 errors 是 { 字段: { message } } 结构。
    if (parsed.errors && typeof parsed.errors === 'object') {
      for (const [field, detail] of Object.entries(parsed.errors)) {
        const message = detail && typeof detail === 'object' ? detail.message : detail;
        if (message) parts.push(`${field}：${String(message).trim()}`);
      }
    }
    if (parts.length > 0) return parts.join(' ');
  } catch {
    // 非 JSON 响应（例如 nginx 的 HTML 错误页）走原文兜底。
  }
  return text.slice(0, 500);
}

/**
 * 创建绑定到单个 OpenProject 实例的 HTTP 客户端。
 *
 * @param {object} options - 连接参数。
 * @param {number} [options.timeoutMs] - 单次请求超时。
 * @param {boolean} [options.rejectUnauthorized] - 是否校验 TLS 证书。
 * @returns {object} 具备 json / buffer / multipart 三类调用的客户端。
 */
export function createHttpClient({ timeoutMs = 30000, rejectUnauthorized = true } = {}) {
  /** 发起 JSON 请求并解析响应。 */
  async function json(method, url, { query, body, headers = {}, accept = 'application/json' } = {}) {
    const queryString = buildQueryString(query);
    const fullUrl = queryString ? `${url}${url.includes('?') ? '&' : '?'}${queryString}` : url;
    const requestHeaders = { accept, ...headers };
    let payload;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      requestHeaders['content-type'] = 'application/json; charset=utf-8';
      requestHeaders['content-length'] = String(payload.byteLength);
    }
    const response = await send(method, fullUrl, {
      headers: requestHeaders,
      body: payload,
      rejectUnauthorized,
      timeoutMs,
    });
    const contentType = String(response.headers['content-type'] ?? '');
    let data;
    if (contentType.includes('json')) {
      const text = response.body.toString('utf8');
      data = text.length > 0 ? JSON.parse(text) : null;
    } else {
      data = response.body.toString('utf8');
    }
    if (response.status >= 400) {
      throw new HttpError(`OpenProject 请求失败（HTTP ${response.status}）：${describeFailure(response)}`, {
        status: response.status,
        url: fullUrl,
        method,
        data,
      });
    }
    return { data, status: response.status, headers: response.headers };
  }

  /** 下载二进制内容。 */
  async function buffer(method, url, { headers = {} } = {}) {
    const response = await send(method, url, {
      headers: { accept: '*/*', ...headers },
      rejectUnauthorized,
      timeoutMs: Math.max(timeoutMs, 120000),
    });
    if (response.status >= 400) {
      throw new HttpError(`下载失败（HTTP ${response.status}）：${describeFailure(response)}`, {
        status: response.status,
        url,
        method,
      });
    }
    return {
      data: response.body,
      filename: parseFilename(response.headers['content-disposition']),
      contentType: String(response.headers['content-type'] ?? 'application/octet-stream'),
    };
  }

  /** 上传 multipart/form-data（OpenProject 附件接口的固定形态）。 */
  async function multipart(method, url, { fields = {}, file, headers = {} } = {}) {
    const boundary = `----dshOpenProject${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n`
        + 'Content-Type: application/json; charset=utf-8\r\n\r\n'
        + `${typeof value === 'string' ? value : JSON.stringify(value)}\r\n`,
        'utf8',
      ));
    }
    if (file) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${encodeURIComponent(file.filename)}"\r\n`
        + `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`,
        'utf8',
      ));
      parts.push(file.data);
      parts.push(Buffer.from('\r\n', 'utf8'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    const payload = Buffer.concat(parts);
    const response = await send(method, url, {
      headers: {
        accept: 'application/json',
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(payload.byteLength),
        ...headers,
      },
      body: payload,
      rejectUnauthorized,
      timeoutMs: Math.max(timeoutMs, 120000),
    });
    const text = response.body.toString('utf8');
    let data = null;
    try {
      data = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (response.status >= 400) {
      throw new HttpError(`上传失败（HTTP ${response.status}）：${describeFailure(response)}`, {
        status: response.status,
        url,
        method,
        data,
      });
    }
    return { data, status: response.status };
  }

  return { json, buffer, multipart };
}

/** 从 Content-Disposition 中取出文件名。 */
function parseFilename(header) {
  if (!header) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      return utf8[1].trim();
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : undefined;
}
