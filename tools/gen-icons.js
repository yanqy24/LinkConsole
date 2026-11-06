/**
 * LinkConsole 图标生成器
 * 纯 Node 实现（zlib + 手写 PNG/ICO 封装），不依赖任何第三方库或系统绘图组件。
 * 输出：src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.ico}
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'src-tauri', 'icons');

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- PNG 编码 ---------- */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const off = y * (size * 4 + 1);
    raw[off] = 0; // filter: none
    rgba.copy(raw, off + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 绘图 ---------- */
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}
function insideRoundRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x >= w || y >= h) return 1;
  const cx = x < r ? r : x > w - 1 - r ? w - 1 - r : x;
  const cy = y < r ? r : y > h - 1 - r ? h - 1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  return Math.max(0, Math.min(1, d - r + 0.5));
}
// 线段的有向距离（用于抗锯齿描边）
function segDist(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const len2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (x1 + vx * t);
  const dy = py - (y1 + vy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

const BG_TOP = [30, 38, 56, 255];
const BG_BOTTOM = [9, 11, 16, 255];
const ACCENT = [74, 222, 190, 255]; // teal
const ACCENT_2 = [96, 165, 250, 255]; // blue
const FG = [232, 240, 250, 255];

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = size;
  const u = (v) => v * S; // 0..1 → 像素

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      // 背景：圆角矩形 + 斜向渐变
      const edge = insideRoundRect(x, y, S, S, u(0.22));
      const g = (x / S) * 0.35 + (y / S) * 0.65;
      let col = mix(BG_TOP, BG_BOTTOM, g);
      // 外描边
      const border = Math.max(0, 1 - Math.abs(edge - 0.5) * 2);
      col = mix(col, [255, 255, 255, 34], border * 0.5);
      col[3] = 255 * (1 - edge);

      // 终端提示符 "›"
      const cx1 = u(0.32), cy1 = u(0.36), cx2 = u(0.62), cy2 = u(0.5), cx3 = u(0.32), cy3 = u(0.64);
      const d1 = Math.min(segDist(x + 0.5, y + 0.5, cx1, cy1, cx2, cy2), segDist(x + 0.5, y + 0.5, cx2, cy2, cx3, cy3));
      const strokeW = u(0.075);
      const chevron = 1 - Math.min(1, Math.max(0, (d1 - strokeW / 2) / 1 + 0.5));
      // 下划线 "_"
      const ux1 = u(0.36), ux2 = u(0.74), uy = u(0.72);
      let bar = 0;
      if (x + 0.5 >= ux1 && x + 0.5 <= ux2) {
        const dBar = Math.abs(y + 0.5 - uy);
        bar = 1 - Math.min(1, Math.max(0, (dBar - strokeW / 2) / 1 + 0.5));
      }
      const glyph = Math.max(chevron, bar);
      if (glyph > 0) {
        const gc = mix(ACCENT, ACCENT_2, x / S);
        col = mix(col, gc, glyph);
      }
      px[i] = Math.round(col[0]);
      px[i + 1] = Math.round(col[1]);
      px[i + 2] = Math.round(col[2]);
      px[i + 3] = Math.round(Math.max(col[3], glyph * 255));
    }
  }
  return px;
}

/* ---------- ICO 封装（内嵌 PNG，Windows Vista+ 支持） ---------- */
function buildICO(entries) {
  const n = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(n, 4);
  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/* ---------- 主流程 ---------- */
function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = {};
  sizes.forEach((s) => {
    pngs[s] = encodePNG(render(s), s);
  });
  const write = (name, buf) => fs.writeFileSync(path.join(OUT_DIR, name), buf);
  write('32x32.png', pngs[32]);
  write('128x128.png', pngs[128]);
  write('128x128@2x.png', pngs[256]);
  write('icon.png', pngs[256]);
  write(
    'icon.ico',
    buildICO([16, 32, 48, 64, 128, 256].map((s) => ({ size: s, png: pngs[s] })))
  );
  console.log('icons written to', OUT_DIR);
}

main();
