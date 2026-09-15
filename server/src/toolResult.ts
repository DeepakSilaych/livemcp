import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
export function okText(text: string): CallToolResult { return { content: [{ type: 'text', text }] }; }
export function okJson(data: unknown): CallToolResult {
  const failed = data && typeof data === 'object' && 'error' in data;
  return { ...okText(typeof data === 'string' ? data : JSON.stringify(data)), ...(failed ? { isError: true } : {}) };
}
export function errText(message: string): CallToolResult { return { ...okText(message), isError: true }; }
export function imageResult(data: any): CallToolResult {
  const { screenshot, dataUrl, ...metadata } = data;
  const url = screenshot ?? dataUrl;
  if (!url) return okJson(metadata);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) return errText('Invalid screenshot data');
  return { content: [{ type: 'image', data: match[2], mimeType: match[1] }, { type: 'text', text: JSON.stringify(metadata) }] };
}
