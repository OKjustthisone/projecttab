import { apiCall, CONTEXT_INVALIDATED_MESSAGE, escapeHtml, icon, isExtensionContextAlive } from './shared.js';

const app = document.querySelector('#options-app');
let state = null;
let toastTimer = null;
let sidePanelWindowId = null;
// 归档项目管理区（数据管理卡片内）的本地 UI 状态，默认收起。
let archivesOpen = false;
let archiveMenuId = null;
let archiveEditId = null;
let archiveDeleteConfirmId = null;

const AI_PRESETS = [
  { id: 'local', label: '本地分析（无需 API）', endpoint: '', model: '' },
  { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash' },
  { id: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/free' },
  { id: 'custom', label: '自定义兼容接口', endpoint: null, model: null }
];

function selectedAiPreset(ai) {
  if (!ai.endpoint && !ai.model) return 'local';
  return AI_PRESETS.find((preset) => preset.endpoint === ai.endpoint && preset.model === ai.model)?.id || 'custom';
}

function notify(message, error = false) {
  const node = document.querySelector('.toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

function setSyncStatus(message, error = false) {
  const node = document.querySelector('#sync-status');
  if (!node) return;
  node.textContent = message;
  node.className = `status${error ? ' error' : ' ok'}`;
}

function setAiStatus(message, error = false) {
  const node = document.querySelector('#ai-status');
  if (!node) return;
  node.textContent = message;
  node.className = `status${error ? ' error' : ' ok'}`;
}

function render() {
  if (!state) {
    app.innerHTML = '<div class="settings-shell"><div class="card">正在加载设置…</div></div>';
    return;
  }
  const settings = state.settings;
  // “项目”统计只计算最高层文件夹，子文件夹不重复计数。
  const projects = state.projects.filter((project) => !project.parentId).length;
  const tabs = state.projects.reduce((sum, project) => sum + project.tabs.length, 0);
  const notes = state.projects.reduce((sum, project) => sum + project.tabs.reduce((tabSum, tab) => tabSum + (tab.note?.blocks?.length || 0), 0), 0);
  // 重建表单（如展开/收起归档列表）时，保留排除域名输入框里尚未保存的内容，避免丢字。
  const excludeTextarea = document.querySelector('#exclude-domains');
  const excludeDomainsText = excludeTextarea ? excludeTextarea.value : (settings.excludeDomains || []).join('\n');
  app.innerHTML = `<div class="settings-shell">
    <header class="settings-hero"><div class="mark"><img src="logo.png" alt="Project Tab"></div><div class="hero-copy"><h1>Project Tab 设置</h1><p>管理边栏、同步方式与 AI 笔记分析。项目数据不会写入浏览器收藏夹。</p></div><button class="hero-link" data-action="open-sidepanel">${icon('menu', 14)}打开主面板</button></header>
    <div class="grid">
      <div>
        <section class="card"><div class="section-head"><div><h2>页面边栏</h2><p>选择 Project Tab 如何出现在网页旁边。</p></div></div>
          <div class="field"><label>显示方式</label><div class="choice-row"><label class="choice"><input type="radio" name="sidebarMode" value="fixed" ${settings.sidebarMode === 'fixed' ? 'checked' : ''}><strong>固定显示</strong><small>使用浏览器 Side Panel 持续打开</small></label><label class="choice"><input type="radio" name="sidebarMode" value="edge" ${settings.sidebarMode === 'edge' ? 'checked' : ''}><strong>左侧边缘触发</strong><small>鼠标靠近网页左边缘时显示触发条</small></label></div></div>
          <div class="field"><label>触发高度范围</label><div class="percent-range-row"><label class="percent-field" for="trigger-start"><span>从顶部</span><span class="percent-input"><input id="trigger-start" type="number" min="0" max="99" step="1" value="${settings.triggerRange.startPercent}"><span>%</span></span></label><span class="percent-separator">至</span><label class="percent-field" for="trigger-end"><span>到顶部</span><span class="percent-input"><input id="trigger-end" type="number" min="1" max="100" step="1" value="${settings.triggerRange.endPercent}"><span>%</span></span></label><span class="range-value" id="trigger-range-value">${settings.triggerRange.startPercent}% – ${settings.triggerRange.endPercent}%</span></div><div class="help">按网页高度从上到下计算，0% 是顶部、100% 是底部。只有这段左侧区域会触发面板，例如 20%–30%。</div></div>
          <div class="field"><label for="trigger-width">触发条宽度</label><div class="range-line"><input id="trigger-width" type="range" min="0" max="80" step="1" value="${settings.triggerWidth}"><span class="range-value" id="trigger-width-value">${settings.triggerWidth}px</span></div><div class="help">默认为 0px，不显示绿色触发条；光标必须贴住页面左缘（约 1px 内）才能打开面板，面板打开后光标移入窗口边框不会收起，向右移开才会自动关闭。</div></div>
          <div class="field"><label for="exclude-domains">边缘触发排除域名</label><textarea id="exclude-domains" rows="4" placeholder="例如：&#10;example.com&#10;*.internal.example.com">${escapeHtml(excludeDomainsText)}</textarea><div class="help">每行一个域名（逗号、分号分隔也可以），会自动去掉地址中的协议和路径。填写 example.com 时该域名及其全部子域名（如 docs.example.com）的网页都禁用边缘触发；以 *. 开头只匹配子域名本身。填入后点击「保存边栏设置」，或直接在输入框外点击一下即可保存生效。</div></div>
          <div class="actions"><button class="button primary" data-action="save-settings">保存边栏设置</button></div>
        </section>
        <section class="card"><div class="section-head"><div><h2>同步方式</h2><p>支持浏览器账户同步或自有 WebDAV 文件。</p></div></div>
          <div class="field"><label for="sync-provider">默认同步目的地</label><select id="sync-provider"><option value="browser" ${settings.syncProvider === 'browser' ? 'selected' : ''}>浏览器账户同步（Chrome / Edge）</option><option value="webdav" ${settings.syncProvider === 'webdav' ? 'selected' : ''}>WebDAV</option></select></div>
          <div class="field"><label class="switch-row"><input id="auto-sync" type="checkbox" ${settings.autoSync ? 'checked' : ''}><span>开启自动同步</span></label><div class="help">开启后本地修改会在数秒内自动与上面选定的目的地（浏览器同步空间或 WebDAV）双向合并，定时与浏览器启动时也会执行。合并按项目/标签页的修改时间取较新一方，双方的新增和修改都会保留。</div></div>
          <div class="field"><label for="auto-sync-hours">自动同步间隔（小时）</label><input id="auto-sync-hours" type="number" min="1" max="168" value="${settings.autoSyncIntervalHours}"></div>
          <div class="field"><label for="webdav-url">WebDAV 文件或目录地址</label><input id="webdav-url" type="url" value="${escapeHtml(settings.webdav.url)}" placeholder="https://dav.jianguoyun.com/dav/projecttab/project-tab.json"><div class="help">可填写文件地址，也可填写目录地址；目录地址会自动使用其中的 project-tab.json，但父目录需先在坚果云中存在。坚果云可填写 /dav/projecttab 或 /dav/projecttab/，密码请使用第三方应用密码。账号密码仅保存在本机扩展存储中。</div></div>
          <div class="field"><label for="webdav-user">WebDAV 用户名</label><input id="webdav-user" type="text" value="${escapeHtml(settings.webdav.username)}" autocomplete="off"></div>
          <div class="field"><label for="webdav-password">WebDAV 密码</label><input id="webdav-password" type="password" value="${escapeHtml(settings.webdav.password)}" autocomplete="off"></div>
          <div class="actions"><button class="button primary" data-action="save-settings">保存设置</button><button class="button" data-action="sync-both">${icon('sync', 14)}双向同步（合并）</button><button class="button" data-action="sync-browser-upload">${icon('upload', 14)}上传到浏览器同步</button><button class="button" data-action="sync-browser-download">${icon('download', 14)}从浏览器同步下载</button><button class="button" data-action="test-webdav">${icon('info', 14)}测试 WebDAV</button><button class="button" data-action="sync-webdav-upload">${icon('upload', 14)}上传到 WebDAV</button><button class="button" data-action="sync-webdav-download">${icon('download', 14)}从 WebDAV 下载</button></div><div class="help">多设备请使用「双向同步（合并）」：先合并远端与本地再推送，不会覆盖另一台电脑的修改。上传/下载按钮为单向整体覆盖，谨慎使用。</div><div class="status" id="sync-status"></div>
        </section>
      </div>
      <div>
        <section class="card"><div class="section-head"><div><h2>主面板显示</h2><p>控制标签页列表中的当前页面提示与笔记编辑方式。</p></div></div>
          <div class="field"><label class="switch-row"><input id="highlight-active-tab" type="checkbox" ${settings.highlightActiveTab ? 'checked' : ''}><span>高亮当前浏览器标签页</span></label><div class="help">在主面板的标签页列表中，用颜色标出当前正在浏览的页面，并显示“当前”标签。</div></div>
          <div class="field"><label for="active-tab-highlight-color">当前标签页高亮颜色</label><div class="color-field-row"><input id="active-tab-highlight-color" type="color" value="${escapeHtml(settings.activeTabHighlightColor)}"><span class="color-value" id="active-tab-highlight-color-value">${escapeHtml(settings.activeTabHighlightColor)}</span></div><div class="help">选择任意颜色；面板会把它用于当前标签页的背景、左侧色条和“当前”标签。</div></div>
          <div class="field"><label>标签页笔记打开方式</label><div class="choice-row"><label class="choice"><input type="radio" name="noteEditorMode" value="panel" ${settings.noteEditorMode !== 'window' ? 'checked' : ''}><strong>面板内编辑</strong><small>在侧边栏弹窗中编辑，可随时放大</small></label><label class="choice"><input type="radio" name="noteEditorMode" value="window" ${settings.noteEditorMode === 'window' ? 'checked' : ''}><strong>独立大窗口</strong><small>直接打开约 940px 宽的笔记编辑器</small></label></div><div class="help">无论选择哪种方式，笔记弹窗右上角都提供“在独立大窗口编辑”按钮。</div></div>
          <div class="actions"><button class="button primary" data-action="save-settings">保存显示设置</button></div>
        </section>
        <section class="card"><div class="section-head"><div><h2>AI 笔记分析</h2><p>默认使用本地规则分析标题、来源和笔记；也可接入兼容 OpenAI Chat Completions 的自定义接口。</p></div></div>
          <div class="field"><label for="ai-preset">常用服务预设</label><select id="ai-preset">${AI_PRESETS.map((preset) => `<option value="${preset.id}" ${selectedAiPreset(settings.ai) === preset.id ? 'selected' : ''}>${preset.label}</option>`).join('')}</select><div class="help">选择后自动填写 Endpoint 和推荐模型；API Key 仍需自行填写并只保存在本机。</div></div>
          <div class="field"><label for="ai-endpoint">自定义 AI Endpoint（可选）</label><input id="ai-endpoint" type="url" value="${escapeHtml(settings.ai.endpoint)}" placeholder="https://api.example.com/v1/chat/completions"></div>
          <div class="field"><label for="ai-model">模型名（可选）</label><input id="ai-model" type="text" value="${escapeHtml(settings.ai.model)}" placeholder="例如 gpt-4o-mini"></div>
          <div class="field"><label for="ai-key">API Key（可选）</label><input id="ai-key" type="password" value="${escapeHtml(settings.ai.apiKey)}" autocomplete="off" placeholder="仅保存在本机扩展存储中"></div>
          <div class="actions"><button class="button" data-action="test-ai">${icon('info', 14)}测试 AI 模型连接</button></div><div class="status" id="ai-status"></div>
          <div class="subtle">没有配置 Endpoint 时，点击项目名右侧的 ✦ 仍会生成本地摘要、来源聚类、关键词和标签页关联。需要外部模型时，请确认服务端的隐私与跨域策略。</div>
        </section>
        <section class="card"><div class="section-head"><div><h2>数据管理</h2><p>导出的是 Project Tab 自己的 JSON，不含浏览器收藏夹。</p></div></div>
          <div class="data-stat"><div class="stat"><strong>${projects}</strong><span>项目</span></div><div class="stat"><strong>${tabs}</strong><span>标签页</span></div><div class="stat"><strong>${notes}</strong><span>笔记块</span></div></div>
          <div class="actions"><button class="button" data-action="export-json">${icon('download', 14)}导出 JSON</button><label class="button file-button">${icon('upload', 14)}导入 JSON<input id="import-json" type="file" accept="application/json,.json"></label></div>
          ${renderArchivedSection()}
          <p class="footer-note">提示：图片笔记会以 data URL 存进 JSON，文件可能较大。跨设备同步前可以先导出一份备份。</p>
        </section>
      </div>
    </div>
    <div class="toast"></div>
  </div>`;
}

async function load() {
  try {
    const [nextState, windowId] = await Promise.all([apiCall('GET_STATE'), getCurrentWindowId()]);
    state = nextState;
    sidePanelWindowId = windowId;
    render();
  } catch (error) {
    app.innerHTML = `<div class="settings-shell"><div class="card">${escapeHtml(error.message)}</div></div>`;
  }
}

async function getCurrentWindowId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null) return tab.windowId;
  } catch {
    // fall through to the current browser window
  }
  try {
    const currentWindow = await chrome.windows.getCurrent();
    return currentWindow?.id ?? null;
  } catch {
    return null;
  }
}

async function openSidePanelFromOptions() {
  if (!chrome.sidePanel?.open) throw new Error('当前浏览器不支持 Side Panel API');
  if (sidePanelWindowId == null) throw new Error('没有可用的浏览器窗口，请重新打开设置页');
  // 保持 sidePanel.open 位于设置页按钮的用户点击调用栈内。
  await chrome.sidePanel.open({ windowId: sidePanelWindowId });
}

function formSettings() {
  const readNumber = (selector, fallback) => {
    const value = Number(document.querySelector(selector)?.value);
    return Number.isFinite(value) ? value : fallback;
  };

  return {
    sidebarMode: document.querySelector('input[name="sidebarMode"]:checked')?.value || 'edge',
    triggerWidth: readNumber('#trigger-width', 0),
    excludeDomains: (document.querySelector('#exclude-domains')?.value || '')
      .split(/[\n,;，；\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
    triggerRange: {
      startPercent: readNumber('#trigger-start', 20),
      endPercent: readNumber('#trigger-end', 30)
    },
    autoSync: Boolean(document.querySelector('#auto-sync')?.checked),
    autoSyncIntervalHours: Number(document.querySelector('#auto-sync-hours')?.value || 6),
    highlightActiveTab: Boolean(document.querySelector('#highlight-active-tab')?.checked),
    activeTabHighlightColor: document.querySelector('#active-tab-highlight-color')?.value || '#16a568',
    noteEditorMode: document.querySelector('input[name="noteEditorMode"]:checked')?.value === 'window' ? 'window' : 'panel',
    syncProvider: document.querySelector('#sync-provider')?.value || 'browser',
    webdav: {
      url: document.querySelector('#webdav-url')?.value.trim() || '',
      username: document.querySelector('#webdav-user')?.value || '',
      password: document.querySelector('#webdav-password')?.value || ''
    },
    ai: {
      endpoint: document.querySelector('#ai-endpoint')?.value.trim() || '',
      model: document.querySelector('#ai-model')?.value.trim() || '',
      apiKey: document.querySelector('#ai-key')?.value || ''
    }
  };
}

async function saveSettings() {
  state = await apiCall('UPDATE_SETTINGS', { patch: formSettings() });
  const excludeTextarea = document.querySelector('#exclude-domains');
  if (excludeTextarea) excludeTextarea.value = state.settings.excludeDomains.join('\n');
  render();
  notify('设置已保存');
}

// 排除域名输入框失焦时静默保存：只提交该字段，不重建表单（避免清掉其他正在编辑的输入），
// 保存成功后把归一化结果（去掉协议/路径）回填到输入框，让用户确认保存内容。
async function saveExcludeDomainsQuietly() {
  const patch = { excludeDomains: formSettings().excludeDomains };
  state = await apiCall('UPDATE_SETTINGS', { patch });
  const textarea = document.querySelector('#exclude-domains');
  if (textarea) textarea.value = state.settings.excludeDomains.join('\n');
  notify('边缘触发排除域名已保存');
}

async function sync(direction, provider) {
  const label = direction === 'both' ? '双向同步' : direction === 'upload' ? '上传' : '下载';
  setSyncStatus(`正在${label}…`);
  if (provider) {
    const patch = { syncProvider: provider };
    const form = formSettings();
    patch.webdav = form.webdav;
    state = await apiCall('UPDATE_SETTINGS', { patch });
  }
  if (direction === 'both') {
    const form = formSettings();
    state = await apiCall('UPDATE_SETTINGS', { patch: { syncProvider: form.syncProvider, webdav: form.webdav } });
  }
  const result = await apiCall('SYNC', { direction });
  state = result.state;
  render();
  if (direction === 'both') {
    const details = [
      `双向同步完成：${result.changed ? '本地已合并远端修改' : '本地无变化'}`,
      result.pushed ? '已写回远端' : '远端已最新'
    ];
    if (result.targetUrl) details.push(`目标：${result.targetUrl}`);
    setSyncStatus(details.join('\n'));
    notify('双向同步完成');
    return;
  }
  setSyncStatus(`同步${label}完成${result.targetUrl ? `\n目标：${result.targetUrl}` : ''}`);
  notify(`同步${label}完成`);
}

async function testWebDav() {
  const form = formSettings();
  state = await apiCall('UPDATE_SETTINGS', { patch: { webdav: form.webdav } });
  setSyncStatus('正在测试 WebDAV 端点…');
  const result = await apiCall('WEBDAV_TEST');
  const details = [result.hint, `目标：${result.targetUrl}`];
  if (result.uploadTargetUrl && result.uploadTargetUrl !== result.targetUrl) details.push(`上传目标：${result.uploadTargetUrl}`);
  if (result.dav) details.push(`DAV：${result.dav}`);
  if (result.allow) details.push(`Allow：${result.allow}`);
  if (result.body) details.push(`服务器返回：${result.body}`);
  const failed = result.status >= 400;
  setSyncStatus(details.join('\n'), failed);
  notify(failed ? `WebDAV 返回 HTTP ${result.status}` : 'WebDAV 端点可访问', failed);
}

async function testAi() {
  state = await apiCall('UPDATE_SETTINGS', { patch: { ai: formSettings().ai } });
  setAiStatus('正在测试 AI 模型连接…');
  const result = await apiCall('AI_TEST');
  const details = [
    'AI 模型连接成功',
    `模型：${result.model}`,
    `地址：${result.endpoint}`
  ];
  if (result.reply) details.push(`模型回复：${result.reply}`);
  setAiStatus(details.join('\n'));
  notify('AI 模型连接成功');
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `project-tab-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
  notify('JSON 已导出');
}

function resetArchiveUi() {
  archiveMenuId = null;
  archiveEditId = null;
  archiveDeleteConfirmId = null;
}

// 数据管理卡片内的「归档项目」折叠区：默认收起，展开后只列项目名，
// 右侧三点菜单提供重命名、恢复项目、删除项目。
function renderArchivedSection() {
  const archived = state.projects.filter((project) => project.archived);
  const rows = archived.map((project) => {
    if (archiveEditId === project.id) {
      return `<div class="archive-row editing" data-project-id="${escapeHtml(project.id)}">
        <input id="archive-rename-input" value="${escapeHtml(project.name)}" maxlength="60" aria-label="重命名归档项目">
        <button class="archive-menu-button" data-action="archive-rename-commit" data-project-id="${escapeHtml(project.id)}" title="确认重命名">${icon('check', 14)}</button>
        <button class="archive-menu-button" data-action="archive-rename-cancel" title="取消重命名">${icon('x', 14)}</button>
      </div>`;
    }
    const menuOpen = archiveMenuId === project.id;
    const deleting = archiveDeleteConfirmId === project.id;
    return `<div class="archive-row${menuOpen ? ' has-menu' : ''}" data-project-id="${escapeHtml(project.id)}">
      <span class="archive-name" title="${escapeHtml(project.name)}">${escapeHtml(project.name)}</span>
      <button class="archive-menu-button" data-action="archive-menu" data-project-id="${escapeHtml(project.id)}" aria-label="${escapeHtml(project.name)} 的更多操作">${icon('menuDots', 14)}</button>
      ${menuOpen ? `<div class="archive-menu" role="menu" aria-label="${escapeHtml(project.name)} 的归档操作">
        <button data-action="archive-rename" data-project-id="${escapeHtml(project.id)}" role="menuitem">${icon('pencil', 14)}<span>重命名</span></button>
        <button data-action="archive-restore" data-project-id="${escapeHtml(project.id)}" role="menuitem">${icon('archive', 14)}<span>恢复项目</span></button>
        <button data-action="archive-delete" data-project-id="${escapeHtml(project.id)}" role="menuitem" class="${deleting ? 'danger' : ''}">${icon('trash', 14)}<span>${deleting ? '确认删除' : '删除项目'}</span></button>
      </div>` : ''}
    </div>`;
  }).join('');
  return `<div class="field archive-field">
    <button type="button" class="button archive-toggle" data-action="toggle-archives">${icon('archive', 14)}<span>归档项目</span><span class="archive-count">${archived.length}</span><span class="archive-caret">${archivesOpen ? '▾' : '▸'}</span></button>
    ${archivesOpen ? `<div class="archive-list">${rows || '<p class="archive-empty">暂无归档项目。</p>'}</div><div class="help">归档项目只在设置页管理，不在主面板列表显示；恢复后重新回到面板，删除会连同子目录与标签页一并移除。</div>` : ''}
  </div>`;
}

app.addEventListener('input', (event) => {
  if (event.target.id === 'active-tab-highlight-color') {
    const value = document.querySelector('#active-tab-highlight-color-value');
    if (value) value.textContent = event.target.value;
  }
  if (event.target.id === 'trigger-width') {
    const value = document.querySelector('#trigger-width-value');
    if (value) value.textContent = `${event.target.value}px`;
  }
  if (event.target.id === 'trigger-start' || event.target.id === 'trigger-end') {
    const start = document.querySelector('#trigger-start')?.value || 0;
    const end = document.querySelector('#trigger-end')?.value || 0;
    const value = document.querySelector('#trigger-range-value');
    if (value) value.textContent = `${start}% – ${end}%`;
  }
  if (event.target.id === 'ai-endpoint' || event.target.id === 'ai-model') {
    const preset = document.querySelector('#ai-preset');
    if (preset) {
      preset.value = selectedAiPreset({
        endpoint: document.querySelector('#ai-endpoint')?.value.trim() || '',
        model: document.querySelector('#ai-model')?.value.trim() || ''
      });
    }
  }
});

// 归档项目重命名：提交给 RENAME_PROJECT，空名保持原名。
async function commitArchiveRename(projectId) {
  const name = document.querySelector('#archive-rename-input')?.value.trim() || '';
  if (name) state = await apiCall('RENAME_PROJECT', { projectId, name });
  archiveEditId = null;
  archiveMenuId = null;
  render();
  notify(name ? '归档项目已重命名' : '名称为空，未修改');
}

app.addEventListener('keydown', (event) => {
  if (event.target.id !== 'archive-rename-input') return;
  const projectId = event.target.closest('.archive-row')?.dataset.projectId;
  if (!projectId) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    commitArchiveRename(projectId).catch((error) => notify(isExtensionContextAlive() ? error.message : CONTEXT_INVALIDATED_MESSAGE, true));
  } else if (event.key === 'Escape') {
    event.preventDefault();
    archiveEditId = null;
    render();
  }
});

app.addEventListener('change', async (event) => {
  if (event.target.id === 'ai-preset') {
    const preset = AI_PRESETS.find((item) => item.id === event.target.value);
    if (preset && preset.endpoint !== null) {
      document.querySelector('#ai-endpoint').value = preset.endpoint;
      document.querySelector('#ai-model').value = preset.model;
    }
    return;
  }
  if (event.target.id === 'exclude-domains') {
    try {
      await saveExcludeDomainsQuietly();
    } catch (error) {
      const message = isExtensionContextAlive() ? error.message : CONTEXT_INVALIDATED_MESSAGE;
      notify(message, true);
    }
    return;
  }
  if (event.target.id !== 'import-json' || !event.target.files?.[0]) return;
  try {
    const content = await event.target.files[0].text();
    const imported = JSON.parse(content);
    state = await apiCall('IMPORT_STATE', { state: imported });
    render();
    notify('JSON 已导入');
  } catch (error) {
    notify(`导入失败：${error.message}`, true);
  }
});

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) {
    // 点击菜单以外的空白处时收起归档项目的三点菜单；表单控件（输入框/单选等）除外，
    // 避免重建表单覆盖用户刚点击或正在输入的状态。
    if (archiveMenuId && !event.target.closest('.archive-menu') && !event.target.closest('input, select, textarea, label')) {
      archiveMenuId = null;
      render();
    }
    return;
  }
  const archiveProjectId = button.dataset.projectId;
  try {
    switch (button.dataset.action) {
      case 'save-settings':
        await saveSettings();
        break;
      case 'toggle-archives': {
        archivesOpen = !archivesOpen;
        resetArchiveUi();
        render();
        break;
      }
      case 'archive-menu': {
        archiveMenuId = archiveMenuId === archiveProjectId ? null : archiveProjectId;
        archiveEditId = null;
        archiveDeleteConfirmId = archiveMenuId === archiveProjectId ? archiveDeleteConfirmId : null;
        render();
        break;
      }
      case 'archive-rename': {
        archiveEditId = archiveProjectId;
        archiveMenuId = null;
        archiveDeleteConfirmId = null;
        render();
        document.querySelector('#archive-rename-input')?.focus();
        break;
      }
      case 'archive-rename-commit':
        await commitArchiveRename(archiveProjectId);
        break;
      case 'archive-rename-cancel':
        archiveEditId = null;
        render();
        break;
      case 'archive-restore':
        state = await apiCall('ARCHIVE_PROJECT', { projectId: archiveProjectId, archived: false });
        resetArchiveUi();
        render();
        notify('项目已恢复到主面板');
        break;
      case 'archive-delete':
        if (archiveDeleteConfirmId !== archiveProjectId) {
          archiveDeleteConfirmId = archiveProjectId;
          render();
          break;
        }
        state = await apiCall('DELETE_PROJECT', { projectId: archiveProjectId });
        resetArchiveUi();
        render();
        notify('归档项目已删除');
        break;
      case 'sync-both':
        await sync('both');
        break;
      case 'sync-browser-upload':
        await sync('upload', 'browser');
        break;
      case 'sync-browser-download':
        await sync('download', 'browser');
        break;
      case 'sync-webdav-upload':
        await sync('upload', 'webdav');
        break;
      case 'sync-webdav-download':
        await sync('download', 'webdav');
        break;
      case 'test-webdav':
        await testWebDav();
        break;
      case 'test-ai':
        await testAi();
        break;
      case 'export-json':
        exportJson();
        break;
      case 'open-sidepanel':
        await openSidePanelFromOptions();
        break;
      default:
        break;
    }
  } catch (error) {
    const message = isExtensionContextAlive() ? error.message : CONTEXT_INVALIDATED_MESSAGE;
    if (button.dataset.action.includes('sync') || button.dataset.action === 'test-webdav') {
      setSyncStatus(message, true);
    }
    if (button.dataset.action === 'test-ai') setAiStatus(message, true);
    notify(message, true);
  }
});

load();
