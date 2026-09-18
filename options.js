import { apiCall, escapeHtml, icon } from './shared.js';

const app = document.querySelector('#options-app');
let state = null;
let toastTimer = null;
let sidePanelWindowId = null;

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
  const tabs = state.projects.reduce((sum, project) => sum + project.tabs.length, 0);
  const notes = state.projects.reduce((sum, project) => sum + project.tabs.reduce((tabSum, tab) => tabSum + (tab.note?.blocks?.length || 0), 0), 0);
  app.innerHTML = `<div class="settings-shell">
    <header class="settings-hero"><div class="mark"><img src="logo.png" alt="Project Tab"></div><div class="hero-copy"><h1>Project Tab 设置</h1><p>管理边栏、同步方式与 AI 笔记分析。项目数据不会写入浏览器收藏夹。</p></div><button class="hero-link" data-action="open-sidepanel">${icon('menu', 14)}打开主面板</button></header>
    <div class="grid">
      <div>
        <section class="card"><div class="section-head"><div><h2>页面边栏</h2><p>选择 Project Tab 如何出现在网页旁边。</p></div></div>
          <div class="field"><label>显示方式</label><div class="choice-row"><label class="choice"><input type="radio" name="sidebarMode" value="fixed" ${settings.sidebarMode === 'fixed' ? 'checked' : ''}><strong>固定显示</strong><small>使用浏览器 Side Panel 持续打开</small></label><label class="choice"><input type="radio" name="sidebarMode" value="edge" ${settings.sidebarMode === 'edge' ? 'checked' : ''}><strong>左侧边缘触发</strong><small>鼠标靠近网页左边缘时显示触发条</small></label></div></div>
          <div class="field"><label>触发高度范围</label><div class="percent-range-row"><label class="percent-field" for="trigger-start"><span>从顶部</span><span class="percent-input"><input id="trigger-start" type="number" min="0" max="99" step="1" value="${settings.triggerRange.startPercent}"><span>%</span></span></label><span class="percent-separator">至</span><label class="percent-field" for="trigger-end"><span>到顶部</span><span class="percent-input"><input id="trigger-end" type="number" min="1" max="100" step="1" value="${settings.triggerRange.endPercent}"><span>%</span></span></label><span class="range-value" id="trigger-range-value">${settings.triggerRange.startPercent}% – ${settings.triggerRange.endPercent}%</span></div><div class="help">按网页高度从上到下计算，0% 是顶部、100% 是底部。只有这段左侧区域会触发面板，例如 20%–30%。</div></div>
          <div class="field"><label for="trigger-width">触发条宽度</label><div class="range-line"><input id="trigger-width" type="range" min="0" max="80" step="1" value="${settings.triggerWidth}"><span class="range-value" id="trigger-width-value">${settings.triggerWidth}px</span></div><div class="help">默认为 0px，不显示绿色触发条；鼠标贴近页面左缘时仍可打开面板。</div></div>
          <div class="field"><label class="switch-row"><input id="auto-sync" type="checkbox" ${settings.autoSync ? 'checked' : ''}><span>开启自动同步</span></label><div class="help">自动同步只会写入你选定的浏览器同步空间或 WebDAV。</div></div>
          <div class="field"><label for="auto-sync-hours">自动同步间隔（小时）</label><input id="auto-sync-hours" type="number" min="1" max="168" value="${settings.autoSyncIntervalHours}"></div>
        </section>
        <section class="card"><div class="section-head"><div><h2>同步方式</h2><p>支持浏览器账户同步或自有 WebDAV 文件。</p></div></div>
          <div class="field"><label for="sync-provider">默认同步目的地</label><select id="sync-provider"><option value="browser" ${settings.syncProvider === 'browser' ? 'selected' : ''}>浏览器账户同步（Chrome / Edge）</option><option value="webdav" ${settings.syncProvider === 'webdav' ? 'selected' : ''}>WebDAV</option></select></div>
          <div class="field"><label for="webdav-url">WebDAV 文件或目录地址</label><input id="webdav-url" type="url" value="${escapeHtml(settings.webdav.url)}" placeholder="https://dav.jianguoyun.com/dav/projecttab/project-tab.json"><div class="help">可填写文件地址，也可填写目录地址；目录地址会自动使用其中的 project-tab.json，但父目录需先在坚果云中存在。坚果云可填写 /dav/projecttab 或 /dav/projecttab/，密码请使用第三方应用密码。账号密码仅保存在本机扩展存储中。</div></div>
          <div class="field"><label for="webdav-user">WebDAV 用户名</label><input id="webdav-user" type="text" value="${escapeHtml(settings.webdav.username)}" autocomplete="off"></div>
          <div class="field"><label for="webdav-password">WebDAV 密码</label><input id="webdav-password" type="password" value="${escapeHtml(settings.webdav.password)}" autocomplete="off"></div>
          <div class="actions"><button class="button primary" data-action="save-settings">保存设置</button><button class="button" data-action="sync-browser-upload">${icon('upload', 14)}上传到浏览器同步</button><button class="button" data-action="sync-browser-download">${icon('download', 14)}从浏览器同步下载</button><button class="button" data-action="test-webdav">${icon('info', 14)}测试 WebDAV</button><button class="button" data-action="sync-webdav-upload">${icon('upload', 14)}上传到 WebDAV</button><button class="button" data-action="sync-webdav-download">${icon('download', 14)}从 WebDAV 下载</button></div><div class="status" id="sync-status"></div>
        </section>
      </div>
      <div>
        <section class="card"><div class="section-head"><div><h2>AI 笔记分析</h2><p>默认使用本地规则分析标题、来源和笔记；也可接入兼容 OpenAI Chat Completions 的自定义接口。</p></div></div>
          <div class="field"><label for="ai-preset">常用服务预设</label><select id="ai-preset">${AI_PRESETS.map((preset) => `<option value="${preset.id}" ${selectedAiPreset(settings.ai) === preset.id ? 'selected' : ''}>${preset.label}</option>`).join('')}</select><div class="help">选择后自动填写 Endpoint 和推荐模型；API Key 仍需自行填写并只保存在本机。</div></div>
          <div class="field"><label for="ai-endpoint">自定义 AI Endpoint（可选）</label><input id="ai-endpoint" type="url" value="${escapeHtml(settings.ai.endpoint)}" placeholder="https://api.example.com/v1/chat/completions"></div>
          <div class="field"><label for="ai-model">模型名（可选）</label><input id="ai-model" type="text" value="${escapeHtml(settings.ai.model)}" placeholder="例如 gpt-4o-mini"></div>
          <div class="field"><label for="ai-key">API Key（可选）</label><input id="ai-key" type="password" value="${escapeHtml(settings.ai.apiKey)}" autocomplete="off" placeholder="仅保存在本机扩展存储中"></div>
          <div class="actions"><button class="button" data-action="test-ai">${icon('info', 14)}测试 AI 模型连接</button></div><div class="status" id="ai-status"></div>
          <div class="subtle">没有配置 Endpoint 时，点击项目名右侧的 ✦ 仍会生成本地摘要、来源聚类、关键词和标签页关联。需要外部模型时，请确认服务端的隐私与跨域策略。</div>
        </section>
        <section class="card"><div class="section-head"><div><h2>数据管理</h2><p>导出的是 Project Tab 自己的 JSON，不含浏览器收藏夹。</p></div></div>
          <div class="data-stat"><div class="stat"><strong>${state.projects.length}</strong><span>项目</span></div><div class="stat"><strong>${tabs}</strong><span>标签页</span></div><div class="stat"><strong>${notes}</strong><span>笔记块</span></div></div>
          <div class="actions"><button class="button" data-action="export-json">${icon('download', 14)}导出 JSON</button><label class="button file-button">${icon('upload', 14)}导入 JSON<input id="import-json" type="file" accept="application/json,.json"></label></div>
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
    triggerRange: {
      startPercent: readNumber('#trigger-start', 20),
      endPercent: readNumber('#trigger-end', 30)
    },
    autoSync: Boolean(document.querySelector('#auto-sync')?.checked),
    autoSyncIntervalHours: Number(document.querySelector('#auto-sync-hours')?.value || 6),
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
  render();
  notify('设置已保存');
}

async function sync(direction, provider) {
  setSyncStatus(`正在${direction === 'upload' ? '上传' : '下载'}…`);
  if (provider) {
    const patch = { syncProvider: provider };
    const form = formSettings();
    patch.webdav = form.webdav;
    state = await apiCall('UPDATE_SETTINGS', { patch });
  }
  const result = await apiCall('SYNC', { direction });
  state = result.state;
  render();
  setSyncStatus(`同步${direction === 'upload' ? '上传' : '下载'}完成${result.targetUrl ? `\n目标：${result.targetUrl}` : ''}`);
  notify(`同步${direction === 'upload' ? '上传' : '下载'}完成`);
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

app.addEventListener('input', (event) => {
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

app.addEventListener('change', async (event) => {
  if (event.target.id === 'ai-preset') {
    const preset = AI_PRESETS.find((item) => item.id === event.target.value);
    if (preset && preset.endpoint !== null) {
      document.querySelector('#ai-endpoint').value = preset.endpoint;
      document.querySelector('#ai-model').value = preset.model;
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
  if (!button) return;
  try {
    switch (button.dataset.action) {
      case 'save-settings':
        await saveSettings();
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
    if (button.dataset.action.includes('sync') || button.dataset.action === 'test-webdav') {
      setSyncStatus(error.message, true);
    }
    if (button.dataset.action === 'test-ai') setAiStatus(error.message, true);
    notify(error.message, true);
  }
});

load();
