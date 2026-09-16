export const STORAGE_KEY = 'projectTabState';
export const SYNC_KEY = 'projectTabSyncState';

export const DEFAULT_SETTINGS = {
  sidebarMode: 'edge',
  triggerWidth: 0,
  triggerRange: {
    startPercent: 20,
    endPercent: 30
  },
  autoSync: false,
  autoSyncIntervalHours: 6,
  syncProvider: 'browser',
  webdav: {
    url: '',
    username: '',
    password: ''
  },
  ai: {
    endpoint: '',
    model: '',
    apiKey: ''
  }
};

export function createId(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createEmptyState() {
  const now = new Date().toISOString();
  return {
    version: 2,
    updatedAt: now,
    projects: [
      {
        id: createId('project'),
        name: '灵感收藏',
        color: '#18a76b',
        collapsed: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
        tabs: [],
        projectNote: {
          text: '',
          updatedAt: null,
          analysis: null
        }
      }
    ],
    settings: structuredClone(DEFAULT_SETTINGS)
  };
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizePercent(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function normalizeTriggerRange(value) {
  const source = value && typeof value === 'object' ? value : {};
  let startPercent = normalizePercent(source.startPercent, DEFAULT_SETTINGS.triggerRange.startPercent);
  let endPercent = normalizePercent(source.endPercent, DEFAULT_SETTINGS.triggerRange.endPercent);

  if (endPercent <= startPercent) {
    if (startPercent >= 100) {
      startPercent = 99;
      endPercent = 100;
    } else {
      endPercent = startPercent + 1;
    }
  }

  return { startPercent, endPercent };
}

function normalizeTriggerWidth(value, sourceVersion) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_SETTINGS.triggerWidth;
  if (sourceVersion < 2 && number === 18) return DEFAULT_SETTINGS.triggerWidth;
  return Math.min(80, Math.max(0, Math.round(number)));
}

function normalizeNote(note) {
  const source = note && typeof note === 'object' ? note : {};
  const blocks = Array.isArray(source.blocks)
    ? source.blocks
        .filter((block) => block && typeof block === 'object')
        .map((block) => ({
          id: asString(block.id, createId('block')),
          type: ['text', 'image', 'link'].includes(block.type) ? block.type : 'text',
          value: asString(block.value),
          label: asString(block.label),
          createdAt: asString(block.createdAt, new Date().toISOString())
        }))
    : [];
  return {
    blocks,
    updatedAt: source.updatedAt ? asString(source.updatedAt) : null
  };
}

function normalizeTab(tab) {
  const source = tab && typeof tab === 'object' ? tab : {};
  return {
    id: asString(source.id, createId('tab')),
    url: asString(source.url),
    title: asString(source.title, source.url || '未命名页面'),
    favicon: asString(source.favicon),
    domain: asString(source.domain),
    browserTabId: Number.isInteger(source.browserTabId) ? source.browserTabId : null,
    addedAt: asString(source.addedAt, new Date().toISOString()),
    lastOpenedAt: source.lastOpenedAt ? asString(source.lastOpenedAt) : null,
    starred: asBoolean(source.starred),
    note: normalizeNote(source.note)
  };
}

function normalizeProject(project) {
  const source = project && typeof project === 'object' ? project : {};
  return {
    id: asString(source.id, createId('project')),
    name: asString(source.name, '未命名项目'),
    color: asString(source.color, '#18a76b'),
    collapsed: asBoolean(source.collapsed),
    archived: asBoolean(source.archived),
    createdAt: asString(source.createdAt, new Date().toISOString()),
    updatedAt: asString(source.updatedAt, new Date().toISOString()),
    tabs: Array.isArray(source.tabs) ? source.tabs.map(normalizeTab) : [],
    projectNote: {
      text: asString(source.projectNote?.text),
      updatedAt: source.projectNote?.updatedAt ? asString(source.projectNote.updatedAt) : null,
      analysis: source.projectNote?.analysis && typeof source.projectNote.analysis === 'object'
        ? source.projectNote.analysis
        : null
    }
  };
}

export function normalizeState(value) {
  const fallback = createEmptyState();
  const source = value && typeof value === 'object' ? value : {};
  const settings = source.settings && typeof source.settings === 'object' ? source.settings : {};
  const webdav = settings.webdav && typeof settings.webdav === 'object' ? settings.webdav : {};
  const ai = settings.ai && typeof settings.ai === 'object' ? settings.ai : {};
  const projects = Array.isArray(source.projects) ? source.projects.map(normalizeProject) : fallback.projects;
  const sourceVersion = Number.isFinite(Number(source.version)) ? Number(source.version) : 1;

  return {
    version: 2,
    updatedAt: asString(source.updatedAt, fallback.updatedAt),
    projects: projects.length ? projects : fallback.projects,
    settings: {
      ...DEFAULT_SETTINGS,
      ...settings,
      sidebarMode: settings.sidebarMode === 'fixed' ? 'fixed' : 'edge',
      triggerWidth: normalizeTriggerWidth(settings.triggerWidth, sourceVersion),
      triggerRange: normalizeTriggerRange(settings.triggerRange),
      autoSync: asBoolean(settings.autoSync),
      autoSyncIntervalHours: Math.min(168, Math.max(1, Number(settings.autoSyncIntervalHours) || DEFAULT_SETTINGS.autoSyncIntervalHours)),
      syncProvider: ['browser', 'webdav'].includes(settings.syncProvider) ? settings.syncProvider : 'browser',
      webdav: {
        ...DEFAULT_SETTINGS.webdav,
        ...webdav
      },
      ai: {
        ...DEFAULT_SETTINGS.ai,
        ...ai
      }
    }
  };
}

export function clone(value) {
  return structuredClone(value);
}

export function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

export function normalizeTabInput(tab) {
  return {
    id: createId('tab'),
    url: asString(tab?.url),
    title: asString(tab?.title, tab?.url || '未命名页面'),
    favicon: asString(tab?.favIconUrl || tab?.favicon),
    domain: domainFromUrl(tab?.url),
    browserTabId: Number.isInteger(tab?.id) ? tab.id : null,
    addedAt: new Date().toISOString(),
    lastOpenedAt: null,
    starred: false,
    note: { blocks: [], updatedAt: null }
  };
}

export function icon(name, size = 16) {
  const paths = {
    folder: '<path d="M3 5.8A1.8 1.8 0 0 1 4.8 4h3.1l1.6 1.7h5.7A1.8 1.8 0 0 1 17 7.5v7.7a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 15.2V5.8Z"/><path d="M3.2 7.1h13.6"/>',
    'folder-plus': '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.5h7.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z"/><path d="M12 10v6M9 13h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pencil: '<path d="m4.5 15.5-.8 3.3 3.3-.8L17.8 7.2a2.2 2.2 0 0 0-3.1-3.1L3.9 14.9Z"/><path d="m12.8 5.8 3.4 3.4"/>',
    check: '<path d="m5 12.5 4.3 4.2L19 7"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    sync: '<path d="M4 9a8 8 0 0 1 13.7-3.7L20 8"/><path d="M20 4v4h-4M20 15a8 8 0 0 1-13.7 3.7L4 16"/><path d="M4 20v-4h4"/>',
    refresh: '<path d="M21 12a9 9 0 0 0-15.5-6.2L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.5 6.2L21 16"/><path d="M16 16h5v5"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4 4"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
    note: '<path d="M5 3.5h9.5L18 7v13.5H5V3.5Z"/><path d="M14.5 3.5V7H18M8 11h7M8 14.5h7M8 18h4"/>',
    spark: '<path d="m12 3 1.2 5.2L18 10l-4.8 1.8L12 17l-1.2-5.2L6 10l4.8-1.8L12 3ZM19 15l.6 2.4L22 18l-2.4.6L19 21l-.6-2.4L16 18l2.4-.6L19 15Z"/>',
    trash: '<path d="M4 7h16M10 11v5M14 11v5M6.5 7l.7 12.5h9.6L17.5 7M9 7V4.5h6V7"/>',
    copy: '<rect x="8" y="8" width="10" height="11" rx="1.5"/><path d="M6 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8A1.5 1.5 0 0 1 14.5 5v1"/>',
    move: '<path d="M4 7h11M11 3l4 4-4 4M20 17H9M13 13l-4 4 4 4"/>',
    pin: '<path d="M7 3h10l-1.5 7 3 3H5.5l3-3L7 3Z"/><path d="M12 13v8"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.73v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.73l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v4.5A1.5 1.5 0 0 1 16.5 19h-11A1.5 1.5 0 0 1 4 17.5v-11A1.5 1.5 0 0 1 5.5 5H10"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
    history: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.7"/><path d="M4 4v4.7h4.7M12 7v5l3.5 2"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    cloud: '<path d="M7.5 18.5a4.5 4.5 0 1 1 1.6-8.7A5.6 5.6 0 0 1 20 12.2a3.3 3.3 0 0 1-.3 6.6H7.5Z"/>',
    download: '<path d="M12 4v10M8 11l4 4 4-4M5 19h14"/>',
    upload: '<path d="M12 15V5M8 9l4-4 4 4M5 19h14"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    archive: '<path d="M4 7.5h16v12H4v-12Z"/><path d="M3 4.5h18v3H3v-3ZM9 11h6"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 10.8v5.4M12 7.8h.01"/>',
    image: '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="m5 17 4-4 3 3 2-2 5 5"/>',
    link: '<path d="M10 13.5 8.7 14.8a3.2 3.2 0 1 1-4.5-4.5l3.1-3.1a3.2 3.2 0 0 1 4.5 0M14 10.5l1.3-1.3a3.2 3.2 0 1 1 4.5 4.5l-3.1 3.1a3.2 3.2 0 0 1-4.5 0M8.5 12h7"/>',
    menuDots: '<circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none"/>'
  };
  return `<svg class="pt-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatDate(value) {
  if (!value) return '尚未编辑';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '尚未编辑';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

export function truncate(value, length = 80) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function collectNoteText(tab) {
  return (tab?.note?.blocks || [])
    .map((block) => block.type === 'link' ? `${block.label || ''} ${block.value}` : block.value)
    .join(' ')
    .trim();
}

export function localProjectAnalysis(project) {
  const tabs = project?.tabs || [];
  const domainMap = new Map();
  const wordMap = new Map();
  const tokensFor = (text) => {
    const normalized = String(text || '').toLowerCase();
    const latin = normalized.match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
    const cjk = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
    return [...latin, ...cjk].filter((token) => !['https', 'www', 'http'].includes(token));
  };

  for (const tab of tabs) {
    const domain = tab.domain || domainFromUrl(tab.url) || '其他来源';
    domainMap.set(domain, (domainMap.get(domain) || 0) + 1);
    const text = `${tab.title} ${collectNoteText(tab)}`;
    for (const token of tokensFor(text)) wordMap.set(token, (wordMap.get(token) || 0) + 1);
  }

  const domains = [...domainMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count }));
  const keywords = [...wordMap.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  const relationships = [];
  for (let index = 0; index < tabs.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < tabs.length; otherIndex += 1) {
      const left = tabs[index];
      const right = tabs[otherIndex];
      const leftDomain = left.domain || domainFromUrl(left.url);
      const rightDomain = right.domain || domainFromUrl(right.url);
      const shared = tokensFor(`${left.title} ${collectNoteText(left)}`)
        .filter((token) => tokensFor(`${right.title} ${collectNoteText(right)}`).includes(token));
      if (leftDomain && leftDomain === rightDomain) {
        relationships.push({
          left: left.title,
          right: right.title,
          reason: `同一来源：${leftDomain}`
        });
      } else if (shared.length) {
        relationships.push({
          left: left.title,
          right: right.title,
          reason: `共享关键词：${shared.slice(0, 3).join('、')}`
        });
      }
      if (relationships.length >= 8) break;
    }
    if (relationships.length >= 8) break;
  }

  const overview = tabs.length
    ? `项目「${project.name}」包含 ${tabs.length} 个标签页，主要聚集在 ${domains.slice(0, 3).map((item) => item.name).join('、') || '多个来源'}。${keywords.length ? `高频主题包括：${keywords.slice(0, 5).map((item) => item.name).join('、')}。` : '为获得更具体的主题，建议为标签页补充笔记。'}`
    : '项目目前还没有标签页，添加页面后即可生成归纳。';

  return {
    provider: '本地分析',
    generatedAt: new Date().toISOString(),
    overview,
    domains,
    keywords,
    relationships
  };
}

export function apiCall(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response) {
        reject(new Error('扩展后台未响应'));
        return;
      }
      if (!response.ok) {
        reject(new Error(response.error || '操作失败'));
        return;
      }
      resolve(response.data);
    });
  });
}
