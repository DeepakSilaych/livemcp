/** Keep the full endpoint, including reverse-proxy paths and query parameters. */
export function normalizeConnectionUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('Enter your server URL.');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Enter a full URL, such as wss://bridge.example.com/browser.'); }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname) throw new Error('Use a ws://, wss://, http:// or https:// URL.');
  if (url.hash || url.username || url.password) throw new Error('The server URL cannot contain a fragment or embedded username/password.');
  return url.href;
}
export function savedConnectionUrl(store: { wsUrl?: unknown; wsPort?: unknown }): string {
  if (typeof store.wsUrl === 'string') return store.wsUrl;
  // Preserve explicitly saved settings from the port-based extension.
  if (typeof store.wsPort === 'number' && Number.isInteger(store.wsPort) && store.wsPort > 0 && store.wsPort < 65536) return `ws://127.0.0.1:${store.wsPort}/`;
  return '';
}
