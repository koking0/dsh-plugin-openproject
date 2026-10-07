/**
 * 附件域工具：上传、列举、下载与删除。
 *
 * 下载走附件资源的 `downloadLocation` 链接，而不是拼 `/content` 路径 —— 该链接由
 * 服务端给出，随版本变化也保持正确。
 *
 * @module dsh-plugin-openproject/lib/tools/attachments
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { textTool, stringParam, intParam, clampLimit, listHeader, requireId } from './common.js';
import { fmt, truncate, dateOnly } from '../format.js';

/** 把相对路径解析成绝对路径并报告。 */
function toAbsolute(path) {
  const raw = String(path);
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/** 把字节数渲染成易读大小。 */
function sizeText(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / 104857.6) / 10} MB`;
}

/** 附件摘要。 */
function brief(attachment) {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    fileSizeText: sizeText(attachment.fileSize),
    contentType: attachment.contentType ?? null,
    description: attachment.description?.raw ?? '',
    author: attachment._links?.author?.title ?? null,
    container: attachment._links?.container?.title ?? null,
    createdAt: dateOnly(attachment.createdAt),
    downloadUrl: attachment._links?.downloadLocation?.href ?? null,
  };
}

/**
 * 注册附件域工具。
 * @param {object} ctx - 插件上下文。
 * @param {object} deps - 依赖。
 */
export function registerAttachmentTools(ctx, deps) {
  const { api, guard } = deps;

  ctx.tools.register(textTool({
    name: 'openproject_upload_attachment',
    description: '把本地文件作为附件上传到指定工作包。filePath 必须是本机可读的绝对路径或相对工作目录的路径。',
    kind: 'edit',
    title: '上传附件到工作包',
    parameters: {
      workPackage: intParam('目标工作包 ID。', true),
      filePath: stringParam('本地文件路径。', true),
      fileName: stringParam('上传后在 OpenProject 中显示的文件名；省略时使用原文件名。'),
      description: stringParam('附件说明。'),
    },
    async run(args) {
      const id = requireId(args.workPackage, 'workPackage');
      const current = await api.request.get(`/api/v3/work_packages/${id}`);
      const project = await api.request.get(`/api/v3/projects/${api.idFromHref(api.hrefOf(current, 'project'))}`);
      guard.assertProjectWritable(project);
      guard.assertConfirm(args, '上传附件');

      const absolute = toAbsolute(args.filePath);
      let info;
      try {
        info = await stat(absolute);
      } catch {
        throw new Error(`本地文件不存在或不可读：${absolute}`);
      }
      if (!info.isFile()) throw new Error(`路径不是文件：${absolute}`);
      const data = await readFile(absolute);
      const filename = String(args.fileName ?? absolute.split(/[\\/]/).pop());

      const metadata = { fileName: filename };
      if (args.description) metadata.description = { raw: String(args.description) };

      const response = await api.request.upload(`/api/v3/work_packages/${id}/attachments`, {
        fields: { metadata },
        file: { field: 'file', filename, data, contentType: 'application/octet-stream' },
      });
      const attachment = brief(response);
      return {
        text: `已上传附件 ${attachment.fileName}（${attachment.fileSizeText}）到工作包 #${id}，附件 ID ${attachment.id}。`,
        data: attachment,
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_list_attachments',
    description: '列出某个工作包的附件。',
    kind: 'read',
    title: '查看工作包附件',
    parameters: {
      workPackage: intParam('工作包 ID。', true),
      limit: intParam('最多返回多少条，默认 50。'),
    },
    async run(args) {
      const id = requireId(args.workPackage, 'workPackage');
      const page = await api.paginate(`/api/v3/work_packages/${id}/attachments`, {
        maxItems: clampLimit(args.limit, 50),
      });
      const attachments = page.elements.map(brief);
      const lines = [listHeader('附件', page.total, attachments.length, page.truncated)];
      for (const attachment of attachments) {
        lines.push(`- #${attachment.id} ${attachment.fileName}（${attachment.fileSizeText}）`
          + `${attachment.author ? `｜上传者 ${attachment.author}` : ''}${attachment.createdAt ? `｜${attachment.createdAt}` : ''}`
          + `${attachment.description ? `｜${truncate(attachment.description, 120)}` : ''}`);
      }
      return { text: lines.join('\n'), data: attachments };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_download_attachment',
    description: '把附件下载到本地文件。targetPath 为绝对路径或相对路径；父目录会自动创建。',
    kind: 'fetch',
    title: '下载 OpenProject 附件',
    parameters: {
      attachment: intParam('附件 ID（可由 openproject_list_attachments 获取）。', true),
      targetPath: stringParam('保存到本地的路径。', true),
    },
    timeoutMs: 120000,
    async run(args) {
      const id = requireId(args.attachment, 'attachment');
      const attachment = await api.request.get(`/api/v3/attachments/${id}`);
      const downloadHref = api.hrefOf(attachment, 'downloadLocation');
      if (!downloadHref) throw new Error(`附件 #${id} 没有提供下载链接，可能已被删除或无权访问。`);
      const url = downloadHref.startsWith('http') ? downloadHref : `${api.root}${downloadHref}`;
      const { data, filename } = await api.request.download(url);
      const absolute = toAbsolute(args.targetPath);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, data);
      const briefAttachment = brief(attachment);
      return {
        text: `已下载附件 #${id} ${fmt(briefAttachment.fileName)} 到 ${absolute}（${sizeText(data.byteLength)}）。`,
        data: { ...briefAttachment, savedTo: absolute, bytes: data.byteLength, serverFilename: filename ?? null },
      };
    },
  }));

  ctx.tools.register(textTool({
    name: 'openproject_delete_attachment',
    description: '永久删除一个附件。必须带 confirm: true。',
    kind: 'delete',
    title: '删除附件',
    parameters: {
      attachment: intParam('附件 ID。', true),
      confirm: { type: 'boolean', required: true, description: '必须为 true，确认永久删除。' },
    },
    async run(args) {
      const id = requireId(args.attachment, 'attachment');
      guard.assertDestructive(args, '删除附件');
      const attachment = await api.request.get(`/api/v3/attachments/${id}`);
      const containerHref = api.hrefOf(attachment, 'container');
      if (containerHref && containerHref.includes('/work_packages/')) {
        const workPackageId = api.idFromHref(containerHref);
        const workPackage = await api.request.get(`/api/v3/work_packages/${workPackageId}`);
        const project = await api.request.get(`/api/v3/projects/${api.idFromHref(api.hrefOf(workPackage, 'project'))}`);
        guard.assertProjectWritable(project);
      }
      const briefAttachment = brief(attachment);
      await api.request.remove(`/api/v3/attachments/${id}`);
      return { text: `已删除附件 #${id} ${fmt(briefAttachment.fileName)}。`, data: { id, deleted: true } };
    },
  }));
}
