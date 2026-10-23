import { videoId } from './core';
import { createWidget } from './widget';

// Reuse the isolated-world controller when the popup recovers an already open tab.
const page = window as Window & { ytLocalDownload?: { mount(): void; valid(): boolean; destroy(): void } };
function valid() {
  try { return !!chrome.runtime.id && !!chrome.runtime.getManifest(); } catch { return false; }
}
if (page.ytLocalDownload?.valid()) page.ytLocalDownload.mount();
else {
  page.ytLocalDownload?.destroy();
  document.querySelector('#yt-local-download-root')?.remove();
  let currentId = ''; let host: HTMLElement | undefined; let widget: ReturnType<typeof createWidget> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  function visible(element: HTMLElement) {
    return !element.closest('[hidden]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  }
  function mount() {
    timer = undefined;
    if (!valid()) { destroy(); return; }
    let id = ''; try { id = videoId(location.href); } catch { /* Not a single-video page. */ }
    if (currentId !== id) { widget?.destroy(); widget = undefined; host = undefined; currentId = id; }
    if (!id) return;
    const selectors = location.pathname.startsWith('/shorts/')
      ? ['ytd-reel-video-renderer[is-active] #actions']
      : ['ytd-watch-metadata #top-level-buttons-computed', '#menu-container #top-level-buttons-computed', 'ytm-slim-video-action-bar-renderer', 'ytd-watch-metadata #actions-inner', 'ytd-watch-metadata #actions', '#watch-header #actions'];
    let target: HTMLElement | undefined;
    for (const selector of selectors) {
      target = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(visible);
      if (target) break;
    }
    if (!host || !widget) {
      host = document.createElement('span'); host.id = 'yt-local-download-root';
      widget = createWidget(host);
    }
    host.toggleAttribute('data-dark', document.documentElement.hasAttribute('dark'));
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
    stopped = true; clearTimeout(timer); observer.disconnect();
    document.removeEventListener('yt-navigate-finish', schedule);
    window.removeEventListener('popstate', schedule); window.removeEventListener('resize', schedule);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* The extension was uninstalled. */ }
    widget?.destroy();
    host?.remove();
  }
  page.ytLocalDownload = { mount: schedule, valid, destroy };
  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener('yt-navigate-finish', schedule);
  window.addEventListener('popstate', schedule);
  window.addEventListener('resize', schedule);
  const observer = new MutationObserver(records => {
    // Our own insertions/moves must not start a permanent observer loop.
    if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(node => !(node instanceof Element && node.id === 'yt-local-download-root')))) schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['dark', 'is-active', 'hidden'] });
  mount();
}
