import { test, expect } from '@playwright/test';
import { normalizeConnectionUrl, savedConnectionUrl } from '../extension/src/connectionUrl';
test('full endpoints preserve host, paths, query and TLS', () => {
  expect(normalizeConnectionUrl(' wss://bridge.example.com/browser?key=abc ')).toBe('wss://bridge.example.com/browser?key=abc');
  expect(normalizeConnectionUrl('https://bridge.example.com/browser')).toBe('wss://bridge.example.com/browser');
  expect(normalizeConnectionUrl('http://[::1]:17691/path')).toBe('ws://[::1]:17691/path');
  expect(normalizeConnectionUrl('ws://192.168.1.12:9000')).toBe('ws://192.168.1.12:9000/');
});
test('new installs do not assume localhost; saved ports remain compatible', () => {
  expect(savedConnectionUrl({})).toBe('');
  expect(savedConnectionUrl({ wsPort: 19000 })).toBe('ws://127.0.0.1:19000/');
  expect(savedConnectionUrl({ wsPort: 19000, wsUrl: 'wss://remote.test/path' })).toBe('wss://remote.test/path');
  expect(savedConnectionUrl({ wsPort: 1.5 })).toBe('');
});
test('invalid endpoint formats fail before touching connection state', () => {
  for (const value of ['', 'localhost:17691', 'ftp://host/file', 'wss://user:pass@host/', 'wss://host/#fragment', 'file:///path']) expect(() => normalizeConnectionUrl(value)).toThrow();
});
