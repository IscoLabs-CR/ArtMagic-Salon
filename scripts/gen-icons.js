// Genera el logo y los iconos PWA (poste de barbero sobre el azul de marca
// #0077b6) sin dependencias. Uso:  node scripts/gen-icons.js [carpeta-salida]
// Por defecto escribe en ./public. Corré esto una vez al generar el proyecto.
// Si el cliente trae logo propio, sobreescribí logo.png con el suyo después.
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const OUT = process.argv[2] || path.join(process.cwd(), "public");

const BRAND = [0x00, 0x77, 0xb6]; // #0077b6 — mismo azul que globals.css
const NAVY = [0x02, 0x3e, 0x8a];
const RED = [0xe6, 0x39, 0x46];
const BLUE = [0x1d, 0x4e, 0xd8];
const WHITE = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawIcon(N, opts = {}) {
  const { bg = BRAND, mono = false, scale = 0.62 } = opts;
  const buf = Buffer.alloc(N * N * 4);
  const cx = N / 2;
  const poleH = N * scale;
  const poleW = poleH * 0.42;
  const top = (N - poleH) / 2;
  const bottom = top + poleH;
  const r = poleW / 2;
  const outline = Math.max(1, N * 0.02);
  const period = poleH * 0.2;

  function stadium(x, y, rr) {
    if (y < top + rr) return (x - cx) ** 2 + (y - (top + rr)) ** 2 <= rr * rr;
    if (y > bottom - rr) return (x - cx) ** 2 + (y - (bottom - rr)) ** 2 <= rr * rr;
    return x >= cx - rr && x <= cx + rr;
  }

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      let col = null;
      let alpha = 0;

      if (stadium(x + 0.5, y + 0.5, r)) {
        if (mono) {
          col = WHITE;
          alpha = 255;
        } else {
          const phase = (((x + y) % period) + period) % period / period;
          col = phase < 0.34 ? RED : phase < 0.67 ? WHITE : BLUE;
          alpha = 255;
        }
      } else if (!mono && stadium(x + 0.5, y + 0.5, r + outline)) {
        col = NAVY;
        alpha = 255;
      } else if (bg) {
        col = bg;
        alpha = 255;
      }

      if (alpha === 0) {
        buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0;
      } else {
        buf[i] = col[0];
        buf[i + 1] = col[1];
        buf[i + 2] = col[2];
        buf[i + 3] = alpha;
      }
    }
  }
  return encodePng(N, N, buf);
}

const targets = [
  // El logo que muestran landing, wizard, login y dashboard. Es el mismo dibujo
  // que el icono grande: va sobre placa oscura, así que el azul de fondo calza.
  ["logo.png", 512, { scale: 0.62 }],
  ["icon-192.png", 192, { scale: 0.62 }],
  ["icon-512.png", 512, { scale: 0.62 }],
  ["icon-maskable-512.png", 512, { scale: 0.5 }], // padding para la safe zone
  ["apple-touch-icon.png", 180, { scale: 0.6 }],
  ["badge.png", 96, { mono: true, bg: null, scale: 0.8 }],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, opts] of targets) {
  fs.writeFileSync(path.join(OUT, name), drawIcon(size, opts));
  console.log("wrote", path.join(OUT, name));
}
