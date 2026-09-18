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
const WEBDAV_DEFAULT_FILENAME = 'project-tab.json';
const JIANGUOYUN_WEBDAV_HOST = 'dav.jianguoyun.com';

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

function hasFileExtension(pathname) {
  const lastSegment = String(pathname || '').split('/').filter(Boolean).pop() || '';
  return /\.[^./]+$/.test(lastSegment);
}

function isJianguoyunDirectoryUrl(url) {
  if (url.hostname.toLowerCase() !== JIANGUOYUN_WEBDAV_HOST) return false;
  const pathname = url.pathname || '/';
  // 坚果云官方示例支持用 /dav/<文件夹名>（不带结尾斜杠）访问文件夹。
  return (pathname === '/dav' || pathname.startsWith('/dav/')) && !hasFileExtension(pathname);
}

function parseWebDavUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('请先填写 WebDAV 文件或目录地址');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('WebDAV 地址不是有效 URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('WebDAV 地址必须使用 http 或 https');
  }
  return url;
}

function isWebDavDirectoryUrl(url) {
  return url.pathname.endsWith('/') || isJianguoyunDirectoryUrl(url);
}

function normalizeWebDavUrl(value) {
  const url = parseWebDavUrl(value);

  // WebDAV PUT 必须指向“文件资源”，不能直接 PUT 到目录集合。
  // 用户填目录地址时，使用固定文件名让上传可以创建/覆盖独立 JSON 文件。
  // 坚果云的目录地址可以不带结尾斜杠，因此额外识别 /dav/<folder>。
  if (isWebDavDirectoryUrl(url)) {
    const directoryPath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    url.pathname = `${directoryPath}${WEBDAV_DEFAULT_FILENAME}`;
  }
  return url;
}

function normalizeWebDavDirectoryUrl(url) {
  const directory = new URL(url);
  if (!directory.pathname.endsWith('/')) directory.pathname = `${directory.pathname}/`;
  return directory;
}

function encodeBasicCredentials(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function webDavHeaders(config, includeJson = false) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Cache-Control': 'no-store'
  };
  if (includeJson) headers['Content-Type'] = 'application/json; charset=utf-8';
  if (config.username) {
    headers.Authorization = `Basic ${encodeBasicCredentials(config.username, config.password || '')}`;
  }
  return headers;
}

function safeWebDavTarget(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

async function responsePreview(response) {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, 600);
  } catch {
    return '';
  }
}

function webDavStatusHint(status, direction) {
  if (status === 401) return '认证失败：请检查 WebDAV 用户名、密码或应用专用密码。';
  if (status === 403) return direction === 'upload'
    ? '服务器拒绝写入：请确认目标是 WebDAV 文件地址而不是网页地址/目录地址，父目录已存在，账号拥有写入权限，并且服务端没有将该路径设为只读。'
    : direction === 'test'
      ? '服务器拒绝测试该 WebDAV 目录：请确认账号有目录读取权限，并使用服务商提供的 WebDAV 地址。'
    : '服务器拒绝读取：请确认账号拥有该文件的读取权限，并使用服务商提供的 WebDAV 专用地址。';
  if (status === 404) return direction === 'test'
    ? '测试目标不存在：请先在 WebDAV 中创建父目录；目录地址可直接测试，文件地址可在首次上传时创建。'
    : direction === 'upload'
      ? '目标文件或父目录不存在：请先创建父目录，或把地址改成已存在的 WebDAV 目录/文件路径。'
      : '目标文件不存在：请先完成一次上传，或把地址改成已存在的 WebDAV 文件路径。';
  if (status === 405) return '服务器不允许该 WebDAV 方法：当前地址可能不是 WebDAV 端点。';
  if (status === 409) return '父目录不存在或路径冲突：请先在 WebDAV 中创建目录。';
  if (status === 507) return '服务器存储空间不足。';
  return `服务器返回 HTTP ${status}。`;
}

async function throwWebDavError(response, targetUrl, direction) {
  const preview = await responsePreview(response);
  const details = [
    `WebDAV ${direction === 'upload' ? '上传' : '下载'}失败（HTTP ${response.status}）`,
    webDavStatusHint(response.status, direction),
    `目标：${safeWebDavTarget(targetUrl)}`
  ];
  if (preview) details.push(`服务器返回：${preview}`);
  throw new Error(details.join('\n'));
}

async function testWebDav(state) {
  const config = state.settings.webdav;
  const configuredUrl = parseWebDavUrl(config.url);
  const uploadTarget = normalizeWebDavUrl(configuredUrl.toString());
  const probeTarget = isWebDavDirectoryUrl(configuredUrl)
    ? normalizeWebDavDirectoryUrl(configuredUrl)
    : uploadTarget;
  const targetUrl = probeTarget.toString();
  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'PROPFIND',
      headers: {
        ...webDavHeaders(config),
        Depth: '0'
      },
      cache: 'no-store'
    });
  } catch (error) {
    throw new Error(`无法连接 WebDAV：${error?.message || '网络错误'}\n目标：${safeWebDavTarget(targetUrl)}`);
  }

  const preview = await responsePreview(response);
  const result = {
    status: response.status,
    targetUrl: safeWebDavTarget(targetUrl),
    uploadTargetUrl: safeWebDavTarget(uploadTarget),
    dav: response.headers.get('DAV') || '',
    allow: response.headers.get('Allow') || '',
    body: preview
  };
  if (!response.ok) {
    result.hint = webDavStatusHint(response.status, 'test');
  } else {
    result.hint = isWebDavDirectoryUrl(configuredUrl)
      ? 'WebDAV 目录可访问；上传时会写入该目录下的 project-tab.json。'
      : 'WebDAV 文件地址可访问；接下来可以执行上传。';
  }
  return result;
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
  const targetUrl = normalizeWebDavUrl(config?.url);
  const headers = webDavHeaders(config, direction === 'upload');
  if (direction === 'upload') {
    const response = await fetch(targetUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(state, null, 2),
      redirect: 'follow',
      cache: 'no-store'
    });
    if (!response.ok) await throwWebDavError(response, targetUrl, direction);
    return { provider: 'webdav', direction, state, targetUrl: safeWebDavTarget(targetUrl) };
  }
  const response = await fetch(targetUrl, { method: 'GET', headers, redirect: 'follow', cache: 'no-store' });
  if (!response.ok) await throwWebDavError(response, targetUrl, direction);
  let remotePayload;
  try {
    remotePayload = JSON.parse(await response.text());
  } catch {
    throw new Error(`WebDAV 下载成功，但返回的不是有效 JSON。\n目标：${safeWebDavTarget(targetUrl)}`);
  }
  const remote = normalizeState(remotePayload);
  const next = await saveState(remote);
  return { provider: 'webdav', direction, state: next, targetUrl: safeWebDavTarget(targetUrl) };
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
  const result = await requestAiModel(state.settings.ai, [
    {
      role: 'system',
      content: '你是 Project Tab 的知识整理助手。请用中文输出简洁的项目摘要、标签页关联和下一步建议。不要编造页面没有提供的事实。'
    },
    { role: 'user', content: JSON.stringify({ project: project.name, tabs: notes }) }
  ], { temperature: 0.2 });
  const text = extractAiText(result);
  if (!text) throw new Error('AI 接口没有返回可读文本');
  return {
    ...local,
    provider: '自定义 AI 接口',
    overview: text,
    rawText: text,
    generatedAt: new Date().toISOString()
  };
}

function safeAiEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(endpoint || '');
  }
}

function aiResponsePreview(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function extractAiText(result) {
  if (typeof result === 'string') return result.trim();
  if (!result || typeof result !== 'object') return '';
  if (typeof result.__text === 'string') return result.__text.trim();

  const content = result.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('').trim();
  }
  const delta = result.choices?.[0]?.delta?.content;
  if (typeof delta === 'string') return delta.trim();
  if (typeof result.choices?.[0]?.text === 'string') return result.choices[0].text.trim();
  if (typeof result.output_text === 'string') return result.output_text.trim();
  if (typeof result.text === 'string') return result.text.trim();
  if (typeof result.response === 'string') return result.response.trim();

  const geminiParts = result.candidates?.[0]?.content?.parts;
  if (Array.isArray(geminiParts)) return geminiParts.map((part) => part?.text || '').join('').trim();
  const responseParts = result.output?.flatMap?.((item) => item?.content || []) || [];
  if (responseParts.length) return responseParts.map((part) => part?.text || '').join('').trim();
  return '';
}

function parseAiResponse(raw) {
  const normalized = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!normalized) return null;
  try {
    return JSON.parse(normalized);
  } catch {
    const chunks = normalized
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith('data:'))
      .map((line) => line.trim().slice(5).trim())
      .filter((line) => line && line !== '[DONE]')
      .map((line) => {
        try {
          return extractAiText(JSON.parse(line));
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    if (chunks.length) return { __text: chunks.join('') };
    return null;
  }
}

async function requestAiModel(config, messages, options = {}) {
  const endpoint = String(config?.endpoint || '').trim();
  if (!endpoint) throw new Error('请先填写 AI Endpoint');
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json'
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model || undefined,
        messages,
        temperature: options.temperature ?? 0.2,
        stream: false
      }),
      redirect: 'follow',
      cache: 'no-store'
    });
  } catch (error) {
    throw new Error(`无法连接 AI 接口：${error?.message || '网络错误'}\n地址：${safeAiEndpoint(endpoint)}`);
  }

  const raw = await response.text();
  const result = parseAiResponse(raw);
  if (!response.ok) {
    const detail = result?.error?.message || result?.message || aiResponsePreview(raw);
    throw new Error(`AI 接口返回 HTTP ${response.status}${detail ? `\n服务器返回：${detail}` : ''}\n地址：${safeAiEndpoint(endpoint)}`);
  }
  if (!result) {
    const contentType = response.headers.get('content-type') || '未知';
    const plainText = String(raw || '').trim();
    const looksLikeHtml = /^\s*<(?:!doctype|html|head|body|title)\b/i.test(plainText);
    if (response.ok && plainText && !looksLikeHtml && /^(?:text\/plain|text\/event-stream)/i.test(contentType)) {
      return { __text: plainText };
    }
    throw new Error(`AI 接口返回的不是有效 JSON（HTTP ${response.status}）。请确认 Endpoint 是 Chat Completions 接口，而不是网页地址。\nContent-Type：${contentType}\n服务器返回：${aiResponsePreview(raw) || '空响应'}\n地址：${safeAiEndpoint(endpoint)}`);
  }
  return result;
}

async function testAiModel(state) {
  const config = state.settings.ai;
  const result = await requestAiModel(config, [
    { role: 'system', content: '这是连接测试。请只回复“连接成功”，不要输出 JSON、Markdown 或解释。' },
    { role: 'user', content: '连接测试，请回复：连接成功' }
  ], { temperature: 0 });
  const reply = extractAiText(result);
  if (!reply) throw new Error('AI 接口已响应，但响应中没有可读文本');
  return {
    endpoint: safeAiEndpoint(config.endpoint),
    model: config.model || '服务端默认模型',
    reply: reply.slice(0, 240)
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
      const parentId = typeof message.parentId === 'string' ? message.parentId.trim() || null : null;
      const parent = parentId ? projectById(state, parentId) : null;
      if (parentId && (!parent || parent.archived)) throw new Error('请选择有效的父项目');
      state.projects.unshift({
        id: createId('project'),
        parentId,
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
    case 'AI_TEST':
      return testAiModel(await loadState());
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
    case 'WEBDAV_TEST':
      return testWebDav(await loadState());
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
