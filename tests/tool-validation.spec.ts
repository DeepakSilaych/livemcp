import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server/src/mcp-server.js';

test('invalid batch observation budget never reaches the browser and corrected arguments remain usable', async () => {
  let dispatched = 0;
  const server = createMcpServer({ isConnected: () => true, close: async () => {}, request: async () => { dispatched++; return { completed: 1 }; } });
  const client = new Client({ name: 'validation-test', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    for (const maxChars of [12000,16000]) {
      const result = await client.callTool({ name:'run_browser_actions', arguments: { tabId:1,steps:[{action:'observe',maxChars}] } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('6000'); expect(dispatched).toBe(0);
    }
    const result = await client.callTool({ name:'run_browser_actions', arguments:{tabId:1,steps:[{action:'observe',maxChars:6000}]}});
    expect(result.isError).not.toBe(true); expect(dispatched).toBe(1);
  } finally { await client.close(); await server.close(); }
});

test('60-second readiness budgets leave time for hub and client transport grace', async()=>{
  const {executionBudget} = await import('../shared/src/protocol');
  expect(executionBudget('browser.wait',{timeout:60000})).toBeGreaterThan(60000);
  expect(executionBudget('browser.batch',{timeout:60000})).toBe(60000);
  expect(executionBudget('interact.click',{})).toBe(28000);
});
