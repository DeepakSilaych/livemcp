import { test, expect } from '@playwright/test';
// evaluate accepts one argument; install the exact runtime function compiled by esbuild.
import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
const source = transformSync(readFileSync('extension/src/pageRuntime.ts', 'utf8'), { loader: 'ts', format: 'iife', globalName: 'LiveRuntime', target: 'es2022' }).code;
async function invoke(page: any, command: string, args: any = {}) { return page.evaluate(({ command, args }: any) => (window as any).LiveRuntime.pageRuntime(command, args).then((r: any) => { if (r.__livemcpError) throw new Error(r.__livemcpError); return r; }), { command, args }); }
test.beforeEach(async ({ page }) => { await page.goto('about:blank'); await page.addScriptTag({ content: source }); });

test('persistent references, hidden filtering, password redaction and unique selection', async ({ page }) => {
  await page.setContent('<button>One</button><button>Two</button><button hidden>Secret</button><input type="password" value="secret-value">');
  const first = await invoke(page, 'observe');
  expect(JSON.stringify(first)).not.toContain('secret-value'); expect(JSON.stringify(first)).not.toContain('Secret');
  const second = await invoke(page, 'observe'); expect(second.nodes.map((n: any) => n.ref)).toEqual(first.nodes.map((n: any) => n.ref));
  await expect(invoke(page, 'click', { selector: 'button' })).rejects.toThrow('AMBIGUOUS_SELECTOR');
  const ref = first.nodes.find((n: any) => n.text.includes('Two')).ref;
  await page.evaluate(() => document.querySelectorAll('button')[1].addEventListener('click', () => document.body.dataset.clicked = 'two'));
  await invoke(page, 'click', { selector: ref }); expect(await page.locator('body').getAttribute('data-clicked')).toBe('two');
  await page.locator('button').nth(1).evaluate(el => el.remove());
  await expect(invoke(page, 'click', { selector: ref })).rejects.toThrow('STALE_REF');
});

test('shadow roots and aria-labelledby produce actionable controls', async ({ page }) => {
  await page.setContent('<div id="host"></div>');
  await page.evaluate(() => document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = '<span id="label">Shadow choice</span><button aria-labelledby="label">x</button>');
  const state = await invoke(page, 'observe'); const item = state.nodes.find((n: any) => n.text.includes('Shadow choice'));
  expect(item).toBeTruthy(); expect((await invoke(page, 'click', { selector: item.ref })).performed).toBe(true);
});

test('single-form ownership, native setters, field validation and preflight', async ({ page }) => {
  await page.setContent('<form id="wrong"><input id="wrong-field"></form><form id="right"><input id="a" required><input id="b"><input id="check" type="checkbox"></form>');
  await page.evaluate(() => {
    (window as any).submissions = [];
    for (const form of document.forms) form.addEventListener('submit', e => { e.preventDefault(); (window as any).submissions.push(form.id); });
    const el = document.querySelector('#a')!;
    Object.defineProperty(el, 'value', { set() { throw new Error('instance setter should not run'); }, get() { return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!.call(this); } });
  });
  await expect(invoke(page, 'fill', { fields: [{ selector: '#a', value: 'hello' }, { selector: '#missing', value: 'x' }] })).rejects.toThrow('NOT_FOUND');
  expect(await page.locator('#a').inputValue()).toBe('');
  await expect(invoke(page, 'fill', { fields: [{ selector: '#a', value: 'hello' }, { selector: '#wrong-field', value: 'x' }], submit: true })).rejects.toThrow('AMBIGUOUS_FORM');
  const result = await invoke(page, 'fill', { fields: [{ selector: '#a', value: 'hello' }, { selector: '#check', value: 'true' }], submit: true });
  expect(result.submitted).toBe(true); expect(await page.evaluate(() => (window as any).submissions)).toEqual(['right']); expect(await page.locator('#check').isChecked()).toBe(true);
});

test('visible wait handles attribute changes and times out', async ({ page }) => {
  await page.setContent('<div id="modal" hidden>Ready</div>');
  await page.evaluate(() => setTimeout(() => document.querySelector('#modal')!.removeAttribute('hidden'), 80));
  expect((await invoke(page, 'wait', { selector: '#modal', timeout: 1000 })).ready).toBe(true);
  await expect(invoke(page, 'wait', { selector: '#absent', timeout: 50 })).rejects.toThrow('WAIT_TIMEOUT');
});

test('bounded observations page forward and deltas include removals and order', async ({ page }) => {
  await page.setContent(Array.from({ length: 100 }, (_, i) => `<button>Choice ${i}</button>`).join(''));
  const first = await invoke(page, 'observe', { maxNodes: 3 }); expect(first.nodes).toHaveLength(3); expect(first.truncated).toBe(true); expect(first.nextOffset).toBe(3);
  const next = await invoke(page, 'observe', { maxNodes: 3, offset: first.nextOffset }); expect(next.nodes[0].text).toContain('Choice 3');
  await page.locator('button').first().evaluate(el => el.remove());
  const delta = await invoke(page, 'observe', { maxNodes: 3, since: first.version }); expect(delta.mode).toBe('delta'); expect(delta.removed).toContain(first.nodes[0].ref); expect(delta.order).toHaveLength(3);
  expect((await invoke(page, 'observe', { since: 'expired' })).reset).toBe(true);
});

test('prose paging and display:contents descendants', async ({ page }) => {
  await page.setContent('<div style="display:contents"><button>Reachable</button></div><p>' + 'article '.repeat(1000) + '</p>');
  expect(JSON.stringify(await invoke(page, 'observe'))).toContain('Reachable');
  const content = await invoke(page, 'content', { format: 'text', selector: 'p', maxChars: 500 });
  expect(content.text).toHaveLength(500); expect(content.nextOffset).toBe(500); expect(content.truncated).toBe(true);
});

test('references fail after document replacement', async ({ page }) => {
  await page.setContent('<button>Old</button>'); const before = await invoke(page, 'observe');
  await page.goto('data:text/html,<button>New</button>'); await page.addScriptTag({ content: source });
  const after = await invoke(page, 'observe'); expect(after.documentId).not.toBe(before.documentId);
  await expect(invoke(page, 'click', { selector: before.nodes[0].ref })).rejects.toThrow('STALE_REF');
});

test('unchanged delta materially reduces serialized context on a large fixture', async ({ page }) => {
  await page.setContent(Array.from({ length: 120 }, (_, i) => `<button id="item-${i}">Select record ${i}</button>`).join(''));
  const full = await invoke(page, 'observe'); const delta = await invoke(page, 'observe', { since: full.version });
  const fullBytes = Buffer.byteLength(JSON.stringify(full)), deltaBytes = Buffer.byteLength(JSON.stringify(delta));
  expect(delta.nodes).toHaveLength(0); expect(delta.order).toBeUndefined(); expect(deltaBytes).toBeLessThan(fullBytes / 5);
  console.log(JSON.stringify({ measurement: 'unchanged-observation', fullBytes, deltaBytes, reductionPercent: Math.round(100 * (1 - deltaBytes / fullBytes)) }));
});


test('hidden pre-rendered modal does not hide the main page observation', async ({ page }) => {
  await page.setContent('<div role="dialog" aria-modal="true" hidden><button>Hidden modal</button></div><button>Main action</button>');
  const result = await invoke(page, 'observe'); expect(JSON.stringify(result)).toContain('Main action'); expect(JSON.stringify(result)).not.toContain('Hidden modal');
});
