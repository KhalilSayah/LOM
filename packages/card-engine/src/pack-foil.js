/**
 * The foil wrapper: a lit mesh that can be torn.
 *
 * WebGL does what CSS cannot here. Every pixel of the wrapper is shaded from a baked crease
 * map, so the foil catches the light as it moves, and the top strip is real geometry that
 * rolls away from the finger and shows its silver inside.
 *
 * The same renderer draws the still covers used on Home and in the shop, so a pack looks the
 * same before it is opened as it does in the player's hand.
 */

import { bakePackArt, bound, loadPackArt, packTheme } from './pack-art.js';

const PERSPECTIVE = 1100;

const VERTEX = `#version 300 es
precision highp float;
in vec2 aP;
uniform vec2 uView, uSize; uniform mat4 uM;
uniform float uPersp, uPart, uFront, uDir, uPuff, uFly;
out vec2 vL; out vec3 vW;
void main() {
  vL = aP;
  vec3 p = vec3(aP * uSize, 0.);
  p.z += uPuff * (1. - aP.x * aP.x) * (1. - pow(abs(aP.y), 5.)) * uSize.x * .13;
  if (uPart > .5) {
    float sx = p.x * uDir, a = uFront - sx;
    if (a > 0.) {
      float R = uSize.x * .17, tm = 2.5, th = min(a / R, tm), ex = max(a - R * tm, 0.);
      p.x = (uFront - R * sin(th) - ex * cos(tm)) * uDir;
      p.z += R * (1. - cos(th)) + ex * sin(tm);
      p.y += a * .16;
    }
    if (uFly > 0.) {
      float f = uFly, c = cos(f * 3.6 * uDir), s = sin(f * 3.6 * uDir);
      vec2 o = vec2(0., uSize.y * .9), q = p.xy - o;
      p.xy = o + vec2(q.x * c - q.y * s, q.x * s + q.y * c);
      p.x += uDir * f * uSize.x * 1.8;
      p.y += uSize.y * (1.15 * f - 3.1 * f * f);
      p.z += f * 90.;
    }
  }
  vec4 w = uM * vec4(p, 1.);
  vW = w.xyz;
  gl_Position = vec4(w.x / uView.x, w.y / uView.y, -w.z / 2400., 1. - w.z / uPersp);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vL; in vec3 vW; out vec4 C;
uniform sampler2D uArt, uNorm;
uniform float uPart, uFront, uDir, uPersp;
uniform vec2 uSize, uLight;
uniform vec3 uFoil, uInner;
const float LINE = .76;
float zig(float x, float f) { return abs(fract(x * f) - .5) * 2.; }
float tearY(float x) { return LINE + .014 * sin(x * 23.) + .009 * sin(x * 61. + 1.3) + .02 * (zig(x, 5.7) - .5) + .008 * (zig(x, 17.) - .5); }
vec3 env(vec3 r) {
  float top = smoothstep(.02, .62, r.y + .22 * sin(r.x * 2.6));
  float strip = smoothstep(.9, 1., sin(r.x * 5. + r.y * 3.) * .5 + .5);
  float key = pow(max(dot(r, normalize(vec3(uLight, .75))), 0.), 16.);
  return vec3(.09, .11, .16) + vec3(.3, .35, .46) * top + vec3(.2, .23, .3) * strip * .6 + vec3(1., .97, .9) * key * 1.05;
}
void main() {
  vec2 uv = vL * .5 + .5;
  float px = fwidth(vL.y) * 1.3 + .0005, a = 1.;
  a *= smoothstep(0., px, (1. - .03 * zig(vL.x, 17.)) - vL.y);
  a *= smoothstep(0., px, vL.y + (1. - .03 * zig(vL.x, 17.)));
  float sx = vL.x * uSize.x * uDir, ty = tearY(vL.x), torn = 0.;
  if (uPart < .5) {
    if (sx < uFront) { a *= smoothstep(0., px, ty - vL.y); torn = 1. - smoothstep(.0, .02, ty - vL.y); }
  } else {
    a *= smoothstep(0., px, vL.y - ty);
    a *= step(sx, uFront);
    torn = 1. - smoothstep(.0, .016, vL.y - ty);
  }
  if (a < .01) discard;
  vec3 Ng = normalize(cross(dFdx(vW), dFdy(vW)));
  vec3 V = normalize(vec3(0., 0., uPersp) - vW);
  if (dot(Ng, V) < 0.) Ng = -Ng;
  vec3 n = texture(uNorm, uv).xyz * 2. - 1.;
  vec3 N = normalize(Ng + vec3(n.xy, 0.) * .46);
  vec3 R = reflect(-V, N);
  float diff = max(dot(N, normalize(vec3(uLight, .9))), 0.);
  vec3 alb = gl_FrontFacing ? texture(uArt, uv).rgb : uInner;
  vec3 col = alb * (.62 + .46 * diff) + env(R) * uFoil * (alb * .82 + .05);
  col = mix(col, (uInner + .22) * (.55 + .6 * diff), torn * .92);
  col = col / (1. + col * .18);
  C = vec4(col * a, a);
}`;

/** The creases, baked once: the same crumple on every pack, from a fixed seed. */
let creases = null;
function bakeCreases() {
  if (creases) return creases;
  const w = 360;
  const h = 548;
  const TAU = Math.PI * 2;
  let seed = 7741;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const grid = new Float32Array(256 * 256);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const at = (x, y) => grid[((y & 255) << 8) | (x & 255)];
  const smooth = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = smooth(x - xi);
    const fy = smooth(y - yi);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const ridge = (x, y) => 1 - Math.abs(noise(x, y) * 2 - 1);
  const height = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const u = i / w;
      const v = j / h;
      let z = ridge(u * 2.3 + v * 1.2, v * 1.9 - u * 0.8 + 3) ** 3.2 * 0.36;
      z += ridge(u * 5.8 - v * 2.4 + 9, v * 4.6 + u * 1.7) ** 5 * 0.2;
      z += ridge(u * 13 + v * 4 + 21, v * 11 - u * 3) ** 7 * 0.075;
      z += noise(u * 70 + 2, v * 96) * 0.006;
      const nearTop = bound((v - 0.78) / 0.14);
      const nearBottom = bound((0.22 - v) / 0.16);
      z += Math.sin(u * TAU * 11 + noise(u * 5, v * 3) * 4) * (nearTop ** 2 + nearBottom ** 2) * 0.075;
      if (v > 0.925 || v < 0.052) z = Math.sin(u * TAU * 46) * 0.075;
      height[j * w + i] = z;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const l = height[j * w + Math.max(0, i - 1)];
      const r = height[j * w + Math.min(w - 1, i + 1)];
      const d = height[Math.max(0, j - 1) * w + i];
      const t = height[Math.min(h - 1, j + 1) * w + i];
      const o = (j * w + i) * 4;
      data[o] = (bound((l - r) * 8, -1, 1) * 0.5 + 0.5) * 255;
      data[o + 1] = (bound((d - t) * 8, -1, 1) * 0.5 + 0.5) * 255;
      data[o + 2] = 255;
      data[o + 3] = 255;
    }
  }
  creases = { w, h, data };
  return creases;
}

function modelMatrix(P) {
  const r = Math.PI / 180;
  const cx = Math.cos(P.rx * r);
  const sx = Math.sin(P.rx * r);
  const cy = Math.cos(P.ry * r);
  const sy = Math.sin(P.ry * r);
  const cz = Math.cos(P.rz * r);
  const sz = Math.sin(P.rz * r);
  // translate * rotZ * rotX * rotY * scale, column-major
  return new Float32Array([
    (cz * cy - sz * sx * sy) * P.sx, (sz * cy + cz * sx * sy) * P.sx, -cx * sy * P.sx, 0,
    -sz * cx * P.sy, cz * cx * P.sy, sx * P.sy, 0,
    cz * sy + sz * sx * cy, sz * sy - cz * sx * cy, cx * cy, 0,
    P.x, P.y, P.z, 1,
  ]);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {null | {
 *   setPack: (key: string) => void,
 *   resize: (cssW: number, cssH: number, dpr: number) => void,
 *   draw: (P: object, view: {w:number,h:number}, pack: {w:number,h:number}, light: {x:number,y:number}) => void,
 *   clear: () => void,
 *   destroy: () => void,
 * }} null when the device has no WebGL2: the scene then runs without the wrapper
 */
export function createFoil(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) return null;

  const U = {};
  let indexCount = 0;
  let artTexture = null;
  let packKey = 'DAILY';

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader');
    return shader;
  };
  const texture = (unit, upload) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    upload();
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const uploadArt = (art) => {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, art);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  };

  try {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'program');
    gl.useProgram(program);
    for (const name of ['uView', 'uSize', 'uM', 'uPersp', 'uPart', 'uFront', 'uDir', 'uPuff', 'uFly', 'uLight', 'uArt', 'uNorm', 'uFoil', 'uInner']) {
      U[name] = gl.getUniformLocation(program, name);
    }

    const nx = 72;
    const ny = 64;
    const verts = new Float32Array((nx + 1) * (ny + 1) * 2);
    const index = new Uint16Array(nx * ny * 6);
    let v = 0;
    let q = 0;
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        verts[v++] = (i / nx) * 2 - 1;
        verts[v++] = (j / ny) * 2 - 1;
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 1;
        const d = c + 1;
        index[q++] = a; index[q++] = b; index[q++] = d;
        index[q++] = a; index[q++] = d; index[q++] = c;
      }
    }
    indexCount = index.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aP');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    artTexture = texture(0, () => uploadArt(bakePackArt(packKey)));
    const map = bakeCreases();
    texture(1, () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, map.w, map.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, map.data));
    gl.uniform1i(U.uArt, 0);
    gl.uniform1i(U.uNorm, 1);
    gl.uniform1f(U.uPersp, PERSPECTIVE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  } catch (err) {
    console.warn('[pack] foil renderer unavailable', err);
    return null;
  }

  return {
    setPack(key) {
      packKey = key;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, artTexture);
      uploadArt(bakePackArt(key));
      gl.generateMipmap(gl.TEXTURE_2D);
    },
    resize(cssW, cssH, dpr) {
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    clear() {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    },
    draw(P, view, pack, light) {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const halfW = pack.w / 2;
      const theme = packTheme(packKey);
      gl.uniform2f(U.uView, view.w / 2, view.h / 2);
      gl.uniform2f(U.uSize, halfW, pack.h / 2);
      gl.uniformMatrix4fv(U.uM, false, modelMatrix(P));
      gl.uniform1f(U.uFront, -halfW * 1.04 + P.t * halfW * 2.08);
      gl.uniform1f(U.uDir, P.dir);
      gl.uniform1f(U.uPuff, 1);
      gl.uniform1f(U.uFly, P.fly);
      gl.uniform2f(U.uLight, light.x, light.y);
      gl.uniform3fv(U.uFoil, theme.foil);
      gl.uniform3fv(U.uInner, theme.inner);
      gl.uniform1f(U.uPart, 0);
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
      if (P.t > 0 && P.fly < 1) {
        gl.uniform1f(U.uPart, 1);
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
      }
    },
    destroy() {
      // A page may only hold a few live contexts; give this one back straight away.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

/* --- still covers ------------------------------------------------------------- */

/** A cover canvas is this size, with this share of its width being the pack itself. */
export const COVER_SIZE = { w: 580, h: 850, packShare: 520 / 580 };

const covers = new Map();
let coverFoil;

function paintCover(key, target) {
  const x = target.getContext('2d');
  x.clearRect(0, 0, COVER_SIZE.w, COVER_SIZE.h);
  if (coverFoil === undefined) {
    const stage = document.createElement('canvas');
    coverFoil = { canvas: stage, foil: createFoil(stage) };
    coverFoil.foil?.resize(COVER_SIZE.w, COVER_SIZE.h, 1);
  }
  if (coverFoil.foil) {
    coverFoil.foil.setPack(key);
    coverFoil.foil.draw(
      { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, t: 0, dir: 1, fly: 0 },
      { w: COVER_SIZE.w, h: COVER_SIZE.h },
      { w: 520, h: 790 },
      { x: -0.34, y: 0.62 },
    );
    x.drawImage(coverFoil.canvas, 0, 0);
  } else {
    x.drawImage(bakePackArt(key), 30, 30, 520, 790);
  }
}

function fontsReady() {
  try {
    return Promise.race([
      Promise.all([document.fonts.load('870 118px "Mona Sans"'), document.fonts.load('700 21px "Mona Sans"')]),
      new Promise((done) => setTimeout(done, 1200)),
    ]);
  } catch {
    return Promise.resolve();
  }
}

/**
 * A still picture of a sealed pack. Paints straight away with the wrapper's palette, then
 * again once its champion art has arrived.
 *
 * @param {string} key a `pack_types.key`
 * @param {(cover: HTMLCanvasElement) => void} onPaint called on every paint
 * @returns {() => void} stop listening
 */
export function packCover(key, onPaint) {
  const id = String(key || 'DAILY').toUpperCase();
  let entry = covers.get(id);
  if (!entry) {
    const canvas = document.createElement('canvas');
    canvas.width = COVER_SIZE.w;
    canvas.height = COVER_SIZE.h;
    entry = { canvas, listeners: new Set(), painted: false };
    covers.set(id, entry);
    const current = entry;
    fontsReady().then(() => {
      paintCover(id, canvas);
      current.painted = true;
      current.listeners.forEach((fn) => fn(canvas));
      return loadPackArt(id);
    }).then(() => {
      paintCover(id, canvas);
      current.listeners.forEach((fn) => fn(canvas));
    });
  }
  entry.listeners.add(onPaint);
  if (entry.painted) onPaint(entry.canvas);
  const held = entry;
  return () => held.listeners.delete(onPaint);
}
