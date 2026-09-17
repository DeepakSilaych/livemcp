import { command, ensureDebugger } from '../debuggerSession.js';
import { afterAction, runPage } from '../observation.js';
import { resolveTabSpec, type TabSpec } from '../chromeApi.js';

function mainFrame(params: Record<string, unknown>) {
  if (params.frameId && params.frameId !== 0) throw new Error('TRUSTED_INPUT_FRAME_UNSUPPORTED: Trusted pointer input currently targets the main frame. Use mode="dom" for frame-local click/type.');
}
export async function trustedClick(params: Record<string, unknown>): Promise<any> {
  let tabId: number, target: any;
  try {
    mainFrame(params); tabId = await resolveTabSpec(params as TabSpec);
    await ensureDebugger(tabId);
    target = await runPage({ ...params, tabId }, 'prepareInput');
  } catch (e) { return { error: String(e), code: 'INPUT_PREFLIGHT', actionMayHaveOccurred: false }; }
  try {
    await command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
    await command(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
    await command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
    return { performed: true, method: 'cdp', tabId, ref: target.ref };
  } catch (e) { return { tabId, error: String(e), code: 'INPUT_FAILED', actionMayHaveOccurred: true }; }
}
const keys: Record<string, [string,number,string?]> = {
  Enter: ['Enter',13,'\r'], Tab: ['Tab',9], Escape: ['Escape',27], ArrowDown: ['ArrowDown',40], ArrowUp: ['ArrowUp',38], ArrowLeft: ['ArrowLeft',37], ArrowRight: ['ArrowRight',39], Backspace: ['Backspace',8], Delete: ['Delete',46], Home: ['Home',36], End: ['End',35], Space: ['Space',32,' '],
};
export async function sendKey(tabId: number, key: string, modifiers = 0) {
  const spec = keys[key] ?? (key.length === 1 ? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), key] as [string,number,string] : undefined);
  if (!spec) throw new Error('INVALID_KEY: Use Enter, Tab, Escape, arrows, editing keys, Space or a single character.');
  const [code, windowsVirtualKeyCode, text] = spec;
  const base = { key: key === 'Space' ? ' ' : key, code, windowsVirtualKeyCode, modifiers };
  await command(tabId, 'Input.dispatchKeyEvent', { ...base, type: text && !(modifiers & 14) ? 'keyDown' : 'rawKeyDown', ...(text && !(modifiers & 14) ? { text, unmodifiedText: text } : {}) });
  await command(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}
export async function pressKey(params: Record<string, unknown>) {
  mainFrame(params);
  const tabId = await resolveTabSpec(params as TabSpec);
  // Validate the key before focusing a target.
  const key = String(params.key);
  if (!keys[key] && key.length !== 1) throw new Error('INVALID_KEY: Unsupported key.');
  await ensureDebugger(tabId);
  if (params.selector) await runPage({ ...params, tabId, focus: true }, 'prepareInput');
  await sendKey(tabId, key, Number(params.modifiers ?? 0));
  return afterAction(params, { tabId, performed: true, method: 'cdp', key });
}
export async function trustedType(params: Record<string, unknown>) {
  mainFrame(params);
  const tabId = await resolveTabSpec(params as TabSpec);
  await ensureDebugger(tabId);
  const target = await runPage({ ...params, tabId, focus: true }, 'prepareInput');
  if (target.readOnly && !params.allowReadonly) throw new Error('READ_ONLY: Use allowReadonly=true with mode="trusted" only for a custom picker that handles keys.');
  if (params.clear) { await sendKey(target.tabId, 'a', /Mac/.test(navigator.platform) ? 4 : 2); await sendKey(target.tabId, 'Backspace'); }
  // Key events let readonly pickers handle input without changing their readonly attribute.
  if (target.readOnly || params.inputMethod === 'keys') {
    for (const character of String(params.text)) {
      if (Date.now() >= Number(params.__deadline ?? Infinity)) throw new Error('INPUT_TIMEOUT: Typing may be partially complete; inspect field state.');
      await sendKey(target.tabId, character);
    }
  } else await command(target.tabId, 'Input.insertText', { text: String(params.text) });
  return afterAction(params, { tabId: target.tabId, performed: true, method: 'cdp', readOnly: target.readOnly });
}
export async function selectOption(params: Record<string, unknown>) {
  const option = await runPage(params, 'findOption');
  const result = option.performed ? option : await trustedClick({ ...params, selector: option.selector });
  return afterAction(params, result);
}
