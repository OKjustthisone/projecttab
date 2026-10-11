// 页面内标记引擎：划词高亮（多色）+ 高亮评论。
// 渲染使用 CSS Custom Highlight API，不向页面 DOM 插入标记节点，避免干扰站点脚本。
// 定位策略：文本引用（prefix + exact + suffix）为主，CSS 选择器兜底。
(() => {
  if (window.top !== window) return;

  // 扩展重载后旧宿主可能残留，先清理再初始化。
  document.querySelectorAll(`#project-tab-annot-host`).forEach((existingHost) => existingHost.remove());

  const HOST_ID = 'project-tab-annot-host';
  const COLORS = [
    { name: 'yellow', hex: '#ffd60a', title: '黄色高亮' },
    { name: 'green', hex: '#30d158', title: '绿色高亮' },
    { name: 'blue', hex: '#0a84ff', title: '蓝色高亮' },
    { name: 'pink', hex: '#ff375f', title: '粉色高亮' },
    { name: 'purple', hex: '#bf5af2', title: '紫色高亮' },
    { name: 'orange', hex: '#ff9f0a', title: '橙色高亮' }
  ];
  const QUOTE_CONTEXT = 32;
  const REANCHOR_DEBOUNCE_MS = 400;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION']);

  let meta = { saved: false, projectId: null, tabId: null };
  let annotations = [];
  let textIndex = null;
  let rangesById = new Map();
  let pendingAnchor = null;
  let bubbleState = null;
  let currentUrl = location.href;
  let reloadTimer = null;
  let reanchorTimer = null;

  // ---------- 工具 ----------

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function sendMessage(type, payload = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) return reject(new Error(runtimeError.message));
          if (!response) return reject(new Error('扩展后台未响应'));
          if (!response.ok) return reject(new Error(response.error || '操作失败'));
          resolve(response.data);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function createAnnotationId() {
    if (globalThis.crypto?.randomUUID) return `anno_${crypto.randomUUID()}`;
    return `anno_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function liveAnnotations() {
    return annotations.filter((item) => item && !item.deletedAt);
  }

  // ---------- 文本索引 ----------

  function collectTextNodes(root, out) {
    for (const child of root.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.nodeValue && child.nodeValue.length) out.push(child);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (SKIP_TAGS.has(child.tagName)) continue;
      if (child.id === HOST_ID || child.id === 'project-tab-edge-host') continue;
      if (child.shadowRoot) collectTextNodes(child.shadowRoot, out);
      collectTextNodes(child, out);
    }
    return out;
  }

  function buildTextIndex() {
    const nodes = collectTextNodes(document.body || document.documentElement, []);
    let fullText = '';
    const map = new Map();
    for (const node of nodes) {
      map.set(node, fullText.length);
      fullText += node.nodeValue;
    }
    textIndex = { fullText, map, nodes };
    return textIndex;
  }

  function offsetOf(container, offset, isEnd) {
    if (!textIndex) buildTextIndex();
    if (container.nodeType === Node.TEXT_NODE) {
      const base = textIndex.map.get(container);
      if (base == null) return null;
      return base + Math.max(0, Math.min(offset, container.nodeValue.length));
    }
    if (container.nodeType !== Node.ELEMENT_NODE) return null;
    const children = container.childNodes;
    let target = isEnd ? children[offset - 1] : children[offset];
    if (!target && children.length) target = isEnd ? children[children.length - 1] : children[0];
    while (target && target.nodeType === Node.ELEMENT_NODE && target.childNodes.length) {
      target = isEnd ? target.childNodes[target.childNodes.length - 1] : target.childNodes[0];
    }
    if (!target || target.nodeType !== Node.TEXT_NODE) return null;
    const base = textIndex.map.get(target);
    if (base == null) return null;
    return base + (isEnd ? target.nodeValue.length : 0);
  }

  function rangeFromOffsets(start, end) {
    if (!textIndex) buildTextIndex();
    const { nodes, map } = textIndex;
    // 节点按拼接顺序单调递增，边界可落在任一相邻节点（Range 语义等价）。
    const findPoint = (offset) => {
      let low = 0;
      let high = nodes.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const node = nodes[mid];
        const base = map.get(node);
        const nodeEnd = base + node.nodeValue.length;
        if (offset < base) high = mid - 1;
        else if (offset > nodeEnd) low = mid + 1;
        else return { node, offset: offset - base };
      }
      return null;
    };
    const startPoint = findPoint(start);
    const endPoint = findPoint(end) || startPoint;
    if (!startPoint) return null;
    try {
      const range = document.createRange();
      range.setStart(startPoint.node, startPoint.offset);
      range.setEnd(endPoint.node, endPoint.offset);
      if (range.collapsed) return null;
      return range;
    } catch {
      return null;
    }
  }

  function findAll(haystack, needle, limit = 50) {
    const out = [];
    if (!needle) return out;
    let index = haystack.indexOf(needle);
    while (index !== -1 && out.length < limit) {
      out.push(index);
      index = haystack.indexOf(needle, index + 1);
    }
    return out;
  }

  function pickClosest(candidates, target) {
    return candidates.reduce((best, value) =>
      Math.abs(value - target) < Math.abs(best - target) ? value : best, candidates[0]);
  }

  function locateViaSelector(selector, exact) {
    if (!selector) return null;
    let element;
    try {
      element = document.querySelector(selector);
    } catch {
      return null;
    }
    if (!element) return null;
    const nodes = collectTextNodes(element, []);
    let inner = '';
    const map = new Map();
    for (const node of nodes) {
      map.set(node, inner.length);
      inner += node.nodeValue;
    }
    const at = inner.indexOf(exact);
    if (at < 0) return null;
    const ordered = nodes.slice().sort((a, b) => map.get(a) - map.get(b));
    const pointAt = (offset) => {
      for (const node of ordered) {
        const base = map.get(node);
        if (offset >= base && offset <= base + node.nodeValue.length) {
          return { node, offset: offset - base };
        }
      }
      return null;
    };
    const start = pointAt(at);
    const end = pointAt(at + exact.length);
    if (!start || !end) return null;
    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range.collapsed ? null : range;
    } catch {
      return null;
    }
  }

  function locateRange(anno) {
    if (!textIndex) buildTextIndex();
    const { fullText } = textIndex;
    const { prefix = '', exact = '', suffix = '' } = anno.quote || {};
    if (!exact) return null;

    const context = prefix + exact + suffix;
    const contextHits = findAll(fullText, context);
    if (contextHits.length) {
      const starts = contextHits.map((hit) => hit + prefix.length);
      const start = starts.length > 1 ? pickClosest(starts, anno.start || 0) : starts[0];
      return rangeFromOffsets(start, start + exact.length);
    }

    const exactHits = findAll(fullText, exact);
    if (exactHits.length) {
      const start = exactHits.length > 1 ? pickClosest(exactHits, anno.start || 0) : exactHits[0];
      return rangeFromOffsets(start, start + exact.length);
    }

    return locateViaSelector(anno.cssPath, exact);
  }

  // ---------- 渲染 ----------

  function clearHighlights() {
    if (!globalThis.CSS?.highlights) return;
    for (const key of [...CSS.highlights.keys()]) {
      if (key.startsWith('pt-')) CSS.highlights.delete(key);
    }
  }

  function render() {
    clearHighlights();
    rangesById = new Map();
    if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
    buildTextIndex();
    const byColor = new Map();
    for (const anno of liveAnnotations()) {
      const range = locateRange(anno);
      if (!range) continue;
      rangesById.set(anno.id, range);
      if (!byColor.has(anno.color)) byColor.set(anno.color, []);
      byColor.get(anno.color).push(range);
    }
    for (const [color, ranges] of byColor) {
      CSS.highlights.set(`pt-${color}`, new Highlight(...ranges));
    }
  }

  function focusAnnotation(annotationId) {
    const anno = liveAnnotations().find((item) => item.id === annotationId);
    if (!anno) return;
    const range = rangesById.get(anno.id) || locateRange(anno);
    if (!range) return;
    const rect = range.getBoundingClientRect();
    if (rect && (rect.top < 0 || rect.bottom > window.innerHeight)) {
      window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 3, behavior: 'smooth' });
    }
    if (globalThis.CSS?.highlights && globalThis.Highlight) {
      CSS.highlights.set('pt-flash', new Highlight(range));
      setTimeout(() => CSS.highlights.delete('pt-flash'), 1500);
    }
    openBubble(anno.id, rect || range.getClientRects()[0]);
  }

  // ---------- UI 宿主（Shadow DOM，closed，与面板宿主隔离） ----------

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .toolbar {
      position: fixed;
      z-index: 2147483644;
      display: none;
      align-items: center;
      gap: 6px;
      padding: 7px 9px;
      border-radius: 999px;
      background: #14201a;
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
      font: 12px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .toolbar.is-visible { display: flex; }
    .swatch {
      width: 20px; height: 20px; padding: 0;
      border: 2px solid transparent; border-radius: 50%;
      background: var(--c); cursor: pointer;
    }
    .swatch:hover { transform: scale(1.15); border-color: rgba(255,255,255,.8); }
    .sep { width: 1px; height: 16px; background: rgba(255,255,255,.25); }
    .tool-btn {
      display: inline-flex; align-items: center; gap: 5px;
      height: 26px; padding: 0 10px;
      border: 0; border-radius: 999px;
      background: #1ca96d; color: #fff;
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      cursor: pointer;
    }
    .tool-btn:hover { background: #17b173; }
    .tool-btn.ghost { background: rgba(255,255,255,.14); }
    .tool-btn.ghost:hover { background: rgba(255,255,255,.24); }
    .bubble {
      position: fixed;
      z-index: 2147483643;
      display: none;
      width: min(320px, calc(100vw - 24px));
      padding: 12px;
      border-radius: 14px;
      background: #fff;
      box-shadow: 0 14px 44px rgba(15, 76, 46, .28);
      font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #1c2b24;
    }
    .bubble.is-visible { display: block; }
    .quote {
      max-height: 76px; overflow: hidden;
      margin-bottom: 9px; padding: 7px 9px;
      border-left: 3px solid var(--c, #ffd60a);
      border-radius: 6px;
      background: #f4f7f5;
      color: #46564e;
      font-size: 11px;
    }
    .bubble textarea {
      width: 100%; min-height: 66px; resize: vertical;
      padding: 8px; border: 1px solid #d9e4de; border-radius: 8px;
      font: 12px/1.5 inherit; color: inherit;
    }
    .bubble textarea:focus { outline: 2px solid #1ca96d55; border-color: #1ca96d; }
    .row { display: flex; align-items: center; gap: 6px; margin-top: 9px; }
    .row .grow { flex: 1; }
    .bubble .swatch { width: 17px; height: 17px; }
    .bubble .swatch.active { border-color: #14201a; }
    .b-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; padding: 0;
      border: 0; border-radius: 8px;
      background: #eaf1ed; color: #274038;
      cursor: pointer;
    }
    .b-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .b-btn:hover { background: #dde9e2; }
    .b-btn.primary { background: transparent; color: #1ca96d; }
    .b-btn.primary:hover { background: #e8f5ed; }
    .b-btn.danger { background: transparent; color: #d64545; }
    .b-btn.danger:hover { background: #fdecec; }
    .toast {
      position: fixed;
      z-index: 2147483644;
      left: 50%; bottom: 42px;
      transform: translateX(-50%);
      display: none;
      max-width: min(420px, calc(100vw - 32px));
      padding: 9px 15px;
      border-radius: 999px;
      background: #14201a; color: #fff;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,.3);
    }
    .toast.is-visible { display: block; }
    svg { display: block; }
  `;
  shadow.append(style);

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.innerHTML = `${COLORS.map((color) =>
    `<button class="swatch" data-color="${color.name}" style="--c:${color.hex}" title="${color.title}" aria-label="${color.title}"></button>`
  ).join('')}<span class="sep"></span>
    <button class="tool-btn" data-act="comment" title="高亮并添加评论">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2-3.2A8 8 0 1 1 21 12Z"/></svg>评论
    </button>`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = `
    <div class="quote" data-role="quote"></div>
    <textarea data-role="comment" placeholder="写下你的评论或笔记…"></textarea>
    <div class="row">
      ${COLORS.map((color) =>
        `<button class="swatch" data-color="${color.name}" style="--c:${color.hex}" title="${color.title}" aria-label="${color.title}"></button>`
      ).join('')}
      <span class="grow"></span>
      <button class="b-btn danger" data-act="delete" title="删除标记" aria-label="删除标记">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>
      </button>
      <button class="b-btn primary" data-act="save" title="保存评论" aria-label="保存评论">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
      </button>
    </div>`;

  const toast = document.createElement('div');
  toast.className = 'toast';
  shadow.append(toolbar, bubble, toast);
  document.documentElement.append(host);

  let toastTimer = null;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2400);
  }

  // ---------- 工具条 ----------

  function hideToolbar() {
    toolbar.classList.remove('is-visible');
    pendingAnchor = null;
  }

  function showToolbarForSelection() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return hideToolbar();
    const range = selection.getRangeAt(0);
    if (!document.body.contains(range.commonAncestorContainer)) return hideToolbar();
    if (range.commonAncestorContainer.parentElement?.closest?.(`#${HOST_ID}, #project-tab-edge-host`)) return hideToolbar();
    if (!selection.toString().trim()) return hideToolbar();

    const anchor = anchorFromRange(range);
    if (!anchor) return hideToolbar();
    pendingAnchor = { anchor, exact: anchor.quote.exact };

    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return hideToolbar();
    positionNear(toolbar, rect, 42);
    toolbar.classList.add('is-visible');
    if (bubbleState) closeBubble();
  }

  function positionNear(element, rect, gap) {
    element.classList.add('is-visible');
    element.style.visibility = 'hidden';
    element.style.left = '0px';
    element.style.top = '0px';
    const size = element.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - size.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - size.width - 8));
    let top = rect.top - size.height - gap;
    if (top < 8) top = rect.bottom + gap;
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
    element.style.visibility = '';
  }

  function anchorFromRange(range) {
    const start = offsetOf(range.startContainer, range.startOffset, false);
    const end = offsetOf(range.endContainer, range.endOffset, true);
    if (start == null || end == null || end <= start) return null;
    const fullText = textIndex.fullText;
    const exact = fullText.slice(start, end);
    if (!exact.trim()) return null;
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
    return {
      quote: {
        exact,
        prefix: fullText.slice(Math.max(0, start - QUOTE_CONTEXT), start),
        suffix: fullText.slice(end, end + QUOTE_CONTEXT)
      },
      start,
      end,
      cssPath: cssPathOf(startElement)
    };
  }

  function cssPathOf(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body && parts.length < 8) {
      if (node.id) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  async function ensureSaved() {
    if (meta.saved) return true;
    try {
      const state = await sendMessage('GET_STATE');
      const project = state.projects.find((item) => !item.archived) || state.projects[0];
      if (!project) throw new Error('没有可用的项目');
      await sendMessage('ADD_TAB', {
        projectId: project.id,
        tab: { url: location.href, title: document.title || location.href, favIconUrl: '' }
      });
      const data = await sendMessage('GET_ANNOTATIONS', { url: location.href });
      meta = { saved: data.saved, projectId: data.projectId, tabId: data.tabId };
      annotations = data.annotations || [];
      showToast(`已收藏到「${project.name}」，现在可以标记了`);
      return true;
    } catch (error) {
      showToast(error?.message || '收藏失败');
      return false;
    }
  }

  async function createHighlight(color, withComment) {
    if (!pendingAnchor) return;
    const anchor = pendingAnchor.anchor;
    hideToolbar();
    document.getSelection()?.removeAllRanges();
    if (!(await ensureSaved())) return;
    const now = new Date().toISOString();
    const annotation = {
      id: createAnnotationId(),
      color,
      quote: anchor.quote,
      start: anchor.start,
      end: anchor.end,
      cssPath: anchor.cssPath,
      comment: '',
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    try {
      const data = await sendMessage('SAVE_ANNOTATION', { url: location.href, annotation });
      annotations = data.annotations || [];
      render();
      if (withComment) openBubble(annotation.id);
      else showToast('已高亮');
    } catch (error) {
      showToast(error?.message || '保存失败');
    }
  }

  // ---------- 评论气泡 ----------

  function closeBubble() {
    bubble.classList.remove('is-visible');
    bubbleState = null;
  }

  function openBubble(annotationId, rect) {
    const anno = liveAnnotations().find((item) => item.id === annotationId);
    if (!anno) return;
    bubbleState = { id: annotationId };
    const color = COLORS.find((item) => item.name === anno.color) || COLORS[0];
    bubble.style.setProperty('--c', color.hex);
    bubble.querySelector('[data-role="quote"]').textContent = anno.quote.exact;
    bubble.querySelector('[data-role="comment"]').value = anno.comment || '';
    bubble.querySelectorAll('.swatch').forEach((swatch) =>
      swatch.classList.toggle('active', swatch.dataset.color === anno.color));
    hideToolbar();
    if (!rect) {
      const range = rangesById.get(annotationId);
      rect = range?.getBoundingClientRect() || range?.getClientRects()?.[0];
    }
    if (rect) positionNear(bubble, rect, 10);
    else {
      bubble.classList.add('is-visible');
      bubble.style.left = `${Math.max(8, (window.innerWidth - 320) / 2)}px`;
      bubble.style.top = '80px';
    }
    bubble.querySelector('[data-role="comment"]').focus();
  }

  async function saveBubble() {
    if (!bubbleState) return;
    const anno = annotations.find((item) => item.id === bubbleState.id);
    if (!anno) return closeBubble();
    anno.comment = bubble.querySelector('[data-role="comment"]').value.trim();
    anno.updatedAt = new Date().toISOString();
    try {
      const data = await sendMessage('SAVE_ANNOTATION', { url: location.href, annotation: anno });
      annotations = data.annotations || [];
      closeBubble();
      render();
      showToast('评论已保存');
    } catch (error) {
      showToast(error?.message || '保存失败');
    }
  }

  async function deleteBubble() {
    if (!bubbleState) return;
    const id = bubbleState.id;
    closeBubble();
    try {
      const data = await sendMessage('DELETE_ANNOTATION', { url: location.href, annotationId: id });
      annotations = data.annotations || [];
      render();
      showToast('标记已删除');
    } catch (error) {
      showToast(error?.message || '删除失败');
    }
  }

  async function setBubbleColor(color) {
    if (!bubbleState) return;
    const anno = annotations.find((item) => item.id === bubbleState.id);
    if (!anno || anno.color === color) return;
    anno.color = color;
    anno.updatedAt = new Date().toISOString();
    try {
      const data = await sendMessage('SAVE_ANNOTATION', { url: location.href, annotation: anno });
      annotations = data.annotations || [];
      const swatch = COLORS.find((item) => item.name === color);
      if (swatch) bubble.style.setProperty('--c', swatch.hex);
      bubble.querySelectorAll('.swatch').forEach((item) =>
        item.classList.toggle('active', item.dataset.color === color));
      render();
    } catch (error) {
      showToast(error?.message || '换色失败');
    }
  }

  // ---------- 事件 ----------

  toolbar.addEventListener('click', (event) => {
    const color = event.target.closest('[data-color]')?.dataset.color;
    if (color) {
      createHighlight(color, false);
      return;
    }
    if (event.target.closest('[data-act="comment"]')) createHighlight(COLORS[0].name, true);
  });

  bubble.addEventListener('click', (event) => {
    const color = event.target.closest('[data-color]')?.dataset.color;
    if (color) return setBubbleColor(color);
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (act === 'save') saveBubble();
    else if (act === 'delete') deleteBubble();
  });

  bubble.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeBubble();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.stopPropagation();
      saveBubble();
    }
  });

  document.addEventListener('pointerup', (event) => {
    if (event.target instanceof Element && event.target.closest(`#${HOST_ID}, #project-tab-edge-host`)) return;
    setTimeout(showToolbarForSelection, 0);
  }, true);

  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Element && event.target.closest(`#${HOST_ID}, #project-tab-edge-host`)) return;
    hideToolbar();
    if (bubbleState) closeBubble();
  }, true);

  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest(`#${HOST_ID}, #project-tab-edge-host`)) return;
    if (!event.clientX && !event.clientY) return;
    const point = caretAt(event.clientX, event.clientY);
    if (!point) return;
    for (const [id, range] of rangesById) {
      if (range.isPointInRange(point.node, point.offset)) {
        openBubble(id, range.getBoundingClientRect() || range.getClientRects()[0]);
        return;
      }
    }
    if (bubbleState) closeBubble();
  }, true);

  function caretAt(x, y) {
    try {
      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        if (range) return { node: range.startContainer, offset: range.startOffset };
      }
      if (document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(x, y);
        if (position) return { node: position.offsetNode, offset: position.offset };
      }
    } catch {
      return null;
    }
    return null;
  }

  window.addEventListener('scroll', () => {
    hideToolbar();
    if (bubbleState) closeBubble();
  }, { passive: true, capture: true });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideToolbar();
      if (bubbleState) closeBubble();
    }
  }, true);

  window.addEventListener('popstate', scheduleReload);
  window.addEventListener('hashchange', scheduleReload);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleReload();
  });

  // ---------- 数据加载 / 重锚定 ----------

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reload, 200);
  }

  async function reload() {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      closeBubble();
      hideToolbar();
    }
    try {
      const data = await sendMessage('GET_ANNOTATIONS', { url: location.href });
      meta = { saved: data.saved, projectId: data.projectId, tabId: data.tabId };
      annotations = data.annotations || [];
      render();
      if (data.pendingFocusId) focusAnnotation(data.pendingFocusId);
    } catch {
      // 扩展上下文失效时静默，面板侧已有恢复提示。
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(reanchorTimer);
    reanchorTimer = setTimeout(() => {
      if (bubbleState) return;
      render();
    }, REANCHOR_DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.projectTabState) scheduleReload();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'PT_FOCUS_ANNOTATION') {
      // reload 会通过 GET_ANNOTATIONS 读取并清除 pendingFocus，随后自动定位。
      reload();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reload, { once: true });
  } else {
    reload();
  }
})();
