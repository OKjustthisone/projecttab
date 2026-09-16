(() => {
  if (window.top !== window) return;
  document.querySelectorAll('#project-tab-edge-host').forEach((existingHost) => existingHost.remove());
  document.querySelectorAll('#project-tab-page-shift-style').forEach((existingStyle) => existingStyle.remove());
  document.documentElement.removeAttribute('data-project-tab-pushed');
  document.documentElement.style.removeProperty('--project-tab-panel-width');

  const DEFAULT_TRIGGER_START = 20;
  const DEFAULT_TRIGGER_END = 30;
  const DEFAULT_TRIGGER_WIDTH = 0;
  const TRIGGER_HIT_WIDTH = 4;
  const PANEL_MAX_WIDTH = 390;

  const pageShiftStyle = document.createElement('style');
  pageShiftStyle.id = 'project-tab-page-shift-style';
  pageShiftStyle.textContent = `
    html[data-project-tab-pushed="true"] {
      box-sizing: border-box !important;
      width: 100% !important;
      min-width: 0 !important;
      padding-left: var(--project-tab-panel-width) !important;
      overflow-x: hidden !important;
    }
    html[data-project-tab-pushed="true"] > body {
      box-sizing: border-box !important;
      width: auto !important;
      max-width: 100% !important;
      min-width: 0 !important;
      margin-left: 0 !important;
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

  let isEdgeMode = true;
  let triggerWidth = DEFAULT_TRIGGER_WIDTH;
  let triggerStartPercent = DEFAULT_TRIGGER_START;
  let triggerEndPercent = DEFAULT_TRIGGER_END;
  let edgeTriggerArmed = true;
  let pinned = false;

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
    isEdgeMode = settings?.sidebarMode !== 'fixed';
    if (!isEdgeMode) {
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
    rail.hidden = !isEdgeMode || panel.classList.contains('open');
    rail.style.setProperty('--pt-trigger-width', `${triggerWidth}px`);
    rail.style.setProperty('--pt-trigger-start', `${triggerStartPercent}%`);
    rail.style.setProperty('--pt-trigger-end', `${triggerEndPercent}%`);
    rail.classList.toggle('zero-width', triggerWidth === 0);
  };

  const isInTriggerZone = (event) => {
    if (!isEdgeMode) return false;
    const top = window.innerHeight * triggerStartPercent / 100;
    const bottom = window.innerHeight * triggerEndPercent / 100;
    return event.clientX <= Math.max(TRIGGER_HIT_WIDTH, triggerWidth) && event.clientY >= top && event.clientY <= bottom;
  };

  window.addEventListener('pointermove', (event) => {
    const inZone = isInTriggerZone(event);
    if (!inZone) edgeTriggerArmed = true;
    if (!panel.classList.contains('open')) {
      if (inZone && edgeTriggerArmed) setOpen(true);
      return;
    }
    if (!pinned && !inZone && !isPointerOverPanel()) closeIfPointerOutside();
  }, { passive: true });

  panel.addEventListener('load', syncPinState);
  panel.addEventListener('pointerleave', closeIfPointerOutside);
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
