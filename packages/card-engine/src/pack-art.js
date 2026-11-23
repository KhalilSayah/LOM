/**
 * The artwork on a sealed pack.
 *
 * Every pack type has its own wrapper: a palette, a foil colour and a composition built from
 * champion art. The art is the same Data Dragon "loading" image the cards use, so it arrives
 * through the same resolver. If it cannot load, the wrapper falls back to its palette and the
 * LOM mark rather than showing a hole.
 *
 * The keys match `pack_types.key`. A key this file does not know draws as the Daily pack.
 */

import { splashUrl } from './assets.js';

const LANES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
export const bound = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export const PACK_THEMES = {
  DAILY: {
    label: 'Daily', title: 'DAILY', sub: '1 PLAYER CARD', paint: 'burst', hero: 'Ahri',
    roster: ['Yasuo', 'Jinx', 'Zed', 'Lux', 'Darius', 'Akali', 'Thresh', 'Ezreal', 'Katarina', 'LeeSin', 'Leona', 'Garen', 'Kaisa', 'Vi', 'Sett'],
    foil: [1, 0.97, 0.9], inner: [0.64, 0.66, 0.71], crimp: '#16213a', line: '#d8b064', ink: '#f8e7bd', small: '#d8b064', band: '4,7,13',
    plain: ['#2c3f66', '#16213a', '#0a101d'], bits: ['#c9ced8', '#8e96a6', '#26365a', '#f5dfa8'],
  },
  SCOUTING: {
    label: 'Scouting', title: 'SCOUTING', sub: '3 PLAYERS', paint: 'scope', hero: 'Caitlyn',
    roster: ['Teemo', 'Quinn', 'Ashe', 'Vayne', 'Kindred', 'Rengar', 'Nidalee', 'Jhin', 'Twitch', 'Ezreal', 'Akali', 'Zed', 'Ekko', 'Camille', 'Sejuani'],
    foil: [0.72, 1, 0.92], inner: [0.56, 0.72, 0.68], crimp: '#07302b', line: '#39e0bd', ink: '#d6fff4', small: '#39e0bd', band: '2,16,14',
    plain: ['#0e4f46', '#08302b', '#031412'], bits: ['#9ff5e0', '#39e0bd', '#0e4f46', '#d6fff4'],
  },
  SIGNING: {
    label: 'Signing', title: 'SIGNING', sub: '5 PLAYERS · ONE PER LANE', paint: 'lanes', hero: 'Aatrox',
    roster: ['LeeSin', 'Orianna', 'Jinx', 'Thresh'],
    foil: [1, 0.84, 0.78], inner: [0.74, 0.62, 0.6], crimp: '#3f0d15', line: '#f3d6a6', ink: '#fff0dc', small: '#f3b9a0', band: '24,4,8',
    plain: ['#7b1a28', '#3f0d15', '#16050a'], bits: ['#f3d6a6', '#d9495c', '#3f0d15', '#fff0dc'],
  },
  STANDARD: {
    label: 'Standard', title: 'STANDARD', sub: '1 PLAYER CARD', paint: 'versus', hero: 'Garen',
    roster: ['Darius'],
    foil: [0.92, 0.96, 1], inner: [0.72, 0.74, 0.78], crimp: '#262b34', line: '#d5dce8', ink: '#f2f5fa', small: '#b8c2d2', band: '8,10,14',
    plain: ['#59647a', '#2a303c', '#0e1116'], bits: ['#eef2f8', '#aab4c4', '#3b4351', '#ffffff'],
  },
  LEGACY: {
    label: 'Legacy', title: 'LEGACY', sub: '3 CARDS · 1 LEGENDARY OR BETTER', paint: 'arch', hero: 'Kayle',
    roster: ['Morgana', 'Aatrox', 'Nasus', 'Renekton', 'Azir', 'Ryze', 'Zilean', 'Galio', 'Anivia', 'Swain', 'AurelionSol', 'Sylas', 'Riven', 'Fiora'],
    foil: [1, 0.86, 0.55], inner: [0.86, 0.7, 0.4], crimp: '#2a1c06', line: '#f2c14e', ink: '#fff0c4', small: '#f2c14e', band: '12,8,2',
    plain: ['#6a4c14', '#2a1c06', '#0d0902'], bits: ['#fff0c4', '#f2c14e', '#a88340', '#2a1c06'],
  },
  SEASON: {
    label: 'Season', title: 'SEASON', sub: 'END OF SEASON REWARD', paint: 'hive', hero: 'Seraphine',
    roster: ['Viktor', 'Jayce', 'Ekko', 'Camille', 'Aphelios', 'Kaisa', 'Zeri', 'Yone', 'Yasuo', 'Lux', 'Orianna', 'Jinx', 'Vi', 'Azir', 'Leona', 'Ahri', 'Sett', 'Akali'],
    foil: [0.9, 0.88, 1], inner: [0.72, 0.68, 0.82], crimp: '#1c1538', line: '#c9b6ff', ink: '#f5efff', small: '#a6f7ee', band: '10,7,24',
    plain: ['#40307a', '#1c1538', '#0a0716'], bits: ['#a6f7ee', '#b9c6ff', '#e2b8ff', '#ffc6dd', '#ffe6a6'],
  },
};

/** @param {string} key a `pack_types.key` */
export const packTheme = (key) => PACK_THEMES[String(key || '').toUpperCase()] || PACK_THEMES.DAILY;

/* --- champion art ---------------------------------------------------------- */

const champs = new Map();
const imageJobs = new Map();

function loadImage(key) {
  if (imageJobs.has(key)) return imageJobs.get(key);
  const job = new Promise((done) => {
    const url = splashUrl(key, 'card');
    if (!url) { done(null); return; }
    const img = new Image();
    // Without this the canvas is tainted and WebGL refuses the texture.
    img.crossOrigin = 'anonymous';
    img.onload = () => { champs.set(key, img); done(img); };
    img.onerror = () => done(null);
    img.src = url;
  });
  imageJobs.set(key, job);
  return job;
}

/** Fetch every image one wrapper needs. Never rejects. */
export function loadPackArt(key) {
  const theme = packTheme(key);
  return Promise.all([theme.hero, ...theme.roster].map(loadImage));
}

const hasArt = (theme) => [theme.hero, ...theme.roster].filter((k) => champs.has(k)).length
  >= Math.min(2, theme.roster.length + 1);

/* --- drawing helpers -------------------------------------------------------- */

const face = (x, key, fx, fy, scale, ax = 0.5, ay = 0.31) => {
  const im = champs.get(key);
  if (!im) return;
  x.drawImage(im, fx - im.width * scale * ax, fy - im.height * scale * ay, im.width * scale, im.height * scale);
};
const poly = (x, pts) => {
  x.beginPath();
  pts.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b)));
  x.closePath();
};
const wash = (x, w, h, mode, fill, alpha = 1) => {
  x.save();
  x.globalCompositeOperation = mode;
  x.globalAlpha = alpha;
  x.fillStyle = fill;
  x.fillRect(0, 0, w, h);
  x.restore();
};
const line = (x, a, b, c, d, color, width) => {
  x.strokeStyle = color;
  x.lineWidth = width;
  x.beginPath();
  x.moveTo(a, b);
  x.lineTo(c, d);
  x.stroke();
};
const diamond = (x, cx, cy, q) => poly(x, [[cx, cy - q], [cx + q, cy], [cx, cy + q], [cx - q, cy]]);
const hexPath = (x, cx, cy, r) => {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  poly(x, pts);
};
const vignette = (x, w, h, cx, cy, edge = '#2a3048') => {
  const far = Math.hypot(w, h);
  const v = x.createRadialGradient(cx, cy, w * 0.2, cx, cy, far * 0.66);
  v.addColorStop(0, '#ffffff');
  v.addColorStop(0.55, '#b9bfd0');
  v.addColorStop(1, edge);
  wash(x, w, h, 'multiply', v);
};

/** Slices of champion art radiating from one point. Returns the angle of each cut. */
function wedges(x, w, h, cx, cy, list) {
  const far = Math.hypot(w, h);
  const weights = list.map((_, i) => 0.78 + ((i * 7) % 5) * 0.13);
  const sum = weights.reduce((a, b) => a + b, 0);
  const edge = (a) => {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const tx = dx > 0 ? (w - cx) / dx : dx < 0 ? -cx / dx : Infinity;
    const ty = dy > 0 ? (h - cy) / dy : dy < 0 ? -cy / dy : Infinity;
    return Math.min(tx, ty);
  };
  let a = -Math.PI / 2 + 0.17;
  const cuts = [];
  list.forEach((key, i) => {
    const a0 = a;
    const a1 = a + (weights[i] / sum) * Math.PI * 2;
    const mid = (a0 + a1) / 2;
    a = a1;
    cuts.push(a0);
    x.save();
    poly(x, [
      [cx, cy],
      [cx + Math.cos(a0) * far, cy + Math.sin(a0) * far],
      [cx + Math.cos(mid) * far * 1.4, cy + Math.sin(mid) * far * 1.4],
      [cx + Math.cos(a1) * far, cy + Math.sin(a1) * far],
    ]);
    x.clip();
    const d = Math.max(w * 0.36, edge(mid) * 0.68);
    face(x, key, cx + Math.cos(mid) * d, cy + Math.sin(mid) * d, 1.42);
    x.restore();
  });
  return cuts;
}

/* --- one composition per pack ------------------------------------------------ */

const COVERS = {
  /** Daily: a burst of champions around one in the LOM diamond. */
  burst(x, w, h, p) {
    const cx = w / 2;
    const cy = h * 0.39;
    const far = Math.hypot(w, h);
    x.fillStyle = '#070b14';
    x.fillRect(0, 0, w, h);
    const cuts = wedges(x, w, h, cx, cy, p.roster.filter((k) => champs.has(k)));
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#6f9dff');
    g.addColorStop(0.5, '#20263f');
    g.addColorStop(1, '#ffc766');
    wash(x, w, h, 'soft-light', g);
    vignette(x, w, h, cx, cy);
    for (const c of cuts) {
      const ex = cx + Math.cos(c) * far;
      const ey = cy + Math.sin(c) * far;
      line(x, cx, cy, ex, ey, 'rgba(3,5,10,.92)', 8);
      line(x, cx, cy, ex, ey, '#e7c67f', 2.2);
    }
    const r = w * 0.285;
    x.save();
    x.shadowColor = 'rgba(0,0,0,.85)';
    x.shadowBlur = 34;
    x.fillStyle = '#05070d';
    diamond(x, cx, cy, r + 14);
    x.fill();
    x.restore();
    x.save();
    diamond(x, cx, cy, r);
    x.clip();
    face(x, p.hero, cx, cy, 1.36, 0.5, 0.3);
    x.restore();
    const rim = x.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    rim.addColorStop(0, '#fff0c4');
    rim.addColorStop(0.5, '#c99c4c');
    rim.addColorStop(1, '#fff0c4');
    x.strokeStyle = rim;
    x.lineWidth = 7;
    x.lineJoin = 'miter';
    diamond(x, cx, cy, r + 3);
    x.stroke();
    x.strokeStyle = 'rgba(245,223,168,.7)';
    x.lineWidth = 1.6;
    diamond(x, cx, cy, r + 13);
    x.stroke();
  },

  /** Scouting: a wall of surveillance photos, with one target in the scope. */
  scope(x, w, h, p) {
    x.fillStyle = '#031412';
    x.fillRect(0, 0, w, h);
    const cols = 3;
    const rows = 5;
    const tw = w / cols;
    const th = h / rows;
    const list = p.roster.filter((k) => champs.has(k));
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const key = list[(i + j * cols) % Math.max(1, list.length)];
        x.save();
        x.beginPath();
        x.rect(i * tw + 2, j * th + 2, tw - 4, th - 4);
        x.clip();
        face(x, key, i * tw + tw / 2, j * th + th * 0.46, 0.92);
        x.restore();
      }
    }
    wash(x, w, h, 'saturation', '#000');
    wash(x, w, h, 'color', '#19c9a3', 0.92);
    wash(x, w, h, 'multiply', '#5f9c90');
    x.fillStyle = 'rgba(0,0,0,.2)';
    for (let y = 0; y < h; y += 5) x.fillRect(0, y, w, 2);
    const cx = w / 2;
    const cy = h * 0.4;
    const r = w * 0.345;
    x.save();
    x.shadowColor = '#000';
    x.shadowBlur = 40;
    x.fillStyle = '#020807';
    x.beginPath();
    x.arc(cx, cy, r + 12, 0, Math.PI * 2);
    x.fill();
    x.restore();
    x.save();
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.clip();
    face(x, p.hero, cx, cy, 1.62, 0.5, 0.3);
    const lens = x.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
    lens.addColorStop(0, 'rgba(0,0,0,0)');
    lens.addColorStop(1, 'rgba(0,18,14,.4)');
    x.fillStyle = lens;
    x.fillRect(cx - r, cy - r, r * 2, r * 2);
    x.restore();
    x.strokeStyle = '#39e0bd';
    x.lineWidth = 4;
    x.beginPath();
    x.arc(cx, cy, r + 2, 0, Math.PI * 2);
    x.stroke();
    x.lineWidth = 1.5;
    x.beginPath();
    x.arc(cx, cy, r + 13, 0, Math.PI * 2);
    x.stroke();
    x.beginPath();
    x.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
    x.strokeStyle = 'rgba(57,224,189,.65)';
    x.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      line(x, cx + dx * r * 1.12, cy + dy * r * 1.12, cx + dx * r * 0.5, cy + dy * r * 0.5, '#39e0bd', 2.4);
    }
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const q = i % 6 ? 6 : 15;
      line(x, cx + Math.cos(a) * (r + 13), cy + Math.sin(a) * (r + 13), cx + Math.cos(a) * (r + 13 + q), cy + Math.sin(a) * (r + 13 + q), 'rgba(57,224,189,.72)', 1.4);
    }
  },

  /** Signing: five slanted columns, one champion for each lane. */
  lanes(x, w, h, p) {
    const list = [p.hero, ...p.roster];
    const skew = w * 0.17;
    const step = (w + skew) / 5;
    x.fillStyle = '#16050a';
    x.fillRect(0, 0, w, h);
    list.forEach((key, i) => {
      const a = i * step;
      const b = a + step;
      x.save();
      poly(x, [[a, 0], [b, 0], [b - skew, h], [a - skew, h]]);
      x.clip();
      face(x, key, (a + b) / 2 - skew * 0.3, h * (i % 2 ? 0.35 : 0.27), 1.22);
      x.restore();
    });
    wash(x, w, h, 'soft-light', '#ff5a68', 0.42);
    const fade = x.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, '#f0d4d6');
    fade.addColorStop(0.5, '#ffffff');
    fade.addColorStop(1, '#6a2630');
    wash(x, w, h, 'multiply', fade);
    for (let i = 1; i < 5; i++) {
      const a = i * step;
      line(x, a, 0, a - skew, h, 'rgba(14,2,5,.92)', 9);
      line(x, a, 0, a - skew, h, '#f3d6a6', 2.4);
    }
    x.save();
    x.textAlign = 'center';
    x.font = '800 24px "Mona Sans","Segoe UI",system-ui,sans-serif';
    LANES.forEach((lane, i) => {
      const lx = bound(i * step + step / 2 - skew * 0.585, 44, w - 44);
      const ly = h * 0.585;
      x.fillStyle = 'rgba(14,2,5,.82)';
      x.fillRect(lx - 37, ly - 25, 74, 35);
      x.strokeStyle = '#f3d6a6';
      x.lineWidth = 1.4;
      x.strokeRect(lx - 37, ly - 25, 74, 35);
      x.fillStyle = '#fff0dc';
      x.fillText(lane, lx, ly);
    });
    x.restore();
  },

  /** Standard: two champions, one line between them. */
  versus(x, w, h, p) {
    const [other] = p.roster;
    const a = [w * 0.78, 0];
    const b = [w * 0.22, h];
    x.fillStyle = '#0e1116';
    x.fillRect(0, 0, w, h);
    x.save();
    poly(x, [[0, 0], a, b, [0, h]]);
    x.clip();
    face(x, p.hero, w * 0.29, h * 0.29, 2.3);
    wash(x, w, h, 'soft-light', '#5f93ff', 0.9);
    x.restore();
    x.save();
    poly(x, [a, [w, 0], [w, h], b]);
    x.clip();
    face(x, other, w * 0.73, h * 0.36, 2.3);
    wash(x, w, h, 'soft-light', '#ff4a35', 0.9);
    x.restore();
    vignette(x, w, h, w / 2, h * 0.36, '#20242c');
    line(x, a[0], a[1], b[0], b[1], 'rgba(0,0,0,.9)', 16);
    line(x, a[0], a[1], b[0], b[1], '#eef2f8', 5);
    const mx = w * 0.54;
    const my = h * 0.4;
    const q = w * 0.082;
    x.save();
    x.shadowColor = '#000';
    x.shadowBlur = 22;
    x.fillStyle = '#0d1016';
    diamond(x, mx, my, q + 8);
    x.fill();
    x.restore();
    x.strokeStyle = '#eef2f8';
    x.lineWidth = 3.5;
    diamond(x, mx, my, q);
    x.stroke();
    x.fillStyle = '#eef2f8';
    diamond(x, mx, my, q * 0.46);
    x.fill();
  },

  /** Legacy: an old cathedral window in gold, with one champion still in colour. */
  arch(x, w, h, p) {
    const cx = w / 2;
    const top = h * 0.115;
    const bw = w * 0.3;
    const bh = h * 0.49;
    const far = Math.hypot(w, h);
    x.fillStyle = '#0d0902';
    x.fillRect(0, 0, w, h);
    const cuts = wedges(x, w, h, cx, h * 0.36, p.roster.filter((k) => champs.has(k)));
    wash(x, w, h, 'saturation', '#000');
    wash(x, w, h, 'color', '#e0a93a', 0.96);
    wash(x, w, h, 'multiply', '#9c7a3e');
    vignette(x, w, h, cx, h * 0.36, '#2c1e08');
    for (const c of cuts) {
      const ex = cx + Math.cos(c) * far;
      const ey = h * 0.36 + Math.sin(c) * far;
      line(x, cx, h * 0.36, ex, ey, 'rgba(10,6,0,.95)', 8);
      line(x, cx, h * 0.36, ex, ey, '#f2c14e', 2);
    }
    const archPath = (grow) => {
      const l = cx - bw - grow;
      const r = cx + bw + grow;
      const t = top - grow * 1.5;
      const b = top + bh + grow;
      x.beginPath();
      x.moveTo(l, b);
      x.lineTo(l, t + bh * 0.42);
      x.quadraticCurveTo(l, t + bh * 0.13, cx, t);
      x.quadraticCurveTo(r, t + bh * 0.13, r, t + bh * 0.42);
      x.lineTo(r, b);
      x.closePath();
    };
    x.save();
    x.shadowColor = '#000';
    x.shadowBlur = 36;
    x.fillStyle = '#0a0601';
    archPath(14);
    x.fill();
    x.restore();
    x.save();
    archPath(0);
    x.clip();
    face(x, p.hero, cx, top + bh * 0.4, 1.6, 0.5, 0.3);
    x.restore();
    x.strokeStyle = '#ffe9ac';
    x.lineWidth = 6;
    archPath(3);
    x.stroke();
    x.strokeStyle = 'rgba(242,193,78,.75)';
    x.lineWidth = 1.6;
    archPath(14);
    x.stroke();
    line(x, cx - bw - 32, top + bh + 15, cx + bw + 32, top + bh + 15, '#f2c14e', 3);
  },

  /** Season: a honeycomb of champions in prism colours, around this season's face. */
  hive(x, w, h, p) {
    x.fillStyle = '#07051a';
    x.fillRect(0, 0, w, h);
    const r = w * 0.142;
    const dx = r * Math.sqrt(3);
    const dy = r * 1.5;
    const list = p.roster.filter((k) => champs.has(k));
    let n = 0;
    for (let j = -1; j * dy < h + r; j++) {
      for (let i = -1; i * dx < w + r; i++) {
        const hx = i * dx + (j % 2 ? dx / 2 : 0);
        const hy = j * dy;
        x.save();
        hexPath(x, hx, hy, r - 2.5);
        x.clip();
        face(x, list[n++ % Math.max(1, list.length)], hx, hy, 0.86, 0.5, 0.33);
        x.restore();
      }
    }
    const stops = [[0, '#a6f7ee'], [0.28, '#b9c6ff'], [0.54, '#e2b8ff'], [0.78, '#ffc6dd'], [1, '#ffe6a6']];
    const prism = x.createLinearGradient(0, 0, w, h);
    stops.forEach(([o, c]) => prism.addColorStop(o, c));
    wash(x, w, h, 'color', prism, 0.78);
    wash(x, w, h, 'multiply', '#8f88b6');
    const cx = w / 2;
    const cy = h * 0.385;
    const big = w * 0.335;
    x.save();
    x.shadowColor = '#000';
    x.shadowBlur = 40;
    x.fillStyle = '#05030f';
    hexPath(x, cx, cy, big + 14);
    x.fill();
    x.restore();
    x.save();
    hexPath(x, cx, cy, big);
    x.clip();
    face(x, p.hero, cx, cy, 1.5, 0.5, 0.3);
    x.restore();
    const rim = x.createLinearGradient(cx - big, cy - big, cx + big, cy + big);
    stops.forEach(([o, c]) => rim.addColorStop(o, c));
    x.strokeStyle = rim;
    x.lineWidth = 7;
    x.lineJoin = 'miter';
    hexPath(x, cx, cy, big + 3);
    x.stroke();
    x.lineWidth = 1.6;
    hexPath(x, cx, cy, big + 14);
    x.stroke();
  },
};

function paintPlain(x, w, h, p) {
  const g = x.createLinearGradient(0, 0, w * 0.4, h);
  g.addColorStop(0, p.plain[0]);
  g.addColorStop(0.52, p.plain[1]);
  g.addColorStop(1, p.plain[2]);
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  x.strokeStyle = p.line;
  x.globalAlpha = 0.18;
  x.lineWidth = 2;
  for (const r of [430, 372, 314]) {
    diamond(x, w / 2, h * 0.42, r);
    x.stroke();
  }
  x.globalAlpha = 1;
  x.lineWidth = 7;
  diamond(x, w / 2, h * 0.385, 150);
  x.stroke();
  x.fillStyle = p.line;
  diamond(x, w / 2, h * 0.385, 72);
  x.fill();
}

/**
 * The flat wrapper print, before any foil lighting.
 * @param {string} key a `pack_types.key`
 * @returns {HTMLCanvasElement}
 */
export function bakePackArt(key) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 972;
  const x = canvas.getContext('2d');
  const w = 640;
  const h = 972;
  const p = packTheme(key);

  if (hasArt(p)) COVERS[p.paint](x, w, h, p);
  else paintPlain(x, w, h, p);

  const band = x.createLinearGradient(0, h * 0.6, 0, h * 0.9);
  band.addColorStop(0, `rgba(${p.band},0)`);
  band.addColorStop(0.45, `rgba(${p.band},.76)`);
  band.addColorStop(1, `rgba(${p.band},.95)`);
  x.fillStyle = band;
  x.fillRect(0, h * 0.6, w, h * 0.4);

  x.fillStyle = p.crimp;
  x.fillRect(0, 0, w, h * 0.085);
  x.fillRect(0, h * 0.945, w, h * 0.055);
  x.fillStyle = p.line;
  x.fillRect(0, h * 0.085, w, 3);
  x.fillRect(0, h * 0.945 - 3, w, 3);

  const family = '"Mona Sans","Segoe UI",system-ui,sans-serif';
  const spaced = (stretch, spacing) => {
    // Neither property exists in every browser; the text is still right without them.
    try {
      x.fontStretch = stretch;
      x.letterSpacing = spacing;
    } catch { /* older canvas */ }
  };
  x.textAlign = 'center';
  x.textBaseline = 'alphabetic';
  x.save();
  x.shadowColor = 'rgba(0,0,0,.9)';
  x.shadowBlur = 14;
  spaced('expanded', '13px');
  x.font = `760 32px ${family}`;
  x.fillStyle = p.small;
  x.fillText('LOM', w / 2 + 6, h * 0.672);
  spaced('condensed', '0px');
  x.font = `870 128px ${family}`;
  const size = Math.min(128, Math.floor((128 * (w - 84)) / x.measureText(p.title).width));
  x.font = `870 ${size}px ${family}`;
  x.fillStyle = p.ink;
  x.fillText(p.title, w / 2, h * 0.79);
  spaced('expanded', '4px');
  x.font = `700 ${p.sub.length > 22 ? 17 : 21}px ${family}`;
  x.fillStyle = p.small;
  x.fillText(p.sub, w / 2 + 2, h * 0.865);
  x.restore();
  return canvas;
}
