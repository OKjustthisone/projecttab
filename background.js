import {
  STORAGE_KEY,
  SYNC_KEY,
  clone,
  createId,
  domainFromUrl,
  isWebUrl,
  localProjectAnalysis,
  normalizeState,
  normalizeTabInput
} from './shared.js';

const ALARM_NAME = 'project-tab-auto-sync';

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const state = normalizeState(stored[STORAGE_KEY]);
  if (!stored[STORAGE_KEY] || stored[STORAGE_KEY].version !== state.version) {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  }
  return state;
}

async function saveState(state) {
  const next = normalizeState({ ...state, updatedAt: new Date().toISOString() });
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

function projectById(state, projectId) {
  return state.projects.find((project) => project.id === projectId);
}

function tabById(project, tabId) {
  return project?.tabs.find((tab) => tab.id === tabId);
}

function makeTabRecord(input) {
  const record = normalizeTabInput(input);
  if (!record.domain) record.domain = domainFromUrl(record.url);
  return record;
}

function addRecord(project, input) {
  if (!isWebUrl(input.url)) throw new Error('只支持添加 http(s) 网页标签页');
  const duplicate = project.tabs.find((tab) => tab.url === input.url);
  if (duplicate) {
    if (Number.isInteger(input.id)) duplicate.browserTabId = input.id;
    if (input.title) duplicate.title = input.title;
    if (input.favIconUrl) duplicate.favicon = input.favIconUrl;
    return { tab: duplicate, added: false };
  }
  const tab = makeTabRecord(input);
  project.tabs.unshift(tab);
  project.updatedAt = new Date().toISOString();
  return { tab, added: true };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function openSavedTab(projectId, tabId) {
  const state = await loadState();
  const project = projectById(state, projectId);
  const saved = tabById(project, tabId);
  if (!saved) throw new Error('找不到这个项目标签页');

  if (!isWebUrl(saved.url)) throw new Error('该条目不是可打开的网页地址');
  const openTabs = await chrome.tabs.query({});
  const current = openTabs.find((tab) => tab.url === saved.url || (tab.id === saved.browserTabId && isWebUrl(tab.url)));
  let opened;
  if (current?.id != null) {
    opened = await chrome.tabs.update(current.id, { active: true });
    if (current.windowId != null) await chrome.windows.update(current.windowId, { focused: true });
  } else {
    opened = await chrome.tabs.create({ url: saved.url, active: true });
  }

  saved.browserTabId = opened?.id ?? saved.browserTabId;
  saved.lastOpenedAt = new Date().toISOString();
  await saveState(state);
  return { tab: saved };
}

async function moveOrCopyTabs({ sourceProjectId, targetProjectId, tabIds, copy }) {
  const state = await loadState();
  const source = projectById(state, sourceProjectId);
  const target = projectById(state, targetProjectId);
  if (!source || !target) throw new Error('请选择有效的来源和目标项目');
  if (sourceProjectId === targetProjectId) throw new Error('来源和目标项目不能相同');

  const selected = source.tabs.filter((tab) => tabIds.includes(tab.id));
  for (const tab of selected) {
    if (!target.tabs.some((item) => item.url === tab.url)) {
      target.tabs.unshift(copy ? { ...clone(tab), id: createId('tab'), addedAt: new Date().toISOString() } : tab);
    }
  }
  if (!copy) source.tabs = source.tabs.filter((tab) => !tabIds.includes(tab.id));
  const now = new Date().toISOString();
  source.updatedAt = now;
  target.updatedAt = now;
  return saveState(state);
}

async function performSync(direction, stateOverride) {
  const state = stateOverride ? normalizeState(stateOverride) : await loadState();
  const provider = state.settings.syncProvider;
  if (provider === 'browser') {
    if (direction === 'upload') {
      await chrome.storage.sync.set({ [SYNC_KEY]: state });
      return { provider: 'browser', direction, state };
    }
    const stored = await chrome.storage.sync.get(SYNC_KEY);
    if (!stored[SYNC_KEY]) throw new Error('浏览器同步空间里还没有 Project Tab 数据');
    const next = await saveState(stored[SYNC_KEY]);
    return { provider: 'browser', direction, state: next };
  }

  const config = state.settings.webdav;
  if (!config?.url) throw new Error('请先在设置中填写 WebDAV 地址');
  const headers = { 'Content-Type': 'application/json' };
  if (config.username) {
    headers.Authorization = `Basic ${btoa(`${config.username}:${config.password || ''}`)}`;
  }
  if (direction === 'upload') {
    const response = await fetch(config.url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(state, null, 2)
    });
    if (!response.ok) throw new Error(`WebDAV 上传失败（HTTP ${response.status}）`);
    return { provider: 'webdav', direction, state };
  }
  const response = await fetch(config.url, { method: 'GET', headers, cache: 'no-store' });
  if (!response.ok) throw new Error(`WebDAV 下载失败（HTTP ${response.status}）`);
  const remote = normalizeState(await response.json());
  const next = await saveState(remote);
  return { provider: 'webdav', direction, state: next };
}

async function scheduleSync(state) {
  if (!chrome.alarms) return;
  await chrome.alarms.clear(ALARM_NAME);
  if (state.settings.autoSync) {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: state.settings.autoSyncIntervalHours * 60
    });
  }
}

async function updateSettings(patch) {
  const state = await loadState();
  state.settings = {
    ...state.settings,
    ...patch,
    triggerRange: { ...state.settings.triggerRange, ...(patch.triggerRange || {}) },
    webdav: { ...state.settings.webdav, ...(patch.webdav || {}) },
    ai: { ...state.settings.ai, ...(patch.ai || {}) }
  };
  const next = await saveState(state);
  await scheduleSync(next);
  return next;
}

async function analyzeProject(projectId) {
  const state = await loadState();
  const project = projectById(state, projectId);
  if (!project) throw new Error('找不到项目');
  const local = localProjectAnalysis(project);
  const endpoint = state.settings.ai.endpoint?.trim();
  if (!endpoint) return local;

  const notes = project.tabs.map((tab) => ({
    title: tab.title,
    url: tab.url,
    note: (tab.note?.blocks || []).map((block) => block.value).join('\n')
  }));
  const headers = { 'Content-Type': 'application/json' };
  if (state.settings.ai.apiKey) headers.Authorization = `Bearer ${state.settings.ai.apiKey}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: state.settings.ai.model || undefined,
      messages: [
        {
          role: 'system',
          content: '你是 Project Tab 的知识整理助手。请用中文输出简洁的项目摘要、标签页关联和下一步建议。不要编造页面没有提供的事实。'
        },
        { role: 'user', content: JSON.stringify({ project: project.name, tabs: notes }) }
      ],
      temperature: 0.2
    })
  });
  if (!response.ok) throw new Error(`AI 接口返回 HTTP ${response.status}`);
  const result = await response.json();
  const text = result.choices?.[0]?.message?.content || result.output_text || result.text;
  if (!text) throw new Error('AI 接口没有返回可读文本');
  return {
    ...local,
    provider: '自定义 AI 接口',
    overview: text,
    rawText: text,
    generatedAt: new Date().toISOString()
  };
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'GET_STATE':
      return loadState();
    case 'GET_ACTIVE_TAB':
      return { tab: await getActiveTab() };
    case 'CREATE_PROJECT': {
      const state = await loadState();
      const now = new Date().toISOString();
      state.projects.unshift({
        id: createId('project'),
        name: String(message.name || '新项目').trim() || '新项目',
        color: message.color || '#18a76b',
        collapsed: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
        tabs: [],
        projectNote: { text: '', updatedAt: null, analysis: null }
      });
      return saveState(state);
    }
    case 'RENAME_PROJECT': {
      const state = await loadState();
      const project = projectById(state, message.projectId);
      if (!project) throw new Error('找不到项目');
      project.name = String(message.name || '').trim() || project.name;
      project.updatedAt = new Date().toISOString();
      return saveState(state);
    }
    case 'TOGGLE_PROJECT': {
      const state = await loadState();
      const project = projectById(state, message.projectId);
      if (!project) throw new Error('找不到项目');
      project.collapsed = !project.collapsed;
      return saveState(state);
    }
    case 'ARCHIVE_PROJECT': {
      const state = await loadState();
      const project = projectById(state, message.projectId);
      if (!project) throw new Error('找不到项目');
      project.archived = typeof message.archived === 'boolean' ? message.archived : !project.archived;
      project.collapsed = project.archived ? true : project.collapsed;
      project.updatedAt = new Date().toISOString();
      return saveState(state);
    }
    case 'DELETE_PROJECT': {
      const state = await loadState();
      if (state.projects.length <= 1) throw new Error('至少保留一个项目');
      state.projects = state.projects.filter((project) => project.id !== message.projectId);
      return saveState(state);
    }
    case 'ADD_CURRENT_TAB': {
      const active = await getActiveTab();
      if (!active?.url) throw new Error('没有可用的当前标签页');
      const state = await loadState();
      const project = projectById(state, message.projectId);
      if (!project) throw new Error('找不到项目');
      const result = addRecord(project, active);
      const next = await saveState(state);
      return { state: next, added: result.added, tab: result.tab };
    }
    case 'ADD_TAB': {
      const state = await loadState();
      const project = projectById(state, message.projectId);
      if (!project) throw new Error('找不到项目');
      const result = addRecord(project, message.tab || {});
      const next = await saveState(state);
      return { state: next, added: result.added, tab: result.tab };
    }
    case 'ADD_HISTORY_ITEMS': {
      const state = await loadState();
      const project = projectById(state, message.projectId);
      if (!project) throw new Error('找不到项目');
      let added = 0;
      for (const item of message.items || []) {
        const result = addRecord(project, item);
        if (result.added) added += 1;
      }
      const next = await saveState(state);
      return { state: next, added };
    }
    case 'SEARCH_HISTORY': {
      const items = await chrome.history.search({
        text: message.query || '',
        maxResults: Math.min(500, Math.max(10, Number(message.maxResults) || 100)),
        startTime: Date.now() - 1000 * 60 * 60 * 24 * 90
      });
      return items.filter((item) => isWebUrl(item.url));
    }
    case 'OPEN_SAVED_TAB':
      return openSavedTab(message.projectId, message.tabId);
    case 'TOGGLE_STAR': {
      const state = await loadState();
      const project = projectById(state, message.projectId);
      const tab = tabById(project, message.tabId);
      if (!tab) throw new Error('找不到标签页');
      tab.starred = !tab.starred;
      project.updatedAt = new Date().toISOString();
      return saveState(state);
    }
    case 'SAVE_NOTE': {
      const state = await loadState();
      const project = projectById(state, message.projectId);
      const tab = tabById(project, message.tabId);
      if (!tab) throw new Error('找不到标签页');
      tab.note = message.note || { blocks: [], updatedAt: null };
      tab.note.updatedAt = new Date().toISOString();
      project.updatedAt = new Date().toISOString();
      return saveState(state);
    }
    case 'SAVE_PROJECT_NOTE': {
      const state = await loadState();
      const project = projectById(state, message.projectId);
      if (!project) throw new Error('找不到项目');
      project.projectNote = {
        text: String(message.text || ''),
        updatedAt: new Date().toISOString(),
        analysis: message.analysis || project.projectNote?.analysis || null
      };
      project.updatedAt = new Date().toISOString();
      return saveState(state);
    }
    case 'ANALYZE_PROJECT':
      return analyzeProject(message.projectId);
    case 'DELETE_TABS': {
      const state = await loadState();
      const project = projectById(state, message.projectId);
      if (!project) throw new Error('找不到项目');
      project.tabs = project.tabs.filter((tab) => !message.tabIds.includes(tab.id));
      project.updatedAt = new Date().toISOString();
      return saveState(state);
    }
    case 'MOVE_TABS':
      return moveOrCopyTabs(message);
    case 'UPDATE_SETTINGS':
      return updateSettings(message.patch || {});
    case 'SYNC':
      return performSync(message.direction || 'upload');
    case 'IMPORT_STATE':
      return saveState(message.state);
    case 'OPEN_SIDE_PANEL': {
      if (!chrome.sidePanel?.open) throw new Error('当前浏览器不支持 Side Panel API');
      const active = sender?.tab || await getActiveTab();
      if (active?.windowId != null) await chrome.sidePanel.open({ windowId: active.windowId });
      else throw new Error('没有可用的浏览器窗口');
      return { opened: true };
    }
    default:
      throw new Error(`未知消息类型：${message.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const state = await loadState();
  await scheduleSync(state);
  if (chrome.sidePanel?.setOptions) {
    await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true }).catch(() => {});
  }
});

chrome.runtime.onStartup?.addListener(async () => {
  await scheduleSync(await loadState());
});

chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const state = await loadState();
  if (!state.settings.autoSync) return;
  try {
    await performSync('upload', state);
  } catch (error) {
    console.warn('Project Tab 自动同步失败', error);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title && !changeInfo.favIconUrl) return;
  if (!tab?.url || !isWebUrl(tab.url)) return;
  const state = await loadState();
  let changed = false;
  for (const project of state.projects) {
    for (const saved of project.tabs) {
      if (saved.browserTabId === tabId) {
        saved.url = tab.url;
        saved.title = tab.title || saved.title;
        saved.favicon = tab.favIconUrl || saved.favicon;
        saved.domain = domainFromUrl(tab.url);
        project.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
  }
  if (changed) await saveState(state);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadState();
  let changed = false;
  for (const project of state.projects) {
    for (const saved of project.tabs) {
      if (saved.browserTabId === tabId) {
        saved.browserTabId = null;
        changed = true;
      }
    }
  }
  if (changed) await saveState(state);
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEY]?.newValue) {
    await scheduleSync(normalizeState(changes[STORAGE_KEY].newValue));
  }
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'open-project-tab' || !chrome.sidePanel?.open) return;
  const active = await getActiveTab();
  if (active?.windowId != null) await chrome.sidePanel.open({ windowId: active.windowId });
});
