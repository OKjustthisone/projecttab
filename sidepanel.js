import {
  apiCall,
  clone,
  escapeHtml,
  formatDate,
  icon,
  truncate
} from './shared.js';

const app = document.querySelector('#app');
let state = null;
let searchQuery = '';
let manageProjectId = null;
const selectedByProject = new Map();
let historyDrawer = null;
let historyItems = [];
let historySelected = new Set();
let historyLoading = false;
let historyQuery = '';
let historyTimer = null;
let noteModal = null;
let projectNoteModal = null;
let moveModal = null;
let projectMenuId = null;
let projectEditor = null;
let confirmModal = null;
let toastTimer = null;
const isEdgePanel = window.location.pathname.endsWith('/edge-panel.html');
let panelPinned = false;
let edgePanelWindowId = null;

function postPanelMessage(type, payload = {}) {
  if (!isEdgePanel) return;
  window.parent.postMessage({ source: 'project-tab-panel', type, ...payload }, '*');
}

function updatePanelPinButton() {
  const button = document.querySelector('[data-action="toggle-pin"]');
  if (!button) return;
  button.classList.toggle('is-active', panelPinned);
  button.setAttribute('aria-pressed', String(panelPinned));
  button.setAttribute('aria-label', panelPinned ? '取消固定面板' : '固定到浏览器侧边栏');
  button.title = panelPinned ? '取消固定面板' : '固定到浏览器侧边栏（分屏）';
}

async function cacheEdgePanelWindowId() {
  if (!isEdgePanel) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    edgePanelWindowId = tab?.windowId ?? null;
  } catch {
    edgePanelWindowId = null;
  }
}

window.addEventListener('message', (event) => {
  if (!isEdgePanel || event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.source !== 'project-tab-host') return;
  if (message.type === 'PIN_STATE') {
    panelPinned = Boolean(message.pinned);
    updatePanelPinButton();
  }
});

function selectedSet(projectId) {
  if (!selectedByProject.has(projectId)) selectedByProject.set(projectId, new Set());
  return selectedByProject.get(projectId);
}

function getProject(projectId) {
  return state?.projects.find((project) => project.id === projectId);
}

function getTab(projectId, tabId) {
  return getProject(projectId)?.tabs.find((tab) => tab.id === tabId);
}

function showToast(message, error = false) {
  const toast = document.querySelector('.toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast is-visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

function projectMatches(project) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return true;
  return project.name.toLowerCase().includes(query) || project.tabs.some((tab) =>
    `${tab.title} ${tab.url} ${tab.domain}`.toLowerCase().includes(query)
  );
}

function visibleTabs(project) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return project.tabs;
  return project.tabs.filter((tab) => `${tab.title} ${tab.url} ${tab.domain}`.toLowerCase().includes(query));
}

function childProjects(projectId) {
  return state?.projects.filter((project) => project.parentId === projectId) || [];
}

function visibleProjectIds() {
  if (!state) return new Set();
  const visible = new Set(state.projects.filter(projectMatches).map((project) => project.id));
  const projectsById = new Map(state.projects.map((project) => [project.id, project]));

  for (const project of state.projects) {
    if (!visible.has(project.id)) continue;
    let parent = projectsById.get(project.parentId);
    const visited = new Set([project.id]);
    while (parent && !visited.has(parent.id)) {
      visible.add(parent.id);
      visited.add(parent.id);
      parent = projectsById.get(parent.parentId);
    }
  }
  return visible;
}

function projectHasOpenMenu(project, visibleIds) {
  if (projectMenuId === project.id) return true;
  return childProjects(project.id)
    .filter((child) => visibleIds.has(child.id))
    .some((child) => projectHasOpenMenu(child, visibleIds));
}

function faviconMarkup(tab) {
  const initial = escapeHtml((tab.title || tab.domain || 'P').trim().slice(0, 1).toUpperCase());
  return tab.favicon
    ? `<span class="tab-favicon"><img src="${escapeHtml(tab.favicon)}" alt="" loading="lazy">${initial}</span>`
    : `<span class="tab-favicon">${initial}</span>`;
}

function renderTopbar() {
  const edgePanelActions = isEdgePanel ? `
        <button class="icon-button top-action-button${panelPinned ? ' is-active' : ''}" data-action="toggle-pin" aria-pressed="${panelPinned}" aria-label="${panelPinned ? '取消固定面板' : '固定到浏览器侧边栏'}" title="${panelPinned ? '取消固定面板' : '固定到浏览器侧边栏（分屏）'}">${icon('pin', 15)}</button>
        <button class="icon-button top-action-button" data-action="close-panel" aria-label="收起 Project Tab" title="收起 Project Tab">${icon('close', 15)}</button>` : '';
  return `
    <header class="topbar">
      <div class="brand-mark"><img src="logo.png" alt="Project Tab"></div>
      <div class="brand-copy"><strong>Project Tab</strong><small>独立管理你的网页工作区</small></div>
      <div class="top-actions">
        <button class="icon-button top-action-button" data-action="sync" aria-label="手动刷新并同步" title="手动刷新并同步">${icon('refresh', 15)}</button>
        <button class="icon-button top-action-button" data-action="open-settings" aria-label="设置" title="设置">${icon('settings', 15)}</button>
        <button class="icon-button top-action-button" data-action="create-project" aria-label="创建项目文件夹" title="创建项目文件夹">${icon('folder-plus', 15)}</button>
        ${edgePanelActions}
      </div>
    </header>`;
}

function renderSummary() {
  const activeProjects = state.projects.filter((project) => !project.archived);
  const projects = activeProjects.length;
  const tabs = activeProjects.reduce((total, project) => total + project.tabs.length, 0);
  const starred = activeProjects.reduce((total, project) => total + project.tabs.filter((tab) => tab.starred).length, 0);
  return `<footer class="panel-summary">${projects} 个项目 · ${tabs} 个标签页 · ${starred} 个重要页面</footer>`;
}

function renderTab(project, tab, isManage) {
  const selected = selectedSet(project.id).has(tab.id);
  const noteReady = tab.note?.blocks?.length > 0;
  const secondaryAction = isManage
    ? `<button class="tab-action danger" data-action="delete-tab" data-project-id="${escapeHtml(project.id)}" data-tab-id="${escapeHtml(tab.id)}" title="删除标签页">${icon('trash', 14)}</button>`
    : `<button class="tab-action${noteReady ? ' note-ready' : ''}" data-action="open-note" data-project-id="${escapeHtml(project.id)}" data-tab-id="${escapeHtml(tab.id)}" title="打开标签页笔记">${icon('note', 14)}</button>`;
  return `
    <div class="tab-row${selected ? ' selected' : ''}" data-project-id="${escapeHtml(project.id)}" data-tab-id="${escapeHtml(tab.id)}" data-open-tab="true">
      ${isManage ? `<input class="tab-check" type="checkbox" data-project-id="${escapeHtml(project.id)}" data-tab-id="${escapeHtml(tab.id)}" ${selected ? 'checked' : ''} aria-label="选择 ${escapeHtml(tab.title)}">` : ''}
      ${faviconMarkup(tab)}
      <div class="tab-text">
        <strong title="${escapeHtml(tab.title)}">${escapeHtml(tab.title || '未命名页面')}</strong>
        <small>${escapeHtml(tab.domain || tab.url)}${noteReady ? ` · ${tab.note.blocks.length} 条笔记` : ''}</small>
      </div>
      <div class="tab-actions${isManage || tab.starred || noteReady ? ' is-visible' : ''}">
        <button class="tab-action${tab.starred ? ' starred' : ''}" data-action="toggle-star" data-project-id="${escapeHtml(project.id)}" data-tab-id="${escapeHtml(tab.id)}" title="${tab.starred ? '取消星标' : '标记重要'}">${icon('star', 14)}</button>
        ${secondaryAction}
      </div>
    </div>`;
}

function renderManagementToolbar(project) {
  const selected = selectedSet(project.id);
  const count = selected.size;
  const allSelected = project.tabs.length > 0 && project.tabs.every((tab) => selected.has(tab.id));
  return `<div class="management-toolbar">
    <button class="mini-button" data-action="select-all" data-project-id="${escapeHtml(project.id)}">${icon('check', 12)}${allSelected ? '取消全选' : '全选'}</button>
    <span>${count ? `已选 ${count} 个` : '勾选标签页后批量操作'}</span>
    <span class="grow"></span>
    <button class="mini-button" data-action="batch-move" data-project-id="${escapeHtml(project.id)}" ${count ? '' : 'disabled'}>${icon('move', 12)}移动</button>
    <button class="mini-button" data-action="batch-copy" data-project-id="${escapeHtml(project.id)}" ${count ? '' : 'disabled'}>${icon('copy', 12)}复制</button>
    <button class="mini-button danger" data-action="batch-delete" data-project-id="${escapeHtml(project.id)}" ${count ? '' : 'disabled'}>${icon('trash', 12)}</button>
  </div>`;
}

function renderProjectMenu(project) {
  if (projectMenuId !== project.id) return '';
  return `<div class="project-menu${project.archived ? ' opens-upward' : ''}" role="menu" aria-label="${escapeHtml(project.name)} 的更多操作">
    ${project.archived ? '' : `<button data-action="create-subfolder" data-project-id="${escapeHtml(project.id)}" role="menuitem">${icon('folder-plus', 14)}<span>创建子文件夹</span></button>`}
    <button data-action="rename-project" data-project-id="${escapeHtml(project.id)}" role="menuitem">${icon('pencil', 14)}<span>重命名</span></button>
    <button data-action="archive-project" data-project-id="${escapeHtml(project.id)}" role="menuitem">${icon('archive', 14)}<span>${project.archived ? '恢复项目' : '归档项目'}</span></button>
    <button class="danger" data-action="delete-project" data-project-id="${escapeHtml(project.id)}" role="menuitem">${icon('trash', 14)}<span>删除项目</span></button>
  </div>`;
}

function renderProjectTitle(project) {
  const isEditing = projectEditor?.mode === 'rename' && projectEditor.projectId === project.id;
  if (isEditing) {
    return `<div class="project-title project-title-editor"><input class="project-name-editor" data-project-id="${escapeHtml(project.id)}" value="${escapeHtml(projectEditor.value)}" maxlength="80" aria-label="项目名称"><small>Enter 保存 · Esc 取消</small></div>`;
  }
  return `<div class="project-title"><strong>${escapeHtml(project.name)}</strong><small>${project.archived ? '已归档 · ' : ''}${project.tabs.length} 个标签页</small></div>`;
}

function renderNewProjectDraft(parentId = null) {
  if (projectEditor?.mode !== 'create' || (projectEditor.parentId || null) !== parentId) return '';
  const isSubfolder = Boolean(parentId);
  return `<section class="project-card project-card-draft${isSubfolder ? ' project-card-child' : ''}">
    <div class="project-header project-header-editing">
      <span class="project-chevron project-chevron-placeholder"></span>
      <span class="folder-badge project-folder">${icon('folder', 15)}</span>
      <div class="project-title project-title-editor"><input class="project-name-editor" value="${escapeHtml(projectEditor.value)}" maxlength="80" placeholder="${isSubfolder ? '输入子文件夹名称' : '输入项目名称'}" aria-label="${isSubfolder ? '新子文件夹名称' : '新项目名称'}"><small>Enter 保存 · Esc 取消</small></div>
    </div>
  </section>`;
}

function renderProjectChildren(project, visibleIds) {
  const children = childProjects(project.id).filter((child) => visibleIds.has(child.id));
  const draft = renderNewProjectDraft(project.id);
  if (!draft && !children.length) return '';
  return `<div class="project-children" aria-label="${escapeHtml(project.name)} 的子文件夹">
    ${draft}${children.map((child) => renderProject(child, visibleIds)).join('')}
  </div>`;
}

function renderProject(project, visibleIds) {
  const isManage = manageProjectId === project.id;
  const tabs = visibleTabs(project);
  const projectIsEmptyDueToSearch = searchQuery.trim() && !tabs.length && project.tabs.length;
  const menuOpen = projectMenuId === project.id;
  const children = childProjects(project.id).filter((child) => visibleIds.has(child.id));
  const draftForProject = projectEditor?.mode === 'create' && projectEditor.parentId === project.id;
  const isExpanded = !project.collapsed || draftForProject;
  const hasOpenMenu = projectHasOpenMenu(project, visibleIds);
  const quickActions = project.archived
    ? ''
    : isManage
      ? `<button data-action="finish-manage" data-project-id="${escapeHtml(project.id)}" title="完成批量管理">${icon('check', 15)}</button>`
      : `<button data-action="open-project-note" data-project-id="${escapeHtml(project.id)}" title="项目笔记 / AI 分析">${icon('spark', 15)}</button>
         <button data-action="open-history" data-project-id="${escapeHtml(project.id)}" title="从浏览器历史批量添加">${icon('plus', 15)}</button>
         <button data-action="manage-project" data-project-id="${escapeHtml(project.id)}" title="批量管理标签页">${icon('pencil', 15)}</button>`;
  return `<section class="project-card${hasOpenMenu ? ' has-menu' : ''}${project.archived ? ' is-archived' : ''}" data-project-id="${escapeHtml(project.id)}">
    <div class="project-header" data-project-header="true">
      <span class="project-chevron${isExpanded ? ' is-open' : ''}">${icon('chevron', 14)}</span>
      <span class="folder-badge project-folder" style="color:${escapeHtml(project.color)}">${icon('folder', 15)}</span>
      ${renderProjectTitle(project)}
      <div class="project-actions${isManage ? ' is-visible' : ''}">${quickActions}</div>
      <button class="project-more-button${menuOpen ? ' is-active' : ''}" data-action="toggle-project-menu" data-project-id="${escapeHtml(project.id)}" aria-expanded="${menuOpen}" aria-label="更多项目操作" title="更多项目操作">${icon('menuDots', 16)}</button>
      ${renderProjectMenu(project)}
    </div>
    ${isExpanded ? `<div class="project-body">
      ${isManage ? renderManagementToolbar(project) : ''}
      ${projectIsEmptyDueToSearch && !children.length ? `<div class="tab-empty">没有匹配的标签页</div>` : tabs.length ? `<div class="tab-list">${tabs.map((tab) => renderTab(project, tab, isManage)).join('')}</div>` : children.length || draftForProject ? '' : `<div class="tab-empty"><strong>项目还是空的</strong>点击项目右侧的 +，从浏览器历史中批量添加页面。</div>`}
      ${renderProjectChildren(project, visibleIds)}
    </div>` : ''}
  </section>`;
}

function renderHistoryDrawer() {
  if (!historyDrawer) return '';
  const project = getProject(historyDrawer);
  return `<div class="drawer-backdrop" data-action="close-history"></div>
    <aside class="history-drawer" aria-label="浏览器历史记录">
      <div class="drawer-header"><span class="folder-badge">${icon('history', 16)}</span><strong>添加到「${escapeHtml(project?.name || '')}」</strong><span class="grow"></span><button class="icon-button" data-action="close-history" title="关闭">${icon('close')}</button></div>
      <div class="drawer-subtitle">从浏览器历史记录中选择多个网页，数据只会保存到 Project Tab。</div>
      <div class="search-box history-search"><span>${icon('search', 15)}</span><input id="history-search" value="${escapeHtml(historyQuery)}" placeholder="搜索历史记录…"></div>
      <div class="history-list">
        ${historyLoading ? '<div class="empty-state"><div class="empty-icon">…</div><strong>正在读取历史记录</strong><p>只读取最近 90 天的网页记录。</p></div>' : historyItems.length ? historyItems.map((item, index) => {
          const key = item.id || `${item.url}-${index}`;
          const checked = historySelected.has(key);
          return `<label class="history-item"><input type="checkbox" data-history-key="${escapeHtml(key)}" data-history-index="${index}" ${checked ? 'checked' : ''}><span class="tab-favicon">${escapeHtml((item.title || item.url || 'P').slice(0, 1).toUpperCase())}</span><span class="tab-text"><strong title="${escapeHtml(item.title || item.url)}">${escapeHtml(item.title || '未命名页面')}</strong><small>${escapeHtml(item.url)}</small></span></label>`;
        }).join('') : '<div class="empty-state"><div class="empty-icon">∅</div><strong>没有找到网页历史</strong><p>换一个关键词，或先浏览几个网页。</p></div>'}
      </div>
      <div class="history-footer"><span class="grow" data-history-selection-count>已选 ${historySelected.size} 个</span><button class="modal-button primary" data-action="add-history" ${historySelected.size ? '' : 'disabled'}>${icon('plus', 13)} 添加到项目</button></div>
    </aside>`;
}

function renderNoteBlock(block, index) {
  const content = block.type === 'image'
    ? `<img src="${escapeHtml(block.value)}" alt="${escapeHtml(block.label || '笔记图片')}">`
    : block.type === 'link'
      ? `<a href="${escapeHtml(block.value)}" target="_blank" rel="noreferrer">${escapeHtml(block.label || block.value)}</a>`
      : `<p>${escapeHtml(block.value)}</p>`;
  return `<div class="note-block"><span class="block-kind">${icon(block.type === 'image' ? 'image' : block.type === 'link' ? 'link' : 'note', 14)}</span>${content}<button class="remove-block" data-action="remove-note-block" data-index="${index}" title="移除">${icon('close', 12)}</button></div>`;
}

function renderNoteBlocks() {
  const blocks = noteModal?.draft?.blocks || [];
  return blocks.length ? blocks.map(renderNoteBlock).join('') : '<div class="note-muted">还没有笔记。你可以添加文字、链接或图片。</div>';
}

function renderNoteModal() {
  if (!noteModal) return '';
  const tab = getTab(noteModal.projectId, noteModal.tabId);
  return `<div class="modal-backdrop" data-backdrop-action="close-note">
    <section class="modal" role="dialog" aria-modal="true" aria-label="标签页笔记" data-modal="note">
      <div class="modal-header"><span class="folder-badge">${icon('note', 16)}</span><strong>标签页笔记</strong><span class="grow"></span><button class="icon-button" data-action="close-note" title="关闭">${icon('close')}</button></div>
      <div class="modal-body">
        <div style="margin-bottom:12px"><strong>${escapeHtml(tab?.title || '未命名页面')}</strong></div>
        <div class="note-blocks" data-note-blocks>${renderNoteBlocks()}</div>
        <div class="field"><label for="note-text">添加文字</label><textarea id="note-text" placeholder="记录你的判断、摘录或下一步行动…">${escapeHtml(noteModal.pendingText || '')}</textarea></div>
        <div class="note-input-row"><input id="note-link" placeholder="粘贴链接（可选标题）"><button class="mini-button" data-action="add-link-draft">${icon('link', 13)}添加链接</button></div>
        <div class="note-input-row"><input id="note-image-url" placeholder="图片 URL（可选）"><button class="mini-button" data-action="add-image-url">${icon('image', 13)}添加图片</button></div>
        <label class="mini-button" style="margin-top:8px;cursor:pointer;width:max-content">${icon('upload', 13)}上传本地图片<input id="note-image-file" type="file" accept="image/*" hidden></label>
        <div style="margin-top:12px;color:var(--muted);font-size:10px">上次编辑：${formatDate(tab?.note?.updatedAt)}</div>
      </div>
      <div class="modal-footer"><button class="modal-button" data-action="close-note">取消</button><button class="modal-button primary" data-action="save-note">保存笔记</button></div>
    </section>
  </div>`;
}

function renderAnalysis(analysis) {
  if (!analysis) return '<div class="note-muted">点击“分析项目”后，将按项目内的标题、来源和标签页笔记生成摘要与关联。</div>';
  const domainText = analysis.domains?.length ? analysis.domains.map((item) => `${escapeHtml(item.name)} (${item.count})`).join('、') : '暂无来源聚类';
  const keywordText = analysis.keywords?.length ? analysis.keywords.map((item) => `${escapeHtml(item.name)} (${item.count})`).join('、') : '暂无重复关键词';
  const relationships = analysis.relationships?.length
    ? analysis.relationships.map((item) => `<div class="relationship"><strong>${escapeHtml(truncate(item.left, 44))} ↔ ${escapeHtml(truncate(item.right, 44))}</strong><span>${escapeHtml(item.reason)}</span></div>`).join('')
    : '<div class="note-muted">暂未发现明显的标签页关联。补充笔记后再分析一次会更准确。</div>';
  return `<div class="analysis-overview">${escapeHtml(analysis.overview || '')}</div>
    <div class="analysis-grid"><div class="analysis-card"><h4>来源聚类</h4><p>${domainText}</p></div><div class="analysis-card"><h4>高频主题</h4><p>${keywordText}</p></div></div>
    <h4 style="margin:0 0 7px;font-size:11px">标签页关联</h4><div class="relationship-list">${relationships}</div>
    <div class="analysis-note">${escapeHtml(analysis.provider || '分析')} · ${formatDate(analysis.generatedAt)}</div>`;
}

function renderProjectNoteModal() {
  if (!projectNoteModal) return '';
  const project = getProject(projectNoteModal.projectId);
  const currentAnalysis = projectNoteModal.analysis || project?.projectNote?.analysis;
  return `<div class="modal-backdrop" data-backdrop-action="close-project-note">
    <section class="modal" role="dialog" aria-modal="true" aria-label="项目笔记" data-modal="project-note">
      <div class="modal-header"><span class="folder-badge">${icon('spark', 16)}</span><strong>项目笔记 · ${escapeHtml(project?.name || '')}</strong><span class="grow"></span><button class="icon-button" data-action="close-project-note" title="关闭">${icon('close')}</button></div>
      <div class="modal-body">
        <div class="note-toolbar"><button class="modal-button primary" data-action="analyze-project" ${projectNoteModal.loading ? 'disabled' : ''}>${icon('spark', 13)}${projectNoteModal.loading ? '分析中…' : '分析项目笔记'}</button><span style="align-self:center;color:var(--muted);font-size:10px">可在设置中连接自定义 AI 接口</span></div>
        ${renderAnalysis(currentAnalysis)}
        <div class="field" style="margin-top:14px"><label for="project-note-text">项目笔记</label><textarea id="project-note-text" placeholder="把分析结论、项目目标或下一步行动写在这里…">${escapeHtml(project?.projectNote?.text || '')}</textarea></div>
      </div>
      <div class="modal-footer"><button class="modal-button" data-action="close-project-note">取消</button><button class="modal-button primary" data-action="save-project-note">保存项目笔记</button></div>
    </section>
  </div>`;
}

function renderMoveModal() {
  if (!moveModal) return '';
  const source = getProject(moveModal.projectId);
  const targets = state.projects.filter((project) => project.id !== moveModal.projectId && !project.archived);
  return `<div class="modal-backdrop" data-backdrop-action="close-move">
    <section class="modal" role="dialog" aria-modal="true" aria-label="移动标签页">
      <div class="modal-header"><span class="folder-badge">${icon(moveModal.mode === 'copy' ? 'copy' : 'move', 16)}</span><strong>${moveModal.mode === 'copy' ? '复制' : '移动'}标签页</strong><span class="grow"></span><button class="icon-button" data-action="close-move">${icon('close')}</button></div>
      <div class="modal-body"><p style="margin:0 0 14px;color:var(--muted);line-height:1.6">将「${escapeHtml(source?.name || '')}」中选中的 ${selectedSet(moveModal.projectId).size} 个标签页${moveModal.mode === 'copy' ? '复制' : '移动'}到：</p><div class="field"><label for="move-target">目标项目</label><select id="move-target">${targets.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)} · ${project.tabs.length} 个标签页</option>`).join('')}</select></div></div>
      <div class="modal-footer"><button class="modal-button" data-action="close-move">取消</button><button class="modal-button primary" data-action="confirm-move">确认${moveModal.mode === 'copy' ? '复制' : '移动'}</button></div>
    </section>
  </div>`;
}

function renderConfirmModal() {
  if (!confirmModal) return '';
  return `<div class="modal-backdrop confirm-backdrop">
    <section class="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
      <div class="confirm-content">
        <span class="confirm-icon" aria-hidden="true">${icon('trash', 18)}</span>
        <div><strong id="confirm-title">${escapeHtml(confirmModal.title)}</strong><p id="confirm-message">${escapeHtml(confirmModal.message)}</p></div>
      </div>
      <div class="modal-footer"><button class="modal-button" data-action="close-confirm">取消</button><button class="modal-button danger-primary" data-action="confirm-delete">确认删除</button></div>
    </section>
  </div>`;
}

function render() {
  if (!state) {
    app.innerHTML = '<div class="empty-state"><div class="empty-icon">…</div><strong>正在加载 Project Tab</strong><p>准备你的独立标签页空间。</p></div>';
    return;
  }
  const visibleIds = visibleProjectIds();
  const matchingProjects = state.projects.filter((project) => visibleIds.has(project.id));
  const roots = matchingProjects.filter((project) => !project.parentId || !visibleIds.has(project.parentId));
  const activeProjects = roots.filter((project) => !project.archived);
  const archivedProjects = roots.filter((project) => project.archived);
  const activeMarkup = activeProjects.length
    ? activeProjects.map((project) => renderProject(project, visibleIds)).join('')
    : projectEditor?.mode === 'create'
      ? ''
    : `<div class="empty-state compact"><div class="empty-icon">${icon('folder', 21)}</div><strong>${searchQuery ? '没有匹配的项目' : '创建第一个项目'}</strong><p>${searchQuery ? '试试项目名、网页标题或域名。' : '把研究、工作和灵感页面分开管理。'}</p>${searchQuery ? '' : `<button data-action="create-project">${icon('folder-plus', 14)} 创建项目文件夹</button>`}</div>`;
  const archivedMarkup = archivedProjects.length
    ? `<div class="archived-section"><div class="archived-heading"><span>已归档</span><small>${archivedProjects.length}</small></div>${archivedProjects.map((project) => renderProject(project, visibleIds)).join('')}</div>`
    : '';
  app.innerHTML = `<div class="app-shell">
    <div class="panel-sticky-header">
      ${renderTopbar()}
      <div class="search-box"><span>${icon('search', 15)}</span><input id="project-search" value="${escapeHtml(searchQuery)}" placeholder="搜索项目或标签页…"></div>
    </div>
    <div class="content">
      <div class="project-list">${renderNewProjectDraft()}${activeMarkup}${archivedMarkup}</div>
    </div>
    ${renderSummary()}
    <div class="toast"></div>
    ${renderHistoryDrawer()}
    ${renderNoteModal()}
    ${renderProjectNoteModal()}
    ${renderMoveModal()}
    ${renderConfirmModal()}
  </div>`;
}

async function refresh() {
  try {
    state = await apiCall('GET_STATE');
    render();
  } catch (error) {
    showToast(error.message, true);
  }
}

function focusProjectNameEditor() {
  requestAnimationFrame(() => {
    const input = document.querySelector('.project-name-editor');
    if (!input) return;
    input.focus();
    input.select();
  });
}

function createProject() {
  searchQuery = '';
  projectMenuId = null;
  projectEditor = { mode: 'create', projectId: null, parentId: null, value: '' };
  render();
  focusProjectNameEditor();
}

async function createSubfolder(projectId) {
  const project = getProject(projectId);
  if (!project || project.archived) throw new Error('归档项目不能创建子文件夹');
  searchQuery = '';
  projectMenuId = null;
  if (project.collapsed) {
    state = await apiCall('TOGGLE_PROJECT', { projectId });
  }
  projectEditor = { mode: 'create', projectId: null, parentId: projectId, value: '' };
  render();
  focusProjectNameEditor();
}

async function saveProjectEditor(value) {
  if (!projectEditor) return;
  const editor = projectEditor;
  const name = String(value ?? editor.value).trim();
  projectEditor = null;
  if (!name) {
    render();
    return;
  }
  try {
    if (editor.mode === 'create') await apiCall('CREATE_PROJECT', { name, parentId: editor.parentId || null });
    else await apiCall('RENAME_PROJECT', { projectId: editor.projectId, name });
    await refresh();
    showToast(editor.mode === 'create' ? (editor.parentId ? '子文件夹已创建' : '项目已创建') : '项目已重命名');
  } catch (error) {
    projectEditor = editor;
    render();
    focusProjectNameEditor();
    showToast(error.message, true);
  }
}

async function loadHistory() {
  historyLoading = true;
  render();
  try {
    historyItems = await apiCall('SEARCH_HISTORY', { query: historyQuery, maxResults: 300 });
  } catch (error) {
    historyItems = [];
    showToast(error.message, true);
  } finally {
    historyLoading = false;
    render();
  }
}

function openNote(projectId, tabId) {
  const tab = getTab(projectId, tabId);
  noteModal = { projectId, tabId, draft: clone(tab?.note || { blocks: [], updatedAt: null }) };
  projectNoteModal = null;
  moveModal = null;
  render();
}

function openProjectNote(projectId) {
  const project = getProject(projectId);
  projectNoteModal = { projectId, analysis: project?.projectNote?.analysis || null, loading: false };
  noteModal = null;
  moveModal = null;
  render();
}

function updateSearchPreservingFocus(value, selectionStart, selectionEnd = selectionStart) {
  searchQuery = value;
  render();
  const input = document.querySelector('#project-search');
  if (input) {
    input.focus();
    input.setSelectionRange(selectionStart, selectionEnd);
  }
}

function renderHistorySearchPreservingFocus(value, selectionStart) {
  historyQuery = value;
  render();
  const input = document.querySelector('#history-search');
  if (input) {
    input.focus();
    input.setSelectionRange(selectionStart, selectionStart);
  }
  clearTimeout(historyTimer);
  historyTimer = setTimeout(loadHistory, 280);
}

function updateHistorySelectionUI() {
  const count = historySelected.size;
  const label = document.querySelector('[data-history-selection-count]');
  const addButton = document.querySelector('[data-action="add-history"]');
  if (label) label.textContent = `已选 ${count} 个`;
  if (addButton) addButton.disabled = count === 0;
}

function updateNoteBlocksUI() {
  const container = document.querySelector('[data-note-blocks]');
  if (container) container.innerHTML = renderNoteBlocks();
}

async function handleAction(action, element) {
  const projectId = element.dataset.projectId;
  const tabId = element.dataset.tabId;
  if (action !== 'toggle-project-menu') projectMenuId = null;
  try {
    switch (action) {
      case 'create-project':
        createProject();
        break;
      case 'create-subfolder':
        await createSubfolder(projectId);
        break;
      case 'sync':
        showToast('正在同步…');
        await apiCall('SYNC', { direction: 'upload' });
        showToast('已完成手动同步');
        break;
      case 'open-settings':
        await chrome.runtime.openOptionsPage();
        break;
      case 'toggle-pin':
        try {
          if (!chrome.sidePanel?.open || edgePanelWindowId == null) throw new Error('当前面板没有可用的浏览器窗口');
          // 嵌入面板的按钮也必须直接使用这次点击产生的用户手势。
          await chrome.sidePanel.open({ windowId: edgePanelWindowId });
          postPanelMessage('CLOSE_PANEL');
        } catch {
          panelPinned = !panelPinned;
          updatePanelPinButton();
          postPanelMessage('TOGGLE_PIN', { pinned: panelPinned });
        }
        break;
      case 'close-panel':
        postPanelMessage('CLOSE_PANEL');
        break;
      case 'toggle-project-menu':
        projectMenuId = projectMenuId === projectId ? null : projectId;
        render();
        break;
      case 'rename-project': {
        const project = getProject(projectId);
        if (!project) throw new Error('找不到项目');
        projectEditor = { mode: 'rename', projectId, value: project.name };
        render();
        focusProjectNameEditor();
        break;
      }
      case 'archive-project': {
        const project = getProject(projectId);
        if (!project) throw new Error('找不到项目');
        await apiCall('ARCHIVE_PROJECT', { projectId, archived: !project.archived });
        manageProjectId = null;
        await refresh();
        showToast(project.archived ? '项目已恢复' : '项目已归档');
        break;
      }
      case 'toggle-project':
        await apiCall('TOGGLE_PROJECT', { projectId });
        await refresh();
        break;
      case 'open-history':
        historyDrawer = projectId;
        historySelected = new Set();
        historyQuery = '';
        historyItems = [];
        loadHistory();
        break;
      case 'close-history':
        historyDrawer = null;
        render();
        break;
      case 'add-history': {
        const items = [...historySelected].map((key) => historyItems.find((item, index) => (item.id || `${item.url}-${index}`) === key)).filter(Boolean);
        if (!items.length) return;
        const result = await apiCall('ADD_HISTORY_ITEMS', { projectId: historyDrawer, items });
        historyDrawer = null;
        await refresh();
        showToast(`已添加 ${result.added} 个标签页`);
        break;
      }
      case 'manage-project':
        manageProjectId = projectId;
        selectedSet(projectId).clear();
        render();
        break;
      case 'finish-manage':
        manageProjectId = null;
        render();
        break;
      case 'select-all': {
        const selected = selectedSet(projectId);
        const project = getProject(projectId);
        if (project.tabs.every((tab) => selected.has(tab.id))) selected.clear();
        else project.tabs.forEach((tab) => selected.add(tab.id));
        render();
        break;
      }
      case 'batch-move':
      case 'batch-copy':
        if (!selectedSet(projectId).size) return;
        moveModal = { projectId, mode: action === 'batch-copy' ? 'copy' : 'move' };
        render();
        break;
      case 'confirm-move': {
        const targetId = document.querySelector('#move-target')?.value;
        if (!targetId) throw new Error('请选择目标项目');
        const selectedIds = [...selectedSet(moveModal.projectId)];
        const mode = moveModal.mode;
        await apiCall('MOVE_TABS', { sourceProjectId: moveModal.projectId, targetProjectId: targetId, tabIds: selectedIds, copy: mode === 'copy' });
        selectedSet(moveModal.projectId).clear();
        moveModal = null;
        manageProjectId = null;
        await refresh();
        showToast(mode === 'copy' ? '已复制标签页' : '已移动标签页');
        break;
      }
      case 'close-move':
        moveModal = null;
        render();
        break;
      case 'batch-delete': {
        const selectedIds = [...selectedSet(projectId)];
        if (!selectedIds.length) return;
        confirmModal = {
          kind: 'tabs',
          projectId,
          tabIds: selectedIds,
          title: `删除 ${selectedIds.length} 个标签页？`,
          message: '这些条目将从项目中移除，但不会影响浏览器标签页或收藏夹。'
        };
        render();
        break;
      }
      case 'delete-tab': {
        const tab = getTab(projectId, tabId);
        if (!tab) throw new Error('找不到标签页');
        confirmModal = {
          kind: 'tabs',
          projectId,
          tabIds: [tabId],
          keepManaging: true,
          title: `删除“${tab.title || '未命名页面'}”？`,
          message: '这个条目将从项目中移除，但不会影响浏览器标签页或收藏夹。'
        };
        render();
        break;
      }
      case 'delete-project': {
        const project = getProject(projectId);
        if (!project) throw new Error('找不到项目');
        confirmModal = {
          kind: 'project',
          projectId,
          title: `删除“${project.name}”？`,
          message: `项目及其中的 ${project.tabs.length} 个标签页记录将被永久删除，浏览器收藏夹不会受到影响。`
        };
        render();
        break;
      }
      case 'close-confirm':
        confirmModal = null;
        render();
        break;
      case 'confirm-delete': {
        const pending = confirmModal;
        if (!pending) return;
        if (pending.kind === 'tabs') {
          await apiCall('DELETE_TABS', { projectId: pending.projectId, tabIds: pending.tabIds });
          selectedSet(pending.projectId).clear();
          if (!pending.keepManaging) manageProjectId = null;
          confirmModal = null;
          await refresh();
          showToast('已删除项目标签页');
        } else {
          await apiCall('DELETE_PROJECT', { projectId: pending.projectId });
          manageProjectId = null;
          confirmModal = null;
          await refresh();
          showToast('项目已删除');
        }
        break;
      }
      case 'toggle-star':
        await apiCall('TOGGLE_STAR', { projectId, tabId });
        await refresh();
        break;
      case 'open-note':
        openNote(projectId, tabId);
        break;
      case 'open-project-note':
        openProjectNote(projectId);
        break;
      case 'open-tab':
        await apiCall('OPEN_SAVED_TAB', { projectId, tabId });
        showToast('已打开标签页');
        break;
      case 'close-note':
        noteModal = null;
        render();
        break;
      case 'remove-note-block':
        noteModal.draft.blocks.splice(Number(element.dataset.index), 1);
        updateNoteBlocksUI();
        break;
      case 'add-link-draft': {
        const input = document.querySelector('#note-link');
        const value = input?.value.trim();
        if (!value) return;
        noteModal.pendingText = document.querySelector('#note-text')?.value.trim() || noteModal.pendingText || '';
        let url;
        try { url = new URL(value).href; } catch { throw new Error('请输入有效链接'); }
        noteModal.draft.blocks.push({ id: `block_${Date.now()}`, type: 'link', value: url, label: url, createdAt: new Date().toISOString() });
        input.value = '';
        updateNoteBlocksUI();
        break;
      }
      case 'add-image-url': {
        const input = document.querySelector('#note-image-url');
        const value = input?.value.trim();
        if (!value) return;
        noteModal.pendingText = document.querySelector('#note-text')?.value.trim() || noteModal.pendingText || '';
        if (!/^https?:\/\//i.test(value)) throw new Error('图片 URL 需要以 http(s) 开头');
        noteModal.draft.blocks.push({ id: `block_${Date.now()}`, type: 'image', value, label: '远程图片', createdAt: new Date().toISOString() });
        input.value = '';
        updateNoteBlocksUI();
        break;
      }
      case 'save-note': {
        const text = document.querySelector('#note-text')?.value.trim() || noteModal.pendingText?.trim();
        if (text) noteModal.draft.blocks.push({ id: `block_${Date.now()}`, type: 'text', value: text, label: '', createdAt: new Date().toISOString() });
        await apiCall('SAVE_NOTE', { projectId: noteModal.projectId, tabId: noteModal.tabId, note: noteModal.draft });
        noteModal = null;
        await refresh();
        showToast('笔记已保存');
        break;
      }
      case 'close-project-note':
        projectNoteModal = null;
        render();
        break;
      case 'analyze-project':
        projectNoteModal.loading = true;
        render();
        try {
          projectNoteModal.analysis = await apiCall('ANALYZE_PROJECT', { projectId: projectNoteModal.projectId });
          showToast('项目分析已生成');
        } finally {
          projectNoteModal.loading = false;
          render();
        }
        break;
      case 'save-project-note': {
        const text = document.querySelector('#project-note-text')?.value || '';
        await apiCall('SAVE_PROJECT_NOTE', { projectId: projectNoteModal.projectId, text, analysis: projectNoteModal.analysis });
        projectNoteModal = null;
        await refresh();
        showToast('项目笔记已保存');
        break;
      }
      default:
        break;
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

app.addEventListener('click', (event) => {
  const actionElement = event.target.closest('[data-action]');
  if (actionElement) {
    event.stopPropagation();
    handleAction(actionElement.dataset.action, actionElement);
    return;
  }

  const backdrop = event.target.closest('[data-backdrop-action]');
  if (backdrop && event.target === backdrop) {
    handleAction(backdrop.dataset.backdropAction, backdrop);
    return;
  }

  if (event.target.closest('.project-name-editor')) return;

  if (projectMenuId) {
    projectMenuId = null;
    render();
    return;
  }

  const tabRow = event.target.closest('[data-open-tab="true"]');
  if (tabRow && manageProjectId !== tabRow.dataset.projectId) {
    handleAction('open-tab', tabRow);
    return;
  }

  const header = event.target.closest('[data-project-header="true"]');
  if (header) {
    handleAction('toggle-project', header.closest('[data-project-id]'));
  }
});

app.addEventListener('input', (event) => {
  if (event.target.id === 'project-search') {
    updateSearchPreservingFocus(event.target.value, event.target.selectionStart || 0, event.target.selectionEnd || 0);
  } else if (event.target.id === 'history-search') {
    renderHistorySearchPreservingFocus(event.target.value, event.target.selectionStart || 0);
  } else if (event.target.matches('.project-name-editor') && projectEditor) {
    projectEditor.value = event.target.value;
  }
});

app.addEventListener('keydown', (event) => {
  if (confirmModal && event.key === 'Escape') {
    event.preventDefault();
    confirmModal = null;
    render();
    return;
  }
  if (!event.target.matches('.project-name-editor')) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    event.target.blur();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    projectEditor = null;
    render();
  }
});

app.addEventListener('focusout', (event) => {
  if (!event.target.matches('.project-name-editor') || !projectEditor) return;
  saveProjectEditor(event.target.value);
});

app.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.matches('.tab-check')) {
    const selected = selectedSet(target.dataset.projectId);
    if (target.checked) selected.add(target.dataset.tabId);
    else selected.delete(target.dataset.tabId);
    render();
  } else if (target.matches('[data-history-key]')) {
    const key = target.dataset.historyKey;
    if (target.checked) historySelected.add(key);
    else historySelected.delete(key);
    updateHistorySelectionUI();
  } else if (target.id === 'note-image-file' && target.files?.[0]) {
    noteModal.pendingText = document.querySelector('#note-text')?.value.trim() || noteModal.pendingText || '';
    const file = target.files[0];
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      noteModal.draft.blocks.push({ id: `block_${Date.now()}`, type: 'image', value: String(reader.result), label: file.name, createdAt: new Date().toISOString() });
      updateNoteBlocksUI();
    });
    reader.readAsDataURL(file);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.projectTabState?.newValue && !noteModal && !projectNoteModal && !moveModal && !projectEditor && !confirmModal) {
    refresh();
  }
});

cacheEdgePanelWindowId();
refresh();
