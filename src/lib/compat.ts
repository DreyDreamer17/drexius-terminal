/**
 * Compatibility patches and polyfills for WebKit / Safari and older webview runtimes
 * (e.g., WebKitGTK 2.38-2.44 in Ubuntu 22.04 LTS AppImage runners).
 */

if (typeof window !== 'undefined') {
  // 1. Polyfill/patch createImageBitmap with options dictionary:
  // WebKit prior to Safari 16.4 / WebKit 2.44 throws a synchronous or asynchronous
  // TypeError when options (like { resizeWidth, resizeHeight }) are passed to createImageBitmap.
  // We intercept this and fall back to calling createImageBitmap without options,
  // since xterm-addon-image rescales to cell dimensions in its render pipeline anyway.
  const origCreateImageBitmap = window.createImageBitmap;
  if (typeof origCreateImageBitmap === 'function') {
    window.createImageBitmap = function (image: any, ...args: any[]): Promise<ImageBitmap> {
      try {
        const res = origCreateImageBitmap.apply(this, [image, ...args] as any);
        if (res && typeof res.catch === 'function') {
          return res.catch((err: any) => {
            if (args.length > 0) {
              const strippedArgs = typeof args[0] === 'number' ? args.slice(0, 4) : [];
              return (origCreateImageBitmap as any).apply(this, [image, ...strippedArgs]);
            }
            throw err;
          });
        }
        return res;
      } catch (syncErr) {
        if (args.length > 0) {
          try {
            const strippedArgs = typeof args[0] === 'number' ? args.slice(0, 4) : [];
            return (origCreateImageBitmap as any).apply(this, [image, ...strippedArgs]);
          } catch {
            /* fall through to fallback */
          }
        }
        return Promise.reject(syncErr);
      }
    };
  }

  // 2. Global uncaught error listener to avoid silent crashes in webview production builds:
  window.addEventListener('error', (event) => {
    console.error('[Drexius Webview Error]:', event.message, event.filename, event.lineno, event.error);
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[Drexius Webview Unhandled Rejection]:', event.reason);
  });
}

export {};
