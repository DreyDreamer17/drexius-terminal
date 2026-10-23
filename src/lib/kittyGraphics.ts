import * as fflate from 'fflate';

export interface KittyControl {
  a?: string; // action: T (transmit+display), t (transmit), p (display), q (query), d (delete), f (frame), a (animation)
  f?: string; // format: 32 (RGBA), 24 (RGB), 100 (PNG)
  o?: string; // compression: 'z' (zlib deflate)
  s?: string; // pixel width
  v?: string; // pixel height
  c?: string; // cols
  r?: string; // rows
  t?: string; // medium: 'd' (direct), 'f' (file), 's' (shm), 't' (temp)
  m?: string; // chunking: 1 (more) or 0 (last)
  i?: string; // image ID
  p?: string; // placement ID
  q?: string; // quiet (1 = suppress OK, 2 = suppress OK and errors)
}

/**
 * Encodes raw RGBA (or RGB) pixel buffer into a compliant PNG Uint8Array.
 * Pure TypeScript implementation without DOM / canvas dependencies.
 */
export function rgbaToPng(data: Uint8Array, width: number, height: number, channels: 3 | 4 = 4): Uint8Array {
  const bytesPerPixel = channels;
  const scanlines = new Uint8Array(height * (width * bytesPerPixel + 1));
  for (let y = 0; y < height; y++) {
    scanlines[y * (width * bytesPerPixel + 1)] = 0; // Filter None
    scanlines.set(
      data.subarray(y * width * bytesPerPixel, (y + 1) * width * bytesPerPixel),
      y * (width * bytesPerPixel + 1) + 1
    );
  }

  // PNG IDAT expects zlib-wrapped deflate (RFC 1950)
  const idatData = fflate.zlibSync(scanlines, { level: 6 });

  function crc32(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (-(c & 1) & 0xedb88320);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type: string, chunkData: Uint8Array): Uint8Array {
    const t = new TextEncoder().encode(type);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, chunkData.length, false);
    const typeAndData = new Uint8Array(t.length + chunkData.length);
    typeAndData.set(t, 0);
    typeAndData.set(chunkData, t.length);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(typeAndData), false);
    const out = new Uint8Array(4 + typeAndData.length + 4);
    out.set(len, 0);
    out.set(typeAndData, 4);
    out.set(crc, 4 + typeAndData.length);
    return out;
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = channels === 3 ? 2 : 6; // 2 = RGB, 6 = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', idatData);
  const iendChunk = makeChunk('IEND', new Uint8Array(0));

  const totalLen = header.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const result = new Uint8Array(totalLen);
  let off = 0;
  result.set(header, off); off += header.length;
  result.set(ihdrChunk, off); off += ihdrChunk.length;
  result.set(idatChunk, off); off += idatChunk.length;
  result.set(iendChunk, off);
  return result;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  const chunk = 8192;
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)) as unknown as number[]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/**
 * KittyGraphicsProcessor:
 * Intercepts Kitty Graphics Protocol sequences (`\x1b_G...;\x1b\`) across streaming chunks,
 * absorbs probe/query escape codes so they never dump garbage text on the terminal screen,
 * and converts inline Kitty image uploads (e.g. from fastfetch) into iTerm2 IIP format
 * which `@xterm/addon-image` renders natively with zero performance degradation.
 */
export class KittyGraphicsProcessor {
  public cellWidth: number;
  public cellHeight: number;
  private inApc = false;
  private apcBuffer = '';
  private pendingEsc = '';
  private activeImage: { control: KittyControl; payload: string } | null = null;
  public onDirectFile?: (filePath: string, control: KittyControl) => void;

  constructor(cellWidth = 9, cellHeight = 18) {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
  }

  setCellSize(width: number, height: number) {
    if (width > 0) this.cellWidth = width;
    if (height > 0) this.cellHeight = height;
  }

  feed(chunk: string): string {
    if (!chunk) return '';

    if (this.pendingEsc) {
      chunk = this.pendingEsc + chunk;
      this.pendingEsc = '';
    }

    // Fast path: if not in APC and chunk has no escape introducer, return verbatim
    if (!this.inApc && !chunk.includes('\x1b_G')) {
      if (chunk.endsWith('\x1b')) {
        this.pendingEsc = '\x1b';
        return chunk.slice(0, -1);
      }
      if (chunk.endsWith('\x1b_')) {
        this.pendingEsc = '\x1b_';
        return chunk.slice(0, -2);
      }
      return chunk;
    }

    let out = '';
    let i = 0;

    while (i < chunk.length) {
      if (!this.inApc) {
        const apcIdx = chunk.indexOf('\x1b_G', i);
        if (apcIdx === -1) {
          if (chunk.endsWith('\x1b')) {
            out += chunk.slice(i, -1);
            this.pendingEsc = '\x1b';
          } else if (chunk.endsWith('\x1b_')) {
            out += chunk.slice(i, -2);
            this.pendingEsc = '\x1b_';
          } else {
            out += chunk.slice(i);
          }
          break;
        }

        out += chunk.slice(i, apcIdx);
        this.inApc = true;
        this.apcBuffer = '';
        i = apcIdx + 3; // Skip "\x1b_G"
      }

      if (this.inApc) {
        let endIdx = -1;
        let termLen = 0;

        const stIdx = chunk.indexOf('\x1b\\', i);
        const belIdx = chunk.indexOf('\x07', i);

        if (stIdx !== -1 && (belIdx === -1 || stIdx < belIdx)) {
          endIdx = stIdx;
          termLen = 2;
        } else if (belIdx !== -1) {
          endIdx = belIdx;
          termLen = 1;
        }

        if (endIdx === -1) {
          if (chunk.endsWith('\x1b')) {
            this.apcBuffer += chunk.slice(i, -1);
            this.pendingEsc = '\x1b';
          } else {
            this.apcBuffer += chunk.slice(i);
          }
          // Safety cap against corrupt unbounded escape sequence
          if (this.apcBuffer.length > 20_000_000) {
            this.inApc = false;
            this.apcBuffer = '';
          }
          break;
        }

        this.apcBuffer += chunk.slice(i, endIdx);
        i = endIdx + termLen;
        this.inApc = false;

        const converted = this.handleApcCommand(this.apcBuffer);
        if (converted) {
          out += converted;
        }
        this.apcBuffer = '';
      }
    }

    return out;
  }

  private handleApcCommand(cmd: string): string {
    const semiIdx = cmd.indexOf(';');
    const controlStr = semiIdx !== -1 ? cmd.slice(0, semiIdx) : cmd;
    const payload = semiIdx !== -1 ? cmd.slice(semiIdx + 1) : '';

    const ctrl: KittyControl = {};
    const pairs = controlStr.split(',');
    for (const p of pairs) {
      const eq = p.indexOf('=');
      if (eq !== -1) {
        ctrl[p.slice(0, eq) as keyof KittyControl] = p.slice(eq + 1);
      }
    }

    // Swallowed queries & management commands so they never spill raw characters into terminal screen
    if (ctrl.a === 'q' || ctrl.a === 'd') {
      return '';
    }

    // Direct file path (t=f)
    if (ctrl.t === 'f' && payload) {
      try {
        const filePath = atob(payload.trim());
        if (this.onDirectFile) {
          this.onDirectFile(filePath, ctrl);
        }
      } catch {}
      return '';
    }

    // Image data transmission / display
    if (!this.activeImage) {
      this.activeImage = { control: ctrl, payload: '' };
    }
    this.activeImage.payload += payload;

    const isLast = ctrl.m === '0' || (!ctrl.m && !this.activeImage.control.m);
    if (isLast) {
      const img = this.activeImage;
      this.activeImage = null;
      return this.convertKittyToIterm(img);
    }

    return '';
  }

  private convertKittyToIterm(img: { control: KittyControl; payload: string }): string {
    const { control, payload } = img;
    if (!payload) return '';

    try {
      let pngBytes: Uint8Array;
      if (control.f === '100') {
        pngBytes = base64ToBytes(payload);
      } else {
        let rawBytes = base64ToBytes(payload);
        if (control.o === 'z') {
          rawBytes = fflate.decompressSync(rawBytes);
        }
        const w = parseInt(control.s || '0', 10);
        const h = parseInt(control.v || '0', 10);
        if (!w || !h) return '';
        const channels = control.f === '24' ? 3 : 4;
        pngBytes = rgbaToPng(rawBytes, w, h, channels);
      }

      const cols = control.c || (control.s ? Math.ceil(parseInt(control.s, 10) / this.cellWidth) : 'auto');
      const rows = control.r || (control.v ? Math.ceil(parseInt(control.v, 10) / this.cellHeight) : 'auto');
      const b64 = bytesToBase64(pngBytes);
      return `\x1b]1337;File=inline=1;size=${pngBytes.length};width=${cols};height=${rows}:${b64}\x07`;
    } catch (err) {
      console.warn('Failed to convert Kitty image to iTerm format:', err);
      return '';
    }
  }

  reset() {
    this.inApc = false;
    this.apcBuffer = '';
    this.pendingEsc = '';
    this.activeImage = null;
  }
}
