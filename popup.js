import { apiCall, escapeHtml, icon } from './shared.js';

const app = document.querySelector('#popup-app');
let state = null;
let activeTab = null;
let toastTimer = null;

function toast(message, error = false) {
  const node = document.querySelector('.toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2200);
}

function render() {
  if (!state || !activeTab) {
    app.innerHTML = '<div class="popup"><div class="empty">正在读取当前标签页…</div></div>';
    return;
  }
  const usable = /^https?:\/\//i.test(activeTab.url || '');
  const projects = state.projects.filter((project) => !project.archived);
  app.innerHTML = `<div class="popup">
    <header class="popup-header"><div class="mark"><img src="logo.png" alt="Project Tab"></div><div class="brand"><strong>Project Tab</strong><small>把当前页面放进一个项目</small></div><button class="popup-icon" data-action="open-sidepanel" title="打开主面板">${icon('menu', 16)}</button></header>
    <section class="active-card"><div class="eyebrow">当前标签页</div><div class="active-title" title="${escapeHtml(activeTab.title || '')}">${escapeHtml(activeTab.title || '未命名页面')}</div><div class="active-url" title="${escapeHtml(activeTab.url || '')}">${escapeHtml(activeTab.url || '此页面不可保存')}</div></section>
    ${usable && projects.length ? `<div class="field"><label for="project-select">选择项目</label><select id="project-select">${projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)} · ${project.tabs.length} 个标签页</option>`).join('')}</select><button class="primary" data-action="add-current">${icon('plus', 14)}添加到项目</button></div>` : usable ? '<div class="empty">当前没有可用项目，请先新建或恢复一个项目。</div>' : '<div class="empty">浏览器内部页面不能被保存，请切换到普通网页。</div>'}
    <section class="project-list"><div class="project-list-header"><span>快速选择项目</span><span>${projects.length} 个项目</span></div><div class="new-project"><input id="new-project-name" placeholder="新建项目文件夹"><button data-action="create-project" title="创建项目">${icon('folder-plus', 15)}</button></div>${projects.slice(0, 5).map((project) => `<button class="quick-project" data-action="quick-add" data-project-id="${escapeHtml(project.id)}"><span class="folder">${icon('folder', 13)}</span><span class="name">${escapeHtml(project.name)}</span><small>${project.tabs.length}</small></button>`).join('')}</section>
    <div class="footer"><span>独立数据，不写入收藏夹</span><button data-action="open-options">${icon('settings', 11)}同步与设置</button></div>
    <div class="toast"></div>
  </div>`;
}

async function load() {
  try {
    const [nextState, active] = await Promise.all([apiCall('GET_STATE'), apiCall('GET_ACTIVE_TAB')]);
    state = nextState;
    activeTab = active.tab;
    render();
  } catch (error) {
    app.innerHTML = `<div class="popup"><div class="empty">${escapeHtml(error.message)}</div></div>`;
  }
}

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === 'add-current' || action === 'quick-add') {
      const projectId = action === 'add-current' ? document.querySelector('#project-select')?.value : button.dataset.projectId;
      if (!projectId) throw new Error('请选择项目');
      const result = await apiCall('ADD_TAB', { projectId, tab: activeTab });
      toast(result.added ? '已添加到项目' : '这个页面已经在项目里了');
      state = result.state;
      render();
    } else if (action === 'create-project') {
      const input = document.querySelector('#new-project-name');
      const name = input?.value.trim();
      if (!name) throw new Error('请输入项目名称');
      state = await apiCall('CREATE_PROJECT', { name });
      render();
      toast('项目已创建');
    } else if (action === 'open-sidepanel') {
      if (!chrome.sidePanel?.open) throw new Error('当前浏览器不支持 Side Panel API');
      if (activeTab?.windowId == null) throw new Error('没有可用的浏览器窗口');
      // 必须在弹出菜单的点击手势中直接调用，不能转发到后台 Service Worker。
      await chrome.sidePanel.open({ windowId: activeTab.windowId });
      window.close();
    } else if (action === 'open-options') {
      await chrome.runtime.openOptionsPage();
      window.close();
    }
  } catch (error) {
    toast(error.message, true);
  }
});

load();
