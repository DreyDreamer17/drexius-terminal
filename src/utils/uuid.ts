/**
 * Safe UUID v4 generator that works in both secure contexts (Tauri, HTTPS, localhost)
 * and insecure contexts (e.g. mobile browser accessing http://192.168.x.x without TLS).
 */
export function safeUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
