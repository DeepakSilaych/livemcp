/** Runs in Chrome's isolated world. References survive calls, never navigations. */
export async function pageRuntime(command: string, args: Record<string, any>): Promise<any> {
 try {
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
  const host = globalThis as any;
  const state = host.__livemcpV2 ??= {
    documentId: uid(), next: 0, ids: new WeakMap<Element, string>(),
    elements: new Map<string, Element>(), snapshots: new Map<string, any>(), revision: 0,
  };
  state.anchors ??= new Map();
  if (!state.observer) {
    state.observer = new MutationObserver(() => state.revision++);
    state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    state.watched = new WeakSet();
    for (const event of ['input', 'change', 'scroll']) document.addEventListener(event, () => state.revision++, true);
  }
  const visible = (el: Element): boolean => {
    for (let p: Element | null = el; p; p = p.parentElement ?? (p.getRootNode() as ShadowRoot).host ?? null) {
      const s = getComputedStyle(p);
      if (p.hasAttribute('hidden') || p.getAttribute('aria-hidden') === 'true' || s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    }
    return el.getClientRects().length > 0;
  };
  let cachedRoots: (Document | ShadowRoot)[] | undefined;
  const roots = (): (Document | ShadowRoot)[] => {
    if (cachedRoots && command !== "wait") return cachedRoots;
    const result: (Document | ShadowRoot)[] = [document];
    for (let i = 0; i < result.length; i++) {
      for (const el of result[i].querySelectorAll('*')) if (el.shadowRoot) result.push(el.shadowRoot);
    }
    cachedRoots = result; return result;
  };
  const validateSelector = (selector: string) => {
    if (typeof selector !== 'string' || !selector.trim()) throw new Error('INVALID_SELECTOR: Use a nonempty native CSS selector or an observed @ref.');
    if (selector.startsWith('@')) return;
    try { document.createDocumentFragment().querySelector(selector); }
    catch { throw new Error('INVALID_SELECTOR: Use native CSS or an observed @ref. Playwright selectors such as :has-text() and text= are unsupported. Read get_page_snapshot and use the returned ref.'); }
  };
  if (command === 'validateSelectors') {
    for (const selector of args.selectors ?? []) validateSelector(selector);
    return { validated: true };
  }
  const matches = (selector: string): Element[] => { validateSelector(selector); return roots().flatMap(root => Array.from(root.querySelectorAll(selector))); };
  const resolve = (selector: string): Element => {
    if (selector.startsWith('@')) {
      let el = state.elements.get(selector);
      if (el && !el.isConnected && state.anchors.has(selector)) {
        const a = state.anchors.get(selector);
        const candidates = matches(a.selector).filter(e => e.tagName === a.tag && e.getAttribute('type') === a.type && name(e) === a.name);
        if (candidates.length === 1) { el = candidates[0]; state.elements.set(selector, el); state.ids.set(el, selector); }
      }
      if (!el?.isConnected) throw new Error('STALE_REF: Refresh the observation and use a current reference.');
      return el;
    }
    const found = matches(selector);
    if (found.length !== 1) throw new Error(found.length ? `AMBIGUOUS_SELECTOR: ${found.length} matches; use an @ref.` : `NOT_FOUND: ${selector}`);
    return found[0];
  };
  const ref = (el: Element): string => {
    let id = state.ids.get(el);
    if (!id) {
      if (state.elements.size >= 10000) {
        for (const [key, value] of state.elements) if (!value.isConnected) { state.elements.delete(key); state.anchors.delete(key); }
        if (state.elements.size >= 10000) throw new Error('REFERENCE_LIMIT: Reload this document to reset references.');
      }
      id = `@${state.documentId}:${++state.next}`;
      state.ids.set(el, id); state.elements.set(id, el);
      for (const attr of ['id', 'data-testid', 'name']) {
        const value = el.getAttribute(attr); if (!value) continue;
        const selector = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(value)}"]`;
        if (matches(selector).length === 1) { state.anchors.set(id, { selector, tag: el.tagName, type: el.getAttribute('type'), name: name(el) }); break; }
      }
    }
    return id;
  };
  const name = (el: Element): string => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map(id => root.querySelector(`#${CSS.escape(id)}`)?.textContent ?? '').join(' ').trim();
    return (labelled || el.getAttribute('aria-label') || Array.from((el as HTMLInputElement).labels ?? []).map(l => l.textContent).join(' ') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  };
  const role = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return ['checkbox', 'radio', 'range'].includes((el as HTMLInputElement).type) ? (el as HTMLInputElement).type : ['submit', 'reset', 'button'].includes((el as HTMLInputElement).type) ? 'button' : 'textbox';
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return ({ a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', dialog: 'dialog', main: 'main', nav: 'navigation', form: 'form', table: 'table', tr: 'row', th: 'columnheader', td: 'cell', p: 'text', li: 'listitem', iframe: 'frame' } as Record<string, string>)[tag] ?? '';
  };
  const check = (el: Element) => {
    if (!visible(el)) throw new Error('NOT_VISIBLE: Refresh or scroll to the target.');
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') throw new Error('DISABLED: Target is disabled.');
  };
  const valueOf = (el: any) => el.type === 'password' ? '[redacted]' : el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.isContentEditable ? el.textContent : el.value;
  if (command === 'identity') return { documentId: state.documentId, url: location.href, title: document.title, readyState: document.readyState, revision: state.revision };
  if (command === 'wait') {
    const timeout = Math.min(60000, Math.max(1, args.timeout ?? 5000));
    return new Promise((done, reject) => {
      let observer: MutationObserver | undefined, timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
      const cleanup = () => { observer?.disconnect(); clearTimeout(timer); clearInterval(poll); };
      const test = () => {
        try {
          const found = args.selector.startsWith('@') ? [resolve(args.selector)] : matches(args.selector);
          if (found.some(visible)) { cleanup(); done({ ready: true, documentId: state.documentId }); return true; }
        } catch (e) { cleanup(); reject(e); return true; }
        return false;
      };
      if (test()) return;
      observer = new MutationObserver(test); observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      poll = setInterval(test, 100); // Includes shadow-tree and CSS/animation-only changes.
      timer = setTimeout(() => { cleanup(); reject(new Error(`WAIT_TIMEOUT: ${args.selector}`)); }, timeout);
    });
  }
  if (command === 'content') {
    const root = args.selector ? resolve(args.selector) : document.body;
    const raw = args.format === 'html' ? root.outerHTML : (root as HTMLElement).innerText ?? root.textContent ?? '';
    const offset = Math.max(0, args.offset ?? 0), max = Math.min(50000, Math.max(100, args.maxChars ?? 12000));
    return { documentId: state.documentId, url: location.href, text: raw.slice(offset, offset + max), truncated: raw.length > offset + max, nextOffset: raw.length > offset + max ? offset + max : null, totalChars: raw.length };
  }
  if (command === 'observe') {
    const max = Math.min(50000, Math.max(500, args.maxChars ?? 12000));
    const offset = Math.max(0, args.offset ?? 0), maxNodes = Math.min(500, Math.max(1, args.maxNodes ?? 120));
    const root = args.selector ? resolve(args.selector) : Array.from(document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')).find(visible) ?? document.body;
    const lines: { ref: string; text: string }[] = [];
    let count = 0, chars = 0, truncated = false, visited = 0;
    const visit = (el: Element): boolean => {
      if (++visited > 20000) { truncated = true; return false; }
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD'].includes(el.tagName)) return true;
      if (args.visibleOnly !== false && !visible(el) && getComputedStyle(el).display !== 'contents') return true;
      const r = role(el);
      if (r && (!args.query || name(el).toLowerCase().includes(String(args.query).toLowerCase()))) {
        if (count++ >= offset) {
          const id = ref(el), details: string[] = [];
          for (const attr of ['aria-expanded', 'aria-selected', 'aria-required', 'aria-invalid', 'aria-disabled']) if (el.hasAttribute(attr)) details.push(`${attr.slice(5)}=${el.getAttribute(attr)}`);
          if (el.matches(':disabled')) details.push('disabled');
          if ((el as HTMLInputElement).required) details.push('required');
          const value = valueOf(el);
          if (value !== undefined && value !== '') details.push(`value=${JSON.stringify(String(value).slice(0, 160))}`);
          if (el.tagName === 'A') details.push(`href=${JSON.stringify((el as HTMLAnchorElement).getAttribute('href')?.slice(0, 240))}`);
          if (el instanceof HTMLSelectElement) {
            details.push(`options=${JSON.stringify(Array.from(el.options).slice(0, 30).map(o => ({ value: o.value.slice(0, 120), label: o.label.slice(0, 80), selected: o.selected })))}`);
            if (el.options.length > 30) details.push('optionsTruncated=true');
          }
          if (el.tagName === 'IFRAME') details.push('use list_frames to inspect');
          let text = `${r} ${JSON.stringify(['main', 'navigation', 'form', 'table', 'row'].includes(r) ? el.getAttribute('aria-label') ?? '' : name(el))}${details.length ? ' ' + details.join(' ') : ''}`;
          if (!lines.length && id.length + text.length > max) text = text.slice(0, max - id.length - 20) + ' [node truncated]';
          if (lines.length >= maxNodes || chars + id.length + text.length > max) { truncated = true; return false; }
          lines.push({ ref: id, text }); chars += id.length + text.length;
        }
      }
      for (const child of el.children) if (!visit(child)) return false;
      if (el.shadowRoot) {
        if (!state.watched.has(el.shadowRoot)) { state.watched.add(el.shadowRoot); state.observer.observe(el.shadowRoot, { subtree: true, childList: true, attributes: true, characterData: true }); }
        for (const child of el.shadowRoot.children) if (!visit(child)) return false;
      }
      return true;
    };
    if (root) visit(root);
    const key = JSON.stringify([args.selector ?? '', args.query ?? '', offset, max, maxNodes, args.visibleOnly !== false]);
    const old = args.since ? state.snapshots.get(args.since) : undefined;
    const version = uid();
    state.snapshots.set(version, { key, lines });
    while (state.snapshots.size > 8) state.snapshots.delete(state.snapshots.keys().next().value);
    const base = { revision: state.revision, documentId: state.documentId, version, url: location.href, title: document.title, truncated, nextOffset: truncated ? offset + lines.length : null, scope: args.selector ?? (root ? ref(root) : null) };
    if (old?.key === key) {
      const previous = new Map<string, string>(old.lines.map((l: any) => [l.ref, l.text]));
      const current = new Set(lines.map(l => l.ref));
      return { ...base, mode: 'delta', since: args.since, order: JSON.stringify(old.lines.map((l: any) => l.ref)) === JSON.stringify(lines.map(l => l.ref)) ? undefined : lines.map(l => l.ref), nodes: lines.filter(l => previous.get(l.ref) !== l.text), removed: old.lines.filter((l: any) => !current.has(l.ref)).map((l: any) => l.ref) };
    }
    return { ...base, mode: 'full', reset: Boolean(args.since), nodes: lines };
  }
  if (command === 'readState') {
    const el = resolve(args.selector) as HTMLElement;
    const attrs: Record<string, string | null> = {};
    for (const attr of (args.attributes ?? ['aria-expanded','aria-selected','aria-activedescendant','aria-busy']).slice(0,20)) attrs[attr] = el instanceof HTMLInputElement && el.type === 'password' && attr.toLowerCase() === 'value' ? '[redacted]' : el.getAttribute(attr)?.slice(0,500) ?? null;
    return { ref: ref(el), tag: el.tagName.toLowerCase(), value: typeof valueOf(el) === 'string' ? String(valueOf(el)).slice(0,1000) : valueOf(el), text: (el.textContent ?? '').trim().slice(0, Math.min(4000,args.maxChars ?? 1000)), attributes: attrs, visible: visible(el), disabled: el.matches(':disabled'), readOnly: Boolean((el as HTMLInputElement).readOnly), checked: (el as HTMLInputElement).checked, selectedIndex: (el as HTMLSelectElement).selectedIndex };
  }
  if (command === 'findOption') {
    if (args.text === undefined && args.value === undefined) throw new Error('INVALID_ARGUMENT: select_option requires text or value.');
    const root = args.selector ? resolve(args.selector) : document.body;
    if (root instanceof HTMLSelectElement) {
      const options = Array.from(root.options).filter(o => args.value !== undefined ? o.value === args.value : o.textContent?.trim() === args.text);
      if (options.length !== 1) throw new Error(options.length ? 'AMBIGUOUS_OPTION' : 'OPTION_NOT_FOUND');
      check(root); if (options[0].disabled) throw new Error('DISABLED_OPTION');
      root.value = options[0].value; root.dispatchEvent(new Event('input', { bubbles: true })); root.dispatchEvent(new Event('change', { bubbles: true }));
      return { performed: true, value: root.value, method: 'native-select' };
    }
    const nodes = Array.from(root.querySelectorAll(args.optionSelector ?? '[role="option"],li')).filter(e => visible(e) && (e.textContent ?? '').trim() === args.text);
    if (nodes.length !== 1) throw new Error(nodes.length ? 'AMBIGUOUS_OPTION: Scope the dropdown selector.' : 'OPTION_NOT_FOUND: Open the dropdown first; hidden options are not clicked.');
    return { selector: ref(nodes[0]) };
  }
  if (command === 'prepareInput') {
    const el = resolve(args.selector) as HTMLElement; check(el);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
    const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) throw new Error('NOT_VISIBLE: Target could not be scrolled into view.');
    let hit = document.elementFromPoint(x,y);
    while (hit?.shadowRoot?.elementFromPoint(x,y) && hit.shadowRoot.elementFromPoint(x,y) !== hit) hit = hit.shadowRoot.elementFromPoint(x,y);
    if (!hit || (hit !== el && !el.contains(hit))) throw new Error('TARGET_OCCLUDED: Another element covers the target. Close the overlay or select its option.');
    if (args.focus) el.focus({ preventScroll: true });
    return { x, y, documentId: state.documentId, ref: ref(el), readOnly: Boolean((el as HTMLInputElement).readOnly) };
  }
  if (command === 'checkWait') {
    if (args.kind === 'url') return { ready: args.exact ? location.href === args.url : location.href.includes(args.url), url: location.href };
    const root = args.selector ? resolve(args.selector) : document.body;
    if (args.kind === 'text') { const text = (root as HTMLElement).innerText ?? ''; return { ready: args.exact ? text.trim() === args.text : text.includes(args.text) }; }
    return { ready: visible(root) };
  }
  if (command === 'click') {
    const el = resolve(args.selector); check(el);
    if (!(el instanceof HTMLElement)) throw new Error('NOT_CLICKABLE');
    el.click(); return { performed: true, documentId: state.documentId };
  }
  if (command === 'fill' || command === 'type') {
    const items = command === 'type' ? [{ selector: args.selector, value: args.text }] : args.fields;
    const targets: { el: any; value: string; selector: string }[] = items.map((item: any) => {
      const el = resolve(item.selector); check(el);
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable)) throw new Error(`NOT_FILLABLE: ${item.selector}`);
      if ((el as HTMLInputElement).readOnly) throw new Error(`READ_ONLY: ${item.selector}`);
      if (el instanceof HTMLInputElement && el.type === 'file') throw new Error('FILE_INPUT_UNSUPPORTED');
      if (el instanceof HTMLSelectElement && !Array.from(el.options).some(o => o.value === item.value)) throw new Error(`OPTION_NOT_FOUND: ${item.value}`);
      return { el, value: item.value, selector: item.selector };
    });
    let form: HTMLFormElement | null = null;
    if (args.submit) {
      const forms = new Set(targets.map(t => t.el.form ?? t.el.closest('form')));
      form = args.form ? resolve(args.form) as HTMLFormElement : forms.size === 1 ? [...forms][0] : null;
      if (!(form instanceof HTMLFormElement) || targets.some(t => (t.el.form ?? t.el.closest('form')) !== form)) throw new Error('AMBIGUOUS_FORM: All fields must belong to the selected form.');
    }
    const results: any[] = [];
    try {
      for (const { el, value, selector } of targets) {
        if (!el.isConnected) throw new Error('STALE_REF: Form changed during filling.');
        check(el);
        const actual = command === 'type' && !args.clear ? String(valueOf(el) === '[redacted]' ? el.value : valueOf(el) ?? '') + value : value;
        if (el.isContentEditable) el.textContent = actual;
        else {
          const property = el.type === 'checkbox' || el.type === 'radio' ? 'checked' : 'value';
          const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
          const next = property === 'checked' ? ['true', '1', 'on'].includes(value) : actual;
          Object.getOwnPropertyDescriptor(prototype, property)!.set!.call(el, next);
        }
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        results.push({ selector, value: valueOf(el), valid: el.validity?.valid ?? true, validationMessage: el.validationMessage || undefined });
      }
      const valid = form ? form.checkValidity() : results.every(r => r.valid);
      if (form && valid) form.requestSubmit();
      return { performed: true, fields: results, submitted: Boolean(form && valid), submissionStatus: form && valid ? "requested; verify resulting page state" : "not requested", valid, documentId: state.documentId };
    } catch (e) { return { performed: results.length > 0, fields: results, error: String(e), submitted: false, documentId: state.documentId }; }
  }
  if (command === 'scroll') {
    const amount = Math.min(10000, Math.max(1, args.amount ?? 600));
    const target = args.selector ? resolve(args.selector) : window;
    target.scrollBy({ left: args.direction === 'left' ? -amount : args.direction === 'right' ? amount : 0, top: args.direction === 'up' ? -amount : args.direction === 'down' ? amount : 0, behavior: 'instant' as ScrollBehavior });
    return { performed: true, documentId: state.documentId };
  }
  throw new Error(`Unknown page command: ${command}`);
 } catch (error) { return { __livemcpError: error instanceof Error ? error.message : String(error) }; }
}
