import { videoTarget } from './core';
import { createWidget, createCollectionWidget } from './widget';
import { collectionSource } from './batch-core';

// Reuse the isolated-world controller when the popup recovers an already open tab.
const page = window as Window & { ytLocalDownload?: { mount(): void; valid(): boolean; destroy(): void } };
function valid() {
  try { return !!chrome.runtime.id && !!chrome.runtime.getManifest(); } catch { return false; }
}
if (page.ytLocalDownload?.valid()) page.ytLocalDownload.mount();
else {
  page.ytLocalDownload?.destroy();
  document.querySelector('#yt-local-download-root')?.remove();
  let currentId = ''; let host: HTMLElement | undefined; let widget: Pick<ReturnType<typeof createWidget>, 'setHidden' | 'destroy'> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observedHost: HTMLElement | undefined; let observedToolbar: HTMLElement | undefined;
  let stopped = false; let detailsReady = false; let navigating = false;
  const titleSelectors = 'ytd-watch-metadata h1, ytd-video-primary-info-renderer h1, #watch-header h1, ytm-slim-video-metadata-renderer .slim-video-information-title, ytm-slim-video-information-renderer .slim-video-information-title';
  function visible(element: HTMLElement) {
    return !element.closest('[hidden]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  }
  function syncFullscreen() {
    const fullscreen = !!document.fullscreenElement || document.body.classList.contains('webscreen-fix') || !!document.querySelector('#movie_player.ytp-fullscreen');
    widget?.setHidden(fullscreen || !detailsReady || navigating);
    return fullscreen;
  }
  function fullscreenChange() { syncFullscreen(); schedule(); }
  function navigationStart() { navigating = true; widget?.setHidden(true); }
  function navigationFinish() { navigating = false; schedule(); }
  function mount() {
    timer = undefined;
    if (!valid()) { destroy(); return; }
    if (navigating) return;
    let id = ''; let site = ''; let collectionUrl = '';
    try { const target = videoTarget(location.href); id = target.videoId; site = target.site; }
    catch {
      try { const source = collectionSource(location.href); collectionUrl = source.url; id = `collection:${source.url}`; site = source.site; }
      catch { /* Not a supported video, collection or channel page. */ }
    }
    if (currentId !== id) {
      widget?.destroy(); widget = undefined; host = undefined; currentId = id; detailsReady = false;
      resize.disconnect(); observedHost = undefined; observedToolbar = undefined;
    }
    if (!id) return;
    if (collectionUrl) {
      detailsReady = true;
      if (!host || !widget) {
        host = document.createElement('span'); host.id = 'yt-local-download-root';
        widget = createCollectionWidget(host, collectionUrl);
      }
      host.toggleAttribute('data-dark', document.documentElement.hasAttribute('dark'));
      host.setAttribute('data-floating', '');
      if (host.parentElement !== document.body) document.body.append(host);
      syncFullscreen();
      return;
    }
    const selectors = site === 'bilibili' ? ['.video-toolbar-container', '#arc_toolbar_report'] : location.pathname.startsWith('/shorts/')
      ? ['ytd-reel-video-renderer[is-active] #actions']
      : ['ytd-watch-metadata #top-level-buttons-computed', '#menu-container #top-level-buttons-computed', 'ytm-slim-video-action-bar-renderer', 'ytd-watch-metadata #actions-inner', 'ytd-watch-metadata #actions', '#watch-header #actions'];
    let target: HTMLElement | undefined;
    for (const selector of selectors) {
      target = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(visible);
      if (target) break;
    }
    // Player data can arrive while the watch page still shows its skeleton.
    // Wait for the current video's rendered title and action row, rather than
    // revealing the floating fallback before the native details initialize.
    const metadata = target?.closest('ytd-watch-metadata');
    const nativeId = metadata?.getAttribute('video-id') || target?.closest('ytd-watch-flexy')?.getAttribute('video-id');
    const titles = metadata ? metadata.querySelectorAll<HTMLElement>('h1') : document.querySelectorAll<HTMLElement>(titleSelectors);
    detailsReady = site !== 'youtube' || location.pathname.startsWith('/shorts/') || !!target && (!nativeId || nativeId === id)
      && Array.from(titles).some(title => !!title.textContent?.trim() && visible(title));
    if (!detailsReady) {
      widget?.setHidden(true);
      if (host && !host.isConnected) document.body.append(host);
      return;
    }
    if (!host || !widget) {
      host = document.createElement('span'); host.id = 'yt-local-download-root';
      widget = createWidget(host);
    }
    host.toggleAttribute('data-dark', document.documentElement.hasAttribute('dark'));
    if (syncFullscreen()) {
      if (!host.isConnected) document.body.append(host);
      return;
    }
    if (site === 'bilibili') {
      // Bilibili hydrates this action tree after document_idle. Adding a child
      // there can break hydration of the rest of the page, including its sidebar.
      // Keep the extension host outside the app and only read native geometry.
      if (host.parentElement !== document.body) document.body.append(host);
      if (observedHost !== host || observedToolbar !== target) {
        resize.disconnect(); resize.observe(host);
        if (target) resize.observe(target);
        observedHost = host; observedToolbar = target;
      }
      const toolbar = target?.getBoundingClientRect();
      const left = target?.querySelector('.video-toolbar-left')?.getBoundingClientRect();
      const right = target?.querySelector('.video-toolbar-right')?.getBoundingClientRect();
      const control = host.getBoundingClientRect();
      const edge = right?.width ? right.left - 8 : toolbar?.right || 0;
      const x = edge - control.width;
      const anchored = !!toolbar && x >= Math.max(toolbar.left, left?.right || toolbar.left) + 8;
      host.toggleAttribute('data-anchored', anchored);
      host.toggleAttribute('data-floating', !anchored);
      if (anchored) {
        host.style.setProperty('--yt-anchor-left', `${window.scrollX + x}px`);
        host.style.setProperty('--yt-anchor-top', `${window.scrollY + toolbar.top + (toolbar.height - control.height) / 2}px`);
      }
      return;
    }
    resize.disconnect(); observedHost = undefined; observedToolbar = undefined;
    host.removeAttribute('data-anchored');
    host.toggleAttribute('data-floating', !target);
    if (host.parentElement === (target || document.body)) return;
    if (target) {
      let share: Element | null = target.querySelector('button[aria-label*="Share"], button[aria-label*="分享"], button[title*="Share"], button[title*="分享"]');
      while (share && share.parentElement !== target) share = share.parentElement;
      if (share) share.after(host); else target.prepend(host);
    } else document.body.append(host);
  }
  function schedule() { if (!stopped && timer === undefined) timer = setTimeout(mount, 150); }
  const onMessage = (message: { target?: string; type?: string } | null, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => {
    if (sender.id === chrome.runtime.id && message?.target === 'content' && message.type === 'mount') { schedule(); respond({ ok: true }); }
  };
  function destroy() {
    if (stopped) return;
    stopped = true; clearTimeout(timer); observer.disconnect(); resize.disconnect();
    document.removeEventListener('yt-navigate-start', navigationStart);
    document.removeEventListener('yt-navigate-finish', navigationFinish);
    document.removeEventListener('fullscreenchange', fullscreenChange);
    window.removeEventListener('popstate', schedule); window.removeEventListener('resize', schedule);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* The extension was uninstalled. */ }
    widget?.destroy();
    host?.remove();
  }
  page.ytLocalDownload = { mount: schedule, valid, destroy };
  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener('yt-navigate-start', navigationStart);
  document.addEventListener('yt-navigate-finish', navigationFinish);
  document.addEventListener('fullscreenchange', fullscreenChange);
  window.addEventListener('popstate', schedule);
  window.addEventListener('resize', schedule);
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes' && record.attributeName === 'class' && (record.target === document.body || record.target instanceof Element && record.target.matches('#movie_player')))) fullscreenChange();
    // Our own insertions/moves must not start a permanent observer loop.
    if (records.some(record => record.type === 'attributes' ? record.attributeName !== 'class'
      : record.type === 'characterData' ? !!record.target.parentElement?.closest(titleSelectors)
      : [...record.addedNodes, ...record.removedNodes].some(node => !(node instanceof Element && node.id === 'yt-local-download-root')))) schedule();
  });
  const resize = new ResizeObserver(schedule);
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['dark', 'is-active', 'hidden', 'class', 'video-id'] });
  mount();
}
