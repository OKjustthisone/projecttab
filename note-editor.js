import {
  apiCall,
  clone,
  CONTEXT_INVALIDATED_MESSAGE,
  escapeHtml,
  formatDate,
  icon,
  isExtensionContextAlive
} from './shared.js';

const app = document.querySelector('#note-app');
const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId') || '';
const tabId = params.get('tabId') || '';
let project = null;
let tab = null;
let draft = null;
let pendingText = '';
let dirty = false;
let toastTimer = null;

function showToast(message, error = false) {
  const toast = document.querySelector('.toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast is-visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

function renderBlock(block, index) {
  const content = block.type === 'image'
    ? `<img src="${escapeHtml(block.value)}" alt="${escapeHtml(block.label || '笔记图片')}">`
    : block.type === 'link'
      ? `<a href="${escapeHtml(block.value)}" target="_blank" rel="noreferrer">${escapeHtml(block.label || block.value)}</a>`
      : `<p>${escapeHtml(block.value)}</p>`;
  return `<div class="note-block"><span class="block-kind">${icon(block.type === 'image' ? 'image' : block.type === 'link' ? 'link' : 'note', 14)}</span>${content}<button class="remove-block" data-action="remove-block" data-index="${index}" title="移除">${icon('close', 12)}</button></div>`;
}

function blocksMarkup() {
  return draft?.blocks?.length
    ? draft.blocks.map(renderBlock).join('')
    : '<div class="note-muted">还没有笔记。你可以在下方添加文字、链接或图片。</div>';
}

function updateBlocksUI() {
  const container = document.querySelector('[data-note-blocks]');
  if (container) container.innerHTML = blocksMarkup();
  const count = document.querySelector('[data-block-count]');
  if (count) count.textContent = `${draft?.blocks?.length || 0} 个内容块`;
}

function render() {
  if (!tab || !draft) {
    app.innerHTML = '<div class="note-editor-error"><strong>正在读取笔记…</strong><p>请稍候。</p></div>';
    return;
  }
  app.innerHTML = `<div class="note-editor-shell">
    <header class="note-editor-header">
      <div class="note-editor-brand"><span class="folder-badge">${icon('note', 18)}</span><div><strong>标签页笔记</strong><small>${escapeHtml(project?.name || '')} · ${escapeHtml(tab.domain || tab.url || '')}</small></div></div>
      <div class="note-editor-actions"><button class="modal-button" data-action="close">关闭</button><button class="modal-button primary" data-action="save">${icon('check', 14)}保存笔记</button></div>
    </header>
    <section class="note-editor-titlebar"><h1>${escapeHtml(tab.title || '未命名页面')}</h1><a href="${escapeHtml(tab.url)}" target="_blank" rel="noreferrer">${escapeHtml(tab.url)}</a></section>
    <div class="note-editor-grid">
      <section class="note-editor-card note-editor-main">
        <h2>笔记内容 <small data-block-count>${draft.blocks.length} 个内容块</small></h2>
        <div class="note-blocks note-editor-blocks" data-note-blocks>${blocksMarkup()}</div>
        <div class="field"><label for="note-text">添加文字</label><textarea id="note-text" placeholder="记录你的判断、摘录或下一步行动…">${escapeHtml(pendingText)}</textarea></div>
        <div class="note-input-row"><input id="note-link" placeholder="粘贴链接（https://…）"><button class="mini-button" data-action="add-link">${icon('link', 13)}添加链接</button></div>
        <div class="note-input-row"><input id="note-image-url" placeholder="图片 URL（https://…）"><button class="mini-button" data-action="add-image-url">${icon('image', 13)}添加图片</button></div>
        <label class="mini-button note-upload">${icon('upload', 13)}上传本地图片<input id="note-image-file" type="file" accept="image/*" hidden></label>
      </section>
      <aside class="note-editor-side">
        <section class="note-editor-card"><h2>页面信息</h2><div class="meta-list">
          <div class="meta-item"><span>项目</span><strong>${escapeHtml(project?.name || '')}</strong></div>
          <div class="meta-item"><span>来源</span><strong>${escapeHtml(tab.domain || tab.url || '')}</strong></div>
          <div class="meta-item"><span>添加时间</span><strong>${formatDate(tab.addedAt)}</strong></div>
          <div class="meta-item"><span>笔记上次编辑</span><strong>${formatDate(tab.note?.updatedAt)}</strong></div>
          <div class="meta-item"><span>页面地址</span><strong>${escapeHtml(tab.url || '')}</strong></div>
        </div></section>
        <section class="note-editor-card"><h2>小提示</h2><p class="note-editor-hint">按 Ctrl / ⌘ + S 可快速保存。关闭窗口时如果有未保存内容，会先询问是否保存。图片会以内嵌 data URL 保存在这条笔记里。</p></section>
      </aside>
    </div>
    <div class="toast"></div>
  </div>`;
  document.title = `${tab.title || '标签页笔记'} · Project Tab`;
}

function renderError(message) {
  app.innerHTML = `<div class="note-editor-error"><strong>无法打开笔记</strong><p>${escapeHtml(message)}</p><button class="modal-button primary" data-action="window-close">关闭窗口</button></div>`;
}

async function load() {
  if (!projectId || !tabId) throw new Error('缺少项目或标签页参数');
  const state = await apiCall('GET_STATE');
  const foundProject = state.projects.find((item) => item.id === projectId);
  const foundTab = foundProject?.tabs?.find((item) => item.id === tabId);
  if (!foundProject || !foundTab) throw new Error('找不到这个标签页笔记，它可能已经被删除');
  project = foundProject;
  tab = foundTab;
  draft = clone(tab.note || { blocks: [], updatedAt: null });
  pendingText = '';
  dirty = false;
  render();
}

async function saveNote(silent = false) {
  if (!draft) return;
  const nextDraft = clone(draft);
  const text = document.querySelector('#note-text')?.value.trim();
  if (text) {
    nextDraft.blocks.push({ id: `block_${Date.now()}`, type: 'text', value: text, label: '', createdAt: new Date().toISOString() });
  }
  const nextState = await apiCall('SAVE_NOTE', { projectId, tabId, note: nextDraft });
  const nextProject = nextState.projects.find((item) => item.id === projectId);
  const nextTab = nextProject?.tabs?.find((item) => item.id === tabId);
  if (!nextProject || !nextTab) throw new Error('保存后找不到这个标签页笔记');
  project = nextProject;
  tab = nextTab;
  draft = clone(tab.note || { blocks: [], updatedAt: null });
  pendingText = '';
  dirty = false;
  render();
  if (!silent) showToast('笔记已保存');
}

async function closeWindow() {
  if (dirty) {
    const shouldSave = window.confirm('有未保存的更改。点击“确定”保存并关闭，点击“取消”继续编辑。');
    if (!shouldSave) return;
    await saveNote(true);
  }
  window.close();
}

app.addEventListener('input', (event) => {
  if (event.target.id === 'note-text') {
    pendingText = event.target.value;
    dirty = true;
  }
});

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'remove-block') {
    draft.blocks.splice(Number(button.dataset.index), 1);
    dirty = true;
    updateBlocksUI();
    return;
  }
  try {
    switch (action) {
      case 'save':
        await saveNote();
        break;
      case 'close':
        await closeWindow();
        break;
      case 'window-close':
        window.close();
        break;
      case 'add-link': {
        const input = document.querySelector('#note-link');
        const value = input?.value.trim();
        if (!value) return;
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('链接需要以 http(s) 开头');
        draft.blocks.push({ id: `block_${Date.now()}`, type: 'link', value: url.href, label: url.href, createdAt: new Date().toISOString() });
        input.value = '';
        dirty = true;
        updateBlocksUI();
        break;
      }
      case 'add-image-url': {
        const input = document.querySelector('#note-image-url');
        const value = input?.value.trim();
        if (!value) return;
        if (!/^https?:\/\//i.test(value)) throw new Error('图片 URL 需要以 http(s) 开头');
        draft.blocks.push({ id: `block_${Date.now()}`, type: 'image', value, label: '远程图片', createdAt: new Date().toISOString() });
        input.value = '';
        dirty = true;
        updateBlocksUI();
        break;
      }
      default:
        break;
    }
  } catch (error) {
    showToast(isExtensionContextAlive() ? error.message : CONTEXT_INVALIDATED_MESSAGE, true);
  }
});

app.addEventListener('change', (event) => {
  if (event.target.id !== 'note-image-file' || !event.target.files?.[0]) return;
  const file = event.target.files[0];
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    draft.blocks.push({ id: `block_${Date.now()}`, type: 'image', value: String(reader.result), label: file.name, createdAt: new Date().toISOString() });
    dirty = true;
    updateBlocksUI();
  });
  reader.readAsDataURL(file);
  event.target.value = '';
});

window.addEventListener('keydown', async (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    try {
      await saveNote();
    } catch (error) {
      showToast(isExtensionContextAlive() ? error.message : CONTEXT_INVALIDATED_MESSAGE, true);
    }
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

load().catch((error) => {
  renderError(isExtensionContextAlive() ? error.message : CONTEXT_INVALIDATED_MESSAGE);
});
