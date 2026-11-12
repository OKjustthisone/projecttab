(() => {
  if (window.top !== window) return;
  document.querySelectorAll('#project-tab-edge-host').forEach((existingHost) => existingHost.remove());
  document.querySelectorAll('#project-tab-page-shift-style').forEach((existingStyle) => existingStyle.remove());
  document.documentElement.removeAttribute('data-project-tab-pushed');
  document.documentElement.style.removeProperty('--project-tab-panel-width');

  const DEFAULT_TRIGGER_START = 20;
  const DEFAULT_TRIGGER_END = 30;
  const DEFAULT_TRIGGER_WIDTH = 0;
  const TRIGGER_EDGE_WIDTH = 1; // 光标必须真正贴住页面左缘（clientX ≤ 1px，零距离）才触发；含亚像素取整余量
  const PANEL_MAX_WIDTH = 390;

  const pageShiftStyle = document.createElement('style');
  pageShiftStyle.id = 'project-tab-page-shift-style';
  pageShiftStyle.textContent = `
    html[data-project-tab-pushed="true"] {
      box-sizing: border-box !important;
      min-width: 0 !important;
      overflow-x: hidden !important;
    }
    html[data-project-tab-pushed="true"] > body {
      box-sizing: border-box !important;
      width: calc(100% - var(--project-tab-panel-width)) !important;
      max-width: calc(100% - var(--project-tab-panel-width)) !important;
      min-width: 0 !important;
      translate: var(--project-tab-panel-width) 0 !important;
    }
  `;
  (document.head || document.documentElement).append(pageShiftStyle);

  const host = document.createElement('div');
  host.id = 'project-tab-edge-host';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .panel {
      position: fixed;
      z-index: 2147483645;
      left: 0;
      top: 0;
      width: min(390px, calc(100vw - 24px));
      height: 100vh;
      border: 0;
      background: #f7fbf8;
      box-shadow: 14px 0 42px rgba(15, 76, 46, .2);
      transform: translateX(-102%);
      opacity: .2;
      pointer-events: none;
      transition: none;
    }
    .panel.open { transform: translateX(0); opacity: 1; pointer-events: auto; }
    .rail {
      position: fixed;
      z-index: 2147483646;
      left: 0;
      top: var(--pt-trigger-start, 20%);
      width: var(--pt-trigger-width, 0px);
      height: calc(var(--pt-trigger-end, 30%) - var(--pt-trigger-start, 20%));
      overflow: hidden;
      padding: 0;
      border: 0;
      border-radius: 0 14px 14px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(180deg, #1ca96d, #0c8653);
      box-shadow: 0 8px 24px rgba(15, 109, 68, .25);
      color: white;
      cursor: pointer;
      opacity: .25;
      transform: translateX(-3px);
      transition: none;
      user-select: none;
      font: 700 10px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .rail:hover, .rail:focus-visible { opacity: 1; transform: translateX(0); }
    .rail.zero-width, .rail.zero-width:hover, .rail.zero-width:focus-visible { background: transparent; box-shadow: none; opacity: 0; transform: none; }
    .rail[hidden] { display: none; }
    .rail span { writing-mode: vertical-rl; letter-spacing: .08em; }
    .rail svg { width: 16px; height: 16px; margin-bottom: 7px; }
    .rail-content { display:flex; flex-direction:column; align-items:center; gap: 5px; }
  `;
  shadow.append(style);

  const rail = document.createElement('button');
  rail.type = 'button';
  rail.className = 'rail';
  rail.title = '打开 Project Tab';
  rail.innerHTML = '<span class="rail-content"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5.8A1.8 1.8 0 0 1 4.8 4h3.1l1.6 1.7h5.7A1.8 1.8 0 0 1 17 7.5v7.7a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 15.2V5.8Z"/><path d="M3.2 7.1h13.6"/></svg>Project Tab</span>';
  const panel = document.createElement('iframe');
  panel.className = 'panel';
  panel.title = 'Project Tab';
  panel.src = chrome.runtime.getURL('edge-panel.html');
  shadow.append(panel, rail);
  document.documentElement.append(host);
  // 设置读取前先隐藏宿主：排除域名页面上不会闪现触发条，非排除页面随设置恢复显示。
  host.style.display = 'none';

  let isEdgeMode = true;
  let triggerWidth = DEFAULT_TRIGGER_WIDTH;
  let triggerStartPercent = DEFAULT_TRIGGER_START;
  let triggerEndPercent = DEFAULT_TRIGGER_END;
  let edgeTriggerArmed = true;
  let pinned = false;
  let lastPointerX = -1; // 最近一次指针事件的页面横坐标，用于区分“光标滑入窗口边框”与“光标真正向右移开”
  let excludedByDomain = false; // 当前域名命中设置页的边缘触发排除列表
  let settingsApplied = false; // 首次读到设置前不触发，避免排除域名在加载瞬间闪现面板

  const normalizePercent = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : fallback;
  };

  const normalizeTriggerRange = (settings) => {
    const range = settings?.triggerRange && typeof settings.triggerRange === 'object'
      ? settings.triggerRange
      : {};
    let start = normalizePercent(range.startPercent, DEFAULT_TRIGGER_START);
    let end = normalizePercent(range.endPercent, DEFAULT_TRIGGER_END);
    if (end <= start) {
      if (start >= 100) {
        start = 99;
        end = 100;
      } else {
        end = start + 1;
      }
    }
    return { start, end };
  };

  const isPointerOverPanel = () => panel.matches(':hover');

  const edgeHitWidth = () => Math.max(TRIGGER_EDGE_WIDTH, triggerWidth);

  // 排除域名匹配（与 shared.js 的 normalizeExcludeDomains 语义保持一致）：
  // 条目允许整段网址/带路径输入，统一取主机名；普通条目匹配本域与全部子域名，
  // `*.` 前缀条目只匹配子域名。
  const toHostname = (value) => {
    let text = String(value ?? '').trim().toLowerCase();
    if (!text) return '';
    if (!/^https?:\/\//.test(text)) text = `https://${text}`;
    try {
      text = new URL(text).hostname;
    } catch {
      text = text.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
    }
    return text.replace(/\.$/, '');
  };

  const normalizeExcludeDomains = (value) => {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,;，；\s]+/) : [];
    const result = [];
    for (const item of list) {
      const domain = toHostname(item);
      if (domain && !result.includes(domain)) result.push(domain);
    }
    return result;
  };

  const matchesExcludedDomain = (hostname, entries) => entries.some((entry) => {
    if (!entry) return false;
    if (entry.startsWith('*.')) return hostname.endsWith(`.${entry.slice(2)}`);
    return hostname === entry || hostname.endsWith(`.${entry}`);
  });

  const syncPageShift = () => {
    const shouldPushPage = isEdgeMode && pinned && panel.classList.contains('open');
    if (shouldPushPage) {
      const panelWidth = Math.min(PANEL_MAX_WIDTH, Math.max(0, window.innerWidth - 24));
      document.documentElement.style.setProperty('--project-tab-panel-width', `${panelWidth}px`);
    } else {
      document.documentElement.style.removeProperty('--project-tab-panel-width');
    }
    document.documentElement.toggleAttribute('data-project-tab-pushed', shouldPushPage);
  };

  const syncPinState = () => {
    panel.contentWindow?.postMessage({ source: 'project-tab-host', type: 'PIN_STATE', pinned }, '*');
  };

  const setOpen = (open) => {
    if (open && !isEdgeMode) return;
    if (open) edgeTriggerArmed = false;
    panel.classList.toggle('open', open);
    rail.hidden = open;
    syncPageShift();
    if (open) syncPinState();
  };

  const closeIfPointerOutside = () => {
    if (pinned || !panel.classList.contains('open')) return;
    if (!isPointerOverPanel()) setOpen(false);
  };

  const setPinned = (value) => {
    pinned = Boolean(value);
    syncPageShift();
    syncPinState();
  };

  const applySettings = (settings, sourceVersion = 2) => {
    settingsApplied = true;
    isEdgeMode = settings?.sidebarMode !== 'fixed';
    excludedByDomain = matchesExcludedDomain(window.location.hostname, normalizeExcludeDomains(settings?.excludeDomains));
    if (!isEdgeMode || excludedByDomain) {
      setPinned(false);
      setOpen(false);
    }
    const configuredWidth = Number(settings?.triggerWidth);
    triggerWidth = sourceVersion < 2 && configuredWidth === 18
      ? DEFAULT_TRIGGER_WIDTH
      : Number.isFinite(configuredWidth)
      ? Math.min(80, Math.max(0, Math.round(configuredWidth)))
      : DEFAULT_TRIGGER_WIDTH;
    const range = normalizeTriggerRange(settings);
    triggerStartPercent = range.start;
    triggerEndPercent = range.end;
    rail.hidden = !isEdgeMode || excludedByDomain || panel.classList.contains('open');
    host.style.display = excludedByDomain ? 'none' : '';
    rail.style.setProperty('--pt-trigger-width', `${triggerWidth}px`);
    rail.style.setProperty('--pt-trigger-start', `${triggerStartPercent}%`);
    rail.style.setProperty('--pt-trigger-end', `${triggerEndPercent}%`);
    rail.classList.toggle('zero-width', triggerWidth === 0);
  };

  const isInTriggerZone = (event) => {
    if (!settingsApplied || !isEdgeMode || excludedByDomain) return false;
    const top = window.innerHeight * triggerStartPercent / 100;
    const bottom = window.innerHeight * triggerEndPercent / 100;
    return event.clientX <= edgeHitWidth() && event.clientY >= top && event.clientY <= bottom;
  };

  window.addEventListener('pointermove', (event) => {
    lastPointerX = event.clientX;
    const inZone = isInTriggerZone(event);
    if (!inZone) edgeTriggerArmed = true;
    if (!panel.classList.contains('open')) {
      if (inZone && edgeTriggerArmed) setOpen(true);
      return;
    }
    if (!pinned && !inZone && !isPointerOverPanel()) closeIfPointerOutside();
  }, { passive: true });

  panel.addEventListener('load', syncPinState);
  panel.addEventListener('pointerleave', () => {
    // 光标贴在页面左缘时浏览器窗口边框（尤其 Edge 非最大化时的窗口边框）会“接管”指针，
    // 页面 hover 状态丢失触发 pointerleave，但这不属于“用户把光标移开了”；
    // 只有光标已离开贴边区（向右移动）才允许自动收起，剩余方向由 window pointermove 跟进关闭。
    if (lastPointerX < 0 || lastPointerX > edgeHitWidth()) closeIfPointerOutside();
  });
  window.addEventListener('resize', syncPageShift, { passive: true });

  const readSettings = async () => {
    try {
      const result = await chrome.storage.local.get('projectTabState');
      applySettings(result.projectTabState?.settings || {}, Number(result.projectTabState?.version) || 1);
    } catch {
      applySettings({});
    }
  };

  rail.addEventListener('click', () => {
    setOpen(true);
  });

  window.addEventListener('message', (event) => {
    if (event.source !== panel.contentWindow) return;
    const message = event.data;
    if (!message || message.source !== 'project-tab-panel') return;
    if (message.type === 'TOGGLE_PIN') {
      setPinned(typeof message.pinned === 'boolean' ? message.pinned : !pinned);
    } else if (message.type === 'CLOSE_PANEL') {
      setPinned(false);
      setOpen(false);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.projectTabState?.newValue) {
      const next = changes.projectTabState.newValue;
      applySettings(next.settings || {}, Number(next.version) || 1);
    }
  });

  readSettings();
})();
