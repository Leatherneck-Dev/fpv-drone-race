"use strict";
// ============================================================
//  엔진: 렌더러 · 하늘 · 텍스처/재질 · 충돌체 · 지형/식생 · LED 게이트
// ============================================================
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const deg = d => d * Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const C = hex => new THREE.Color(hex).convertSRGBToLinear();      // sRGB hex → 선형 색
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
function seeded(seed) { let s = seed % 2147483647; if (s <= 0) s += 2147483646; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function hash2(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  return lerp(lerp(hash2(xi, zi), hash2(xi + 1, zi), u), lerp(hash2(xi, zi + 1), hash2(xi + 1, zi + 1), u), v);
}
function fbm(x, z, oct = 4) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, z * f); a *= 0.5; f *= 2.03; } return s; }

// ---------- 렌더러 / 장면 ----------
const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(95, 1, 0.05, 3000);
const hemi = new THREE.HemisphereLight(0xffffff, 0x333333, 0.6);
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 1, far: 450 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
scene.add(hemi, sun, sun.target);
const world = new THREE.Group(); scene.add(world);
const anim = [];                       // 매 프레임 호출 (풍차, 자동차 등)
const sunDir = V3(0.4, 0.8, 0.3).normalize();
function followSun(focus) {
  sun.target.position.copy(focus);
  sun.position.copy(focus).addScaledVector(sunDir, 220);
  sun.target.updateMatrixWorld();
}

// 후처리(블룸 등)는 무거워서 쓰지 않음 — 렌더러 톤매핑만 사용
function renderFrame() { renderer.render(scene, camera); }
let HALO_K = 1;                        // 맵마다 게이트 빛무리 세기

// ---------- 하늘 (그라디언트 + 태양 + 별) ----------
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: {
    top: { value: new THREE.Color() }, mid: { value: new THREE.Color() }, bottom: { value: new THREE.Color() },
    sunDir: { value: V3(0, 1, 0) }, sunCol: { value: new THREE.Color() }, stars: { value: 0 }, sunSize: { value: 1 },
  },
  vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform vec3 top, mid, bottom, sunCol, sunDir; uniform float stars, sunSize; varying vec3 vDir;
    float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    void main(){
      vec3 d = normalize(vDir); float h = d.y;
      vec3 c = h > 0.0 ? mix(mid, top, pow(clamp(h, 0.0, 1.0), 0.5)) : mix(mid, bottom, clamp(-h * 5.0, 0.0, 1.0));
      float s = max(dot(d, normalize(sunDir)), 0.0);
      c += sunCol * (pow(s, 1400.0 / sunSize) * 3.0 + pow(s, 10.0) * 0.28 + pow(s, 3.0) * 0.08);
      if (stars > 0.0) { vec3 q = floor(d * 380.0); float st = step(0.9982, hash(q)); c += vec3(st) * stars * clamp(h * 4.0, 0.0, 1.0) * (0.5 + 0.5 * hash(q + 1.7)); }
      gl_FragColor = linearToOutputTexel(vec4(c, 1.0));
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(2400, 32, 16), skyMat);
sky.frustumCulled = false; sky.renderOrder = -10; scene.add(sky);

function applyTheme(t) {
  const u = skyMat.uniforms;
  u.top.value.copy(C(t.skyTop)); u.mid.value.copy(C(t.skyMid)); u.bottom.value.copy(C(t.skyBottom || t.skyMid));
  sunDir.set(...t.sunDir).normalize(); u.sunDir.value.copy(sunDir);
  u.sunCol.value.copy(C(t.sunGlow === undefined ? t.sunColor : t.sunGlow)); u.stars.value = t.stars || 0; u.sunSize.value = t.sunSize || 1;
  scene.fog = new THREE.Fog(C(t.fog), t.fogNear, t.fogFar);
  scene.background = C(t.fog);
  hemi.color.copy(C(t.hemiSky)); hemi.groundColor.copy(C(t.hemiGround)); hemi.intensity = t.hemiInt;
  sun.color.copy(C(t.sunColor)); sun.intensity = t.sunInt; sun.castShadow = t.sunInt > 0.05;
  renderer.toneMappingExposure = t.exposure || 1;
  HALO_K = t.halo || 1;
  sky.visible = !t.indoor;
}

// ---------- 캔버스 텍스처 ----------
function ctex(w, h, draw, o = {}) {
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  draw(cv.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.encoding = o.linear ? THREE.LinearEncoding : THREE.sRGBEncoding;
  if (o.rep) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(o.rep[0], o.rep[1]); }
  t.anisotropy = MAX_ANISO;
  return t;
}
const rnd01 = Math.random;
function speckle(g, w, h, n, colors, size = [1, 3], alpha = [0.15, 0.5]) {
  for (let i = 0; i < n; i++) {
    g.globalAlpha = lerp(alpha[0], alpha[1], rnd01());
    g.fillStyle = colors[(rnd01() * colors.length) | 0];
    const s = lerp(size[0], size[1], rnd01());
    g.fillRect(rnd01() * w, rnd01() * h, s, s);
  }
  g.globalAlpha = 1;
}
function blotches(g, w, h, n, color, r = [20, 60], a = 0.08) {
  for (let i = 0; i < n; i++) {
    const x = rnd01() * w, y = rnd01() * h, rr = lerp(r[0], r[1], rnd01());
    const gr = g.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, color); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.globalAlpha = a; g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  g.globalAlpha = 1;
}
const TEX = {
  grass: rep => ctex(512, 512, (g, w, h) => {
    g.fillStyle = "#5e8f3c"; g.fillRect(0, 0, w, h);
    blotches(g, w, h, 40, "#86b04a", [30, 90], 0.25); blotches(g, w, h, 30, "#3f6e2a", [30, 80], 0.25);
    const cols = ["#4d7d32", "#6fa046", "#87b556", "#3e6b28", "#9cc066"];
    for (let i = 0; i < 9000; i++) {
      const x = rnd01() * w, y = rnd01() * h;
      g.strokeStyle = cols[(rnd01() * cols.length) | 0]; g.globalAlpha = 0.5; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + rnd01() * 2 - 1, y - 2 - rnd01() * 4); g.stroke();
    }
    g.globalAlpha = 1;
  }, { rep: [rep, rep] }),
  turf: rep => ctex(256, 256, (g, w, h) => {
    g.fillStyle = "#4f9a45"; g.fillRect(0, 0, w, h / 2); g.fillStyle = "#468c3d"; g.fillRect(0, h / 2, w, h / 2);
    speckle(g, w, h, 4000, ["#3a7a33", "#62ad52", "#57a04a"], [1, 2], [0.2, 0.5]);
  }, { rep }),
  concrete: rep => ctex(512, 512, (g, w, h) => {
    g.fillStyle = "#9a9da1"; g.fillRect(0, 0, w, h);
    blotches(g, w, h, 30, "#6f7378", [30, 120], 0.12); blotches(g, w, h, 20, "#c4c6c8", [30, 100], 0.12);
    speckle(g, w, h, 12000, ["#7d8186", "#b4b7ba", "#8c9095"], [1, 2], [0.2, 0.6]);
    g.strokeStyle = "rgba(40,40,45,0.35)"; g.lineWidth = 2; g.strokeRect(1, 1, w - 2, h - 2);
  }, { rep }),
  asphalt: rep => ctex(512, 512, (g, w, h) => {
    g.fillStyle = "#2c2f34"; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 16000, ["#3b3f46", "#23262a", "#4a4e55"], [1, 2], [0.3, 0.7]);
    blotches(g, w, h, 15, "#16181b", [30, 90], 0.2);
  }, { rep: [rep, rep] }),
  corrugated: (base) => ctex(128, 128, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) {
      const gr = g.createLinearGradient(x, 0, x + 16, 0);
      gr.addColorStop(0, "rgba(0,0,0,0.25)"); gr.addColorStop(0.5, "rgba(255,255,255,0.18)"); gr.addColorStop(1, "rgba(0,0,0,0.25)");
      g.fillStyle = gr; g.fillRect(x, 0, 16, h);
    }
    speckle(g, w, h, 600, ["#000", "#5a3a20"], [1, 3], [0.05, 0.2]);
  }, { rep: [1, 1] }),
  planks: (base) => ctex(256, 256, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 32) { g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(0, y, w, 2); }
    speckle(g, w, h, 3000, ["#000", "#fff"], [1, 3], [0.03, 0.12]);
  }, { rep: [1, 1] }),
  facade: (base, window, lit) => {          // 건물 외벽 + 창문 (lit: 야간 불빛 맵)
    const rows = [];
    const draw = (g, w, h, emis) => {
      g.fillStyle = emis ? "#000" : base; g.fillRect(0, 0, w, h);
      if (!emis) speckle(g, w, h, 1500, ["#000", "#fff"], [1, 3], [0.03, 0.08]);
      let k = 0;
      for (let y = 10; y < h - 10; y += 32) for (let x = 8; x < w - 8; x += 32) {
        const on = rows[k] !== undefined ? rows[k] : (rows[k] = rnd01() < (lit ? 0.22 : 0));
        k++;
        if (emis) { if (on) { g.fillStyle = rnd01() < 0.75 ? "#e8b878" : "#8fb4d8"; g.globalAlpha = 0.35 + rnd01() * 0.4; g.fillRect(x, y, 20, 22); g.globalAlpha = 1; } }
        else { g.fillStyle = window; g.fillRect(x, y, 20, 22); g.fillStyle = "rgba(255,255,255,0.08)"; g.fillRect(x, y, 20, 6); }
      }
    };
    const map = ctex(256, 256, (g, w, h) => draw(g, w, h, false), { rep: [1, 1] });
    const emis = lit ? ctex(256, 256, (g, w, h) => draw(g, w, h, true), { rep: [1, 1] }) : null;
    return { map, emis };
  },
  glowRadial: () => ctex(128, 128, (g, w, h) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.2, "rgba(255,255,255,0.6)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }),
  glowSquare: () => ctex(256, 256, (g, w, h) => {
    const a = w * 0.17, s = w * 0.66;
    g.strokeStyle = "#fff"; g.shadowColor = "#fff";
    g.shadowBlur = 40; g.lineWidth = 6; g.globalAlpha = 0.6; g.strokeRect(a, a, s, s);
    g.shadowBlur = 16; g.lineWidth = 5; g.globalAlpha = 0.9; g.strokeRect(a, a, s, s);
  }),
  glowCircle: () => ctex(256, 256, (g, w, h) => {
    g.strokeStyle = "#fff"; g.shadowColor = "#fff";
    for (const [b, lw, al] of [[40, 6, 0.6], [16, 5, 0.9]]) { g.shadowBlur = b; g.lineWidth = lw; g.globalAlpha = al; g.beginPath(); g.arc(128, 128, w * 0.33, 0, Math.PI * 2); g.stroke(); }
  }),
  cloud: () => ctex(256, 128, (g, w, h) => {
    for (let i = 0; i < 26; i++) {
      const x = 40 + rnd01() * 176, y = 50 + rnd01() * 40, r = 18 + rnd01() * 30;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, "rgba(255,255,255,0.55)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }),
  grassBlade: () => {
    // 투명 부분 색이 검게 번지지 않도록 RGB를 풀색으로 채운 DataTexture 사용
    const cv = document.createElement("canvas"); cv.width = cv.height = 64;
    const g = cv.getContext("2d");
    for (let i = 0; i < 12; i++) {
      const x = 6 + rnd01() * 52, lean = (rnd01() - 0.5) * 16, hh = 28 + rnd01() * 34;
      g.strokeStyle = ["#6aa842", "#86c057", "#5a9638", "#9ccd68"][i % 4]; g.lineWidth = 3.2; g.lineCap = "round";
      g.beginPath(); g.moveTo(x, 64); g.quadraticCurveTo(x + lean * 0.3, 64 - hh * 0.6, x + lean, 64 - hh); g.stroke();
    }
    const img = g.getImageData(0, 0, 64, 64), d = new Uint8Array(img.data.length);
    for (let i = 0; i < d.length; i += 4) {
      const a = img.data[i + 3];
      d[i] = a ? img.data[i] : 112; d[i + 1] = a ? img.data[i + 1] : 170; d[i + 2] = a ? img.data[i + 2] : 70; d[i + 3] = a;
    }
    const t = new THREE.DataTexture(d, 64, 64, THREE.RGBAFormat);
    t.flipY = true; t.encoding = THREE.sRGBEncoding; t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    return t;
  },
  lane: (rep) => ctex(64, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.fillStyle = "#e8e8e8"; g.fillRect(24, 0, 16, 140);
  }, { rep }),
};

// ---------- 재질 ----------
function std(color, o = {}) { return new THREE.MeshStandardMaterial(Object.assign({ color: C(color), roughness: 0.85, metalness: 0 }, o)); }
function basic(color, o = {}) { return new THREE.MeshBasicMaterial(Object.assign({ color: C(color), toneMapped: false }, o)); }
let GLOW = null;                // 맵마다 새로 생성 (dispose 대상)
function glowTex() { if (!GLOW) GLOW = { radial: TEX.glowRadial(), square: TEX.glowSquare(), circle: TEX.glowCircle() }; return GLOW; }
function glowSprite(x, y, z, color, size, opacity = 0.9, parent = world) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex().radial, color: C(color), blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, opacity, toneMapped: false }));
  s.position.set(x, y, z); s.scale.set(size, size, 1); parent.add(s);
  return s;
}

// ---------- 충돌체: 박스(OBB) / 수직 원기둥 / 구, 8m 격자로 빠르게 검색 ----------
let colliders = [];
let colliderTag = "solid", hitTag = "solid";        // 충돌 재질: solid · tree · rock · metal (파편 효과 구분용)
const CELL = 8, cgrid = new Map(), NONE = [];
const ckey = (i, k) => i * 100003 + k;
function insertCollider(k) {
  k.tag = colliderTag;
  colliders.push(k);
  const r = k.br + 0.4;
  const i0 = Math.floor((k.c.x - r) / CELL), i1 = Math.floor((k.c.x + r) / CELL);
  const k0 = Math.floor((k.c.z - r) / CELL), k1 = Math.floor((k.c.z + r) / CELL);
  for (let i = i0; i <= i1; i++) for (let j = k0; j <= k1; j++) {
    const key = ckey(i, j);
    let l = cgrid.get(key); if (!l) cgrid.set(key, l = []);
    l.push(k);
  }
}
function boxColliderFromObject(obj, hx, hy, hz) {
  obj.updateWorldMatrix(true, false);
  const c = V3(), ax = V3(), ay = V3(), az = V3();
  c.setFromMatrixPosition(obj.matrixWorld);
  obj.matrixWorld.extractBasis(ax, ay, az); ax.normalize(); ay.normalize(); az.normalize();
  insertCollider({ t: 0, c, ax, ay, az, h: [hx, hy, hz], br: Math.hypot(hx, hy, hz) });
}
function solidBox(x, y, z, w, h, d, yaw = 0) {
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  insertCollider({ t: 0, c: V3(x, y, z), ax: V3(cs, 0, -sn), ay: V3(0, 1, 0), az: V3(sn, 0, cs), h: [w / 2, h / 2, d / 2], br: Math.hypot(w, h, d) / 2 });
}
function cylCollider(x, z, r, y0, y1) { insertCollider({ t: 1, c: V3(x, (y0 + y1) / 2, z), r, y0, y1, br: Math.hypot(r, (y1 - y0) / 2) }); }
function sphereCollider(x, y, z, r) { insertCollider({ t: 2, c: V3(x, y, z), r, br: r }); }

const _d = V3(), _cl = V3(), _n = V3();
function collideSphere(p, r, outN) {
  const list = cgrid.get(ckey(Math.floor(p.x / CELL), Math.floor(p.z / CELL))) || NONE;
  let best = 0;
  for (const k of list) {
    const dx = p.x - k.c.x, dy = p.y - k.c.y, dz = p.z - k.c.z, lim = k.br + r;
    if (dx * dx + dy * dy + dz * dz > lim * lim) continue;
    if (k.t === 0) {
      _d.set(dx, dy, dz);
      const lx = _d.dot(k.ax), ly = _d.dot(k.ay), lz = _d.dot(k.az);
      const cx = clamp(lx, -k.h[0], k.h[0]), cy = clamp(ly, -k.h[1], k.h[1]), cz = clamp(lz, -k.h[2], k.h[2]);
      if (cx === lx && cy === ly && cz === lz) {
        const px = k.h[0] - Math.abs(lx), py = k.h[1] - Math.abs(ly), pz = k.h[2] - Math.abs(lz);
        let pen;
        if (px <= py && px <= pz) { pen = px + r; _n.copy(k.ax).multiplyScalar(lx < 0 ? -1 : 1); }
        else if (py <= pz) { pen = py + r; _n.copy(k.ay).multiplyScalar(ly < 0 ? -1 : 1); }
        else { pen = pz + r; _n.copy(k.az).multiplyScalar(lz < 0 ? -1 : 1); }
        if (pen > best) { best = pen; outN.copy(_n); hitTag = k.tag; }
      } else {
        _cl.copy(k.c).addScaledVector(k.ax, cx).addScaledVector(k.ay, cy).addScaledVector(k.az, cz);
        _n.subVectors(p, _cl);
        const dist = _n.length();
        if (dist < r && r - dist > best) { best = r - dist; outN.copy(_n).divideScalar(dist || 1); hitTag = k.tag; }
      }
    } else if (k.t === 1) {
      const dh = Math.hypot(dx, dz);
      if (dh < k.r && p.y > k.y0 && p.y < k.y1) {
        const side = k.r - dh, top = k.y1 - p.y;
        if (top < side) { if (top + r > best) { best = top + r; outN.set(0, 1, 0); hitTag = k.tag; } }
        else if (side + r > best) { best = side + r; if (dh > 1e-6) outN.set(dx / dh, 0, dz / dh); else outN.set(1, 0, 0); hitTag = k.tag; }
      } else {
        const s = dh > k.r ? k.r / dh : 1;
        _cl.set(k.c.x + dx * s, clamp(p.y, k.y0, k.y1), k.c.z + dz * s);
        _n.subVectors(p, _cl);
        const dist = _n.length();
        if (dist < r && r - dist > best) { best = r - dist; outN.copy(_n).divideScalar(dist || 1); hitTag = k.tag; }
      }
    } else {
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz), pen = k.r + r - dist;
      if (pen > best) { best = pen; outN.set(dx, dy, dz).divideScalar(dist || 1); hitTag = k.tag; }
    }
  }
  return best;
}

// ---------- 파편 · 먼지 효과 (스프라이트 풀) ----------
const FX = { list: [], tex: null, group: new THREE.Group() };
scene.add(FX.group);
function fxTex() {
  if (!FX.tex) FX.tex = ctex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.45, "rgba(255,255,255,0.55)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
  return FX.tex;
}
const _fd = V3();
// o: { colors, count, speed, spread, size, grow, life, gravity, drag, opacity, additive }
function burst(p, n, o) {
  for (let i = 0; i < o.count; i++) {
    let f = FX.list.find(x => !x.alive);
    if (!f) {
      if (FX.list.length >= 220) return;
      f = { sp: new THREE.Sprite(new THREE.SpriteMaterial({ map: fxTex(), transparent: true, depthWrite: false })), v: V3() };
      FX.group.add(f.sp); FX.list.push(f);
    }
    const m = f.sp.material;
    m.blending = o.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.color.copy(C(o.colors[(Math.random() * o.colors.length) | 0])); if (o.additive) m.color.multiplyScalar(3);
    _fd.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).multiplyScalar(o.spread).add(n).normalize();
    f.v.copy(_fd).multiplyScalar(o.speed * lerp(0.35, 1.2, Math.random()));
    Object.assign(f, { alive: true, t: 0, life: o.life * lerp(0.6, 1.3, Math.random()), size: o.size * lerp(0.6, 1.4, Math.random()),
      grow: o.grow || 0, grav: o.gravity || 0, drag: o.drag || 0, op: o.opacity || 1 });
    f.sp.position.copy(p).addScaledVector(n, 0.08); f.sp.visible = true;
  }
}
function fxUpdate(dt) {
  for (const f of FX.list) {
    if (!f.alive) continue;
    f.t += dt;
    if (f.t >= f.life) { f.alive = false; f.sp.visible = false; continue; }
    f.v.y -= f.grav * dt; f.v.multiplyScalar(Math.exp(-f.drag * dt));
    f.sp.position.addScaledVector(f.v, dt);
    if (f.sp.position.y < 0.03) { f.sp.position.y = 0.03; f.v.y = Math.abs(f.v.y) * 0.2; f.v.x *= 0.6; f.v.z *= 0.6; }
    const k = f.t / f.life, s = f.size * (1 + f.grow * k);
    const near = smoothstep(0.5, 1.6, f.sp.position.distanceTo(camera.position));   // 카메라 바로 앞 먼지는 흐리게 (화면이 뿌예지지 않게)
    f.sp.scale.set(s, s, 1); f.sp.material.opacity = f.op * (1 - k * k) * near;
  }
}

// ---------- 도형 도우미 ----------
function box(x, y, z, w, h, d, mat, o = {}) {
  const m = new THREE.Mesh(o.geo || new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  if (o.yaw) m.rotation.y = o.yaw;
  m.castShadow = o.shadow !== false; m.receiveShadow = o.receive !== false;
  (o.parent || world).add(m);
  if (o.collide !== false) boxColliderFromObject(m, w / 2, h / 2, d / 2);
  return m;
}
function cyl(x, y, z, r0, r1, h, mat, o = {}) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, o.seg || 12), mat);
  m.position.set(x, y, z); m.castShadow = o.shadow !== false; m.receiveShadow = true;
  (o.parent || world).add(m);
  if (o.collide !== false) cylCollider(x, z, Math.max(r0, r1), y - h / 2, y + h / 2);
  return m;
}
// 박스 UV를 실제 크기에 맞춰 늘림 → 재질 하나를 여러 건물이 공유해도 창문 크기가 일정
function boxGeoUV(w, h, d, unit) {
  const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv;
  const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v; uv.setXY(i, uv.getX(i) * faces[f][0] / unit, uv.getY(i) * faces[f][1] / unit);
  }
  return g;
}
const _m4 = new THREE.Matrix4(), _q4 = new THREE.Quaternion(), _s4 = V3(), _p4 = V3(), _e4 = new THREE.Euler();
function M(x, y, z, ry = 0, s = 1, sy = s, rx = 0, rz = 0) {
  return new THREE.Matrix4().compose(V3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), V3(s, sy, s));
}
function mergeGeos(parts) {
  const pos = [], nor = [], col = [];
  for (const p of parts) {
    const g = p.g.index ? p.g.toNonIndexed() : p.g.clone();
    g.applyMatrix4(p.m);
    const pa = g.attributes.position.array, na = g.attributes.normal.array, cc = C(p.c);
    for (let i = 0; i < pa.length; i++) { pos.push(pa[i]); nor.push(na[i]); }
    for (let i = 0; i < pa.length / 3; i++) col.push(cc.r, cc.g, cc.b);
    g.dispose(); p.g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return out;
}
function instanced(geo, mat, mats, o = {}) {
  if (!mats.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, mats.length);
  mats.forEach((m, i) => im.setMatrixAt(i, m));
  if (o.colors) o.colors.forEach((c, i) => im.setColorAt(i, c));
  im.castShadow = !!o.shadow; im.receiveShadow = o.receive !== false;
  im.frustumCulled = false;             // 인스턴스가 넓게 퍼져 있어 기본 컬링이 틀림
  world.add(im);
  return im;
}

// ---------- 식생 ----------
const VEG_MAT = () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92 });
const VEG = {
  pine: () => mergeGeos([
    { g: new THREE.CylinderGeometry(0.14, 0.24, 1.8, 6), m: M(0, 0.9, 0), c: 0x5a3d24 },
    { g: new THREE.ConeGeometry(1.75, 2.6, 8), m: M(0, 2.5, 0), c: 0x2c6431 },
    { g: new THREE.ConeGeometry(1.35, 2.2, 8), m: M(0, 3.7, 0, 0.4), c: 0x327236 },
    { g: new THREE.ConeGeometry(0.85, 1.8, 8), m: M(0, 4.85, 0, 0.8), c: 0x3a803e }]),
  leafy: () => mergeGeos([
    { g: new THREE.CylinderGeometry(0.18, 0.3, 2.4, 6), m: M(0, 1.2, 0), c: 0x5d4128 },
    { g: new THREE.IcosahedronGeometry(1.7, 1), m: M(0, 3.4, 0), c: 0x4f8d38 },
    { g: new THREE.IcosahedronGeometry(1.2, 1), m: M(0.95, 2.9, 0.3), c: 0x5c9c41 },
    { g: new THREE.IcosahedronGeometry(1.15, 1), m: M(-0.85, 3.0, -0.45), c: 0x447f31 }]),
  bush: () => mergeGeos([
    { g: new THREE.IcosahedronGeometry(0.9, 1), m: M(0, 0.45, 0, 0, 1, 0.75), c: 0x3f7a33 },
    { g: new THREE.IcosahedronGeometry(0.6, 1), m: M(0.65, 0.35, 0.2), c: 0x4c8a3b }]),
  rock: () => mergeGeos([{ g: new THREE.DodecahedronGeometry(1, 0), m: M(0, 0.35, 0, 0, 1, 0.7), c: 0x8d9094 }]),
};
// kinds: [{ geo, weight, scale:[a,b], clear, collide(x,z,s), shadow, tint }]
function scatter(o) {
  const rng = seeded(o.seed || 1), placed = o.kinds.map(() => ({ mats: [], colors: [] }));
  const totalW = o.kinds.reduce((s, k) => s + k.weight, 0);
  let n = 0;
  for (let tries = 0; tries < o.count * 8 && n < o.count; tries++) {
    const x = lerp(o.area[0], o.area[1], rng()), z = lerp(o.area[2], o.area[3], rng());
    let pick = rng() * totalW, ki = 0;
    while (pick > o.kinds[ki].weight) { pick -= o.kinds[ki].weight; ki++; }
    const k = o.kinds[ki], s = lerp(k.scale[0], k.scale[1], rng());
    if (o.avoid && o.avoid(x, z, (k.clear || 0) + s)) continue;
    const pm = placed[ki];
    pm.mats.push(M(x, 0, z, rng() * Math.PI * 2, s, s * lerp(0.85, 1.15, rng())));
    const v = lerp(0.82, 1.12, rng()), tint = k.tint || [1, 1, 1];
    pm.colors.push(new THREE.Color(v * tint[0], v * tint[1], v * tint[2]));
    colliderTag = k.tag || (k.collide === treeCollide.rock ? "rock" : "tree");
    if (k.collide) k.collide(x, z, s);
    colliderTag = "solid";
    n++;
  }
  const mat = VEG_MAT();
  o.kinds.forEach((k, i) => instanced(k.geo, mat, placed[i].mats, { colors: placed[i].colors, shadow: k.shadow !== false }));
}
const treeCollide = {
  pine: (x, z, s) => { cylCollider(x, z, 0.3 * s, 0, 1.8 * s); cylCollider(x, z, 1.15 * s, 1.4 * s, 5.6 * s); },
  leafy: (x, z, s) => { cylCollider(x, z, 0.35 * s, 0, 2.4 * s); cylCollider(x, z, 1.7 * s, 2.0 * s, 5.0 * s); },
  bush: (x, z, s) => cylCollider(x, z, 0.85 * s, 0, 0.9 * s),
  rock: (x, z, s) => cylCollider(x, z, 0.95 * s, 0, 0.8 * s),
};
function grassTufts(o) {
  const rng = seeded(o.seed || 5), mats = [], colors = [];
  for (let i = 0; i < o.count; i++) {
    const x = lerp(o.area[0], o.area[1], rng()), z = lerp(o.area[2], o.area[3], rng());
    if (o.avoid && o.avoid(x, z)) continue;
    const s = lerp(0.6, 1.3, rng());
    mats.push(M(x, 0, z, rng() * Math.PI, s, s * lerp(0.7, 1.2, rng())));
    const v = lerp(0.75, 1.1, rng()); colors.push(new THREE.Color(v, v, v * 0.9));
  }
  const g1 = new THREE.PlaneGeometry(0.7, 0.5); g1.translate(0, 0.25, 0);
  const g2 = g1.clone(); g2.rotateY(Math.PI / 2);
  const g3 = g1.clone(); g3.rotateY(Math.PI / 4);
  const geo = new THREE.BufferGeometry();
  const merged = [g1, g2, g3].map(g => g.toNonIndexed());
  for (const name of ["position", "normal", "uv"]) {
    const arrs = merged.map(g => g.attributes[name].array), len = arrs.reduce((s, a) => s + a.length, 0), out = new Float32Array(len);
    let off = 0; for (const a of arrs) { out.set(a, off); off += a.length; }
    geo.setAttribute(name, new THREE.BufferAttribute(out, name === "uv" ? 2 : 3));
  }
  // 풀잎은 위를 향한 법선으로 → 부드럽게 빛 받음
  const nrm = geo.attributes.normal; for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
  // 양면 조명이면 뒷면이 검게 보여서, 빛 계산 없이 일정한 밝기로 그림
  const mat = new THREE.MeshBasicMaterial({ map: TEX.grassBlade(), alphaTest: 0.45, side: THREE.DoubleSide, color: C(o.color || 0xa8c880) });
  const im = instanced(geo, mat, mats, { colors });
  if (im) { im.receiveShadow = false; im.userData.grass = true; }
  return im;
}
function clouds(o) {
  const tex = TEX.cloud(), rng = seeded(o.seed || 9);
  for (let i = 0; i < o.count; i++) {
    const a = rng() * Math.PI * 2, r = lerp(300, 1300, rng());
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: C(o.color || 0xffffff), transparent: true,
      opacity: lerp(0.5, 0.95, rng()), depthWrite: false, fog: false }));
    s.position.set(Math.cos(a) * r, lerp(160, 320, rng()), Math.sin(a) * r);
    const w = lerp(180, 420, rng()); s.scale.set(w, w * 0.45, 1); world.add(s);
  }
}
// 플레이 구역은 평평하고, 바깥으로 갈수록 언덕 → 먼 산
function terrain(o) {
  const size = 2600, seg = 180;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg); geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, cols = [];
  const [x0, x1, z0, z1] = o.flat;
  const cLow = C(o.colors[0]), cMid = C(o.colors[1]), cHigh = C(o.colors[2]), tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const dx = Math.max(x0 - x, 0, x - x1), dz = Math.max(z0 - z, 0, z - z1), d = Math.hypot(dx, dz);
    const n = fbm(x / 160 + 3.1, z / 160 - 7.7);
    let h = smoothstep(8, 120, d) * (o.hill || 18) * (0.4 + n);
    h += smoothstep(250, 800, d) * (o.mountain || 170) * Math.pow(fbm(x / 420, z / 420, 5), 1.6) * 1.8;
    pos.setY(i, h);
    const t = clamp(h / ((o.mountain || 170) * 0.9), 0, 1);
    tmp.copy(cLow).lerp(cMid, smoothstep(0.02, 0.25, t)).lerp(cHigh, smoothstep(0.45, 0.9, t));
    const v = 0.9 + fbm(x / 30, z / 30, 2) * 0.2;
    cols.push(tmp.r * v, tmp.g * v, tmp.b * v);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: o.tex, vertexColors: true, roughness: 0.95 });
  const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; world.add(m);
  return m;
}
function textSprite(text, o = {}) {
  const fs = o.size || 64, pad = o.pad || 20;
  const cv = document.createElement("canvas"), g = cv.getContext("2d");
  const font = `${o.weight || 800} ${fs}px ${o.font || "'Rajdhani','Noto Sans KR',sans-serif"}`;
  g.font = font;
  cv.width = Math.ceil(g.measureText(text).width) + pad * 2; cv.height = fs + pad * 1.4;
  g.font = font;
  if (o.bg) {
    g.fillStyle = o.bg; const r = 10;
    g.beginPath(); g.moveTo(r, 0); g.lineTo(cv.width - r, 0); g.quadraticCurveTo(cv.width, 0, cv.width, r);
    g.lineTo(cv.width, cv.height - r); g.quadraticCurveTo(cv.width, cv.height, cv.width - r, cv.height);
    g.lineTo(r, cv.height); g.quadraticCurveTo(0, cv.height, 0, cv.height - r); g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0); g.fill();
    if (o.border) { g.strokeStyle = o.border; g.lineWidth = 4; g.stroke(); }
  }
  g.fillStyle = o.color || "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, cv.width / 2, cv.height / 2 + fs * 0.05);
  const t = new THREE.CanvasTexture(cv); t.encoding = THREE.sRGBEncoding; t.anisotropy = MAX_ANISO;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, toneMapped: false, depthWrite: false }));
  const s = (o.scale || 1) / fs; sp.scale.set(cv.width * s, cv.height * s, 1);
  return sp;
}
// 벽에 붙이는 평면 간판 (캔버스 텍스트)
function signPlane(text, w, h, o = {}) {
  const tex = ctex(512, Math.round(512 * h / w), (g, W, H) => {
    g.fillStyle = o.bg || "#111"; g.fillRect(0, 0, W, H);
    if (o.border) { g.strokeStyle = o.border; g.lineWidth = 10; g.strokeRect(8, 8, W - 16, H - 16); }
    g.fillStyle = o.color || "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
    let fs = H * 0.62; g.font = `900 ${fs}px 'Noto Sans KR','Rajdhani',sans-serif`;
    while (g.measureText(text).width > W * 0.88 && fs > 10) { fs -= 4; g.font = `900 ${fs}px 'Noto Sans KR','Rajdhani',sans-serif`; }
    if (o.glow) { g.shadowColor = o.color; g.shadowBlur = 24; }
    g.fillText(text, W / 2, H / 2 + fs * 0.04);
  });
  const mat = o.emissive ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }) : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  return m;
}

// ============================================================
//  LED 게이트 / 체크포인트
//  spec.t: gate(사각) · ring(원형) · arch(아치) · dive(수평, 위→아래) · tunnel(터널 입구)
// ============================================================
const GATE_T = 0.16;
const STATE_COL = { next: C(0x2dff8f), after: C(0xffc53a), passed: C(0x262c34) };
const STATE_OP = { next: 1, after: 0.6, idle: 0.32, passed: 0 };
function makeCheckpoint(spec, dirN, idx, total, env) {
  colliderTag = "metal";
  const cp = makeCheckpointInner(spec, dirN, idx, total, env);
  colliderTag = "solid";
  return cp;
}
function makeCheckpointInner(spec, dirN, idx, total, env) {
  const s = spec.s || 3, isFinish = idx === total - 1 && !env.pad;
  const carbon = env.carbon, led = basic(0xffffff), halo = new THREE.MeshBasicMaterial({
    color: C(0xffffff), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const grp = new THREE.Group(); world.add(grp);
  const p = V3(...spec.p);
  const yaw = Math.atan2(dirN.x, dirN.z);
  const base = spec.base || 0;                     // 받침대가 닿는 높이 (언덕·옥상)
  const cp = { spec, type: spec.t, led, halo, state: "", grp, isFinish };
  const legMat = env.legMat || carbon;

  const ledFrame = (parent, w, h, z) => {
    const e = 0.05;
    for (const [x, y, ww, hh] of [[0, h / 2 + e / 2, w, e], [0, -h / 2 - e / 2, w, e], [w / 2 + e / 2, 0, e, h], [-w / 2 - e / 2, 0, e, h]])
      box(x, y, z, ww, hh, 0.012, led, { parent, collide: false, shadow: false });
  };
  const squareFrame = (parent, w, h) => {
    const T = GATE_T, hx = w / 2 + T / 2, hy = h / 2 + T / 2;
    for (const [x, y, ww, hh] of [[0, hy, w + 2 * T, T], [0, -hy, w + 2 * T, T], [hx, 0, T, h], [-hx, 0, T, h]])
      box(x, y, 0, ww, hh, T, carbon, { parent });
    ledFrame(parent, w, h, -T / 2 - 0.007); ledFrame(parent, w, h, T / 2 + 0.007);
    const hp = new THREE.Mesh(new THREE.PlaneGeometry((w + 2 * T) / 0.66, (h + 2 * T) / 0.66), halo);
    halo.map = glowTex().square; parent.add(hp);
  };
  const legs = (xs, topLocalY, wx) => {      // 사각 게이트 받침 다리 (월드 좌표 수직)
    for (const lx of xs) {
      const wp = V3(lx, topLocalY, 0); grp.localToWorld(wp);
      const hgt = wp.y - base;
      if (hgt < 0.12) continue;
      cyl(wp.x, base + hgt / 2, wp.z, 0.05, 0.06, hgt, legMat, { seg: 8 });
      box(wp.x, base + 0.03, wp.z, 0.5, 0.06, 0.7, legMat, { collide: false, yaw });
    }
  };
  const badgeText = isFinish ? "FINISH" : String(idx + 1);
  const badge = textSprite(badgeText, { size: 72, scale: isFinish ? 0.75 : 0.85, bg: isFinish ? "rgba(220,20,60,0.85)" : "rgba(8,12,20,0.78)",
    border: isFinish ? "#fff" : "rgba(255,255,255,0.35)" });

  if (spec.t === "arch") grp.position.set(p.x, base, p.z); else grp.position.copy(p);
  if (spec.t === "dive") grp.rotation.set(Math.PI / 2, yaw, 0, "YXZ");   // 틀이 수평, 법선이 아래(-Y)
  else grp.rotation.y = yaw;
  grp.updateMatrixWorld(true);

  if (spec.t === "gate" || spec.t === "tunnel") {
    squareFrame(grp, s, s);
    legs([-(s / 2 + GATE_T / 2), s / 2 + GATE_T / 2], -s / 2 - GATE_T);
    badge.position.set(0, s / 2 + GATE_T + 0.6, 0); grp.add(badge);
    cp.shape = "rect"; cp.hw = s / 2; cp.hh = s / 2; cp.center = p.clone();
    if (spec.t === "tunnel") buildTunnel(grp, spec, s, env);
  } else if (spec.t === "ring") {
    const R = s / 2;
    const torus = new THREE.Mesh(new THREE.TorusGeometry(R + 0.1, 0.12, 10, 56), carbon); torus.castShadow = true; grp.add(torus);
    for (const z of [-0.12, 0.12]) { const l = new THREE.Mesh(new THREE.TorusGeometry(R + 0.02, 0.03, 6, 56), led); l.position.z = z; grp.add(l); }
    const hp = new THREE.Mesh(new THREE.PlaneGeometry((2 * R + 0.4) / 0.66, (2 * R + 0.4) / 0.66), halo); halo.map = glowTex().circle; grp.add(hp);
    for (let k = 0; k < 18; k++) {        // 원형 틀 충돌: 작은 박스 18개
      const a = k / 18 * Math.PI * 2, o = new THREE.Object3D();
      o.position.set(Math.cos(a) * (R + 0.1), Math.sin(a) * (R + 0.1), 0); o.rotation.z = a; grp.add(o);
      boxColliderFromObject(o, 0.13, (Math.PI * (R + 0.1)) / 18 + 0.02, 0.13);
    }
    const bot = p.y - R - 0.22;
    if (bot - base > 0.15) { cyl(p.x, base + (bot - base) / 2, p.z, 0.07, 0.09, bot - base, legMat, { seg: 8 }); box(p.x, base + 0.03, p.z, 0.9, 0.06, 0.9, legMat, { collide: false, yaw }); }
    badge.position.set(0, R + 0.75, 0); grp.add(badge);
    cp.shape = "circle"; cp.R = R; cp.center = p.clone();
  } else if (spec.t === "arch") {
    const R = s / 2;
    const torus = new THREE.Mesh(new THREE.TorusGeometry(R + 0.12, 0.16, 10, 40, Math.PI), carbon); torus.castShadow = true; grp.add(torus);
    for (const z of [-0.16, 0.16]) { const l = new THREE.Mesh(new THREE.TorusGeometry(R + 0.0, 0.035, 6, 40, Math.PI), led); l.position.z = z; grp.add(l); }
    const hp = new THREE.Mesh(new THREE.PlaneGeometry((2 * R + 0.5) / 0.66, (2 * R + 0.5) / 0.66), halo); halo.map = glowTex().circle; grp.add(hp);
    for (let k = 0; k < 12; k++) {
      const a = (k + 0.5) / 12 * Math.PI, o = new THREE.Object3D();
      o.position.set(Math.cos(a) * (R + 0.12), Math.sin(a) * (R + 0.12), 0); o.rotation.z = a; grp.add(o);
      boxColliderFromObject(o, 0.17, (Math.PI * (R + 0.12)) / 24 + 0.03, 0.17);
    }
    for (const sx of [-1, 1]) box(sx * (R + 0.12), 0.05, 0, 0.7, 0.1, 0.7, legMat, { parent: grp, collide: false });
    badge.position.set(0, R + 0.9, 0); grp.add(badge);
    cp.shape = "arch"; cp.R = R; cp.center = V3(p.x, base + R * 0.5, p.z);
  } else if (spec.t === "dive") {
    squareFrame(grp, s, s);
    const h = s / 2 + GATE_T / 2;
    for (const [cx, cy] of [[-h, -h], [h, -h], [-h, h], [h, h]]) {
      const wp = V3(cx, cy, 0); grp.localToWorld(wp);
      const hgt = wp.y - GATE_T / 2 - base;
      if (hgt > 0.12) cyl(wp.x, base + hgt / 2, wp.z, 0.05, 0.06, hgt, legMat, { seg: 8 });
    }
    badge.position.set(0, 0, -1.4); grp.add(badge);          // 로컬 -Z = 위쪽
    const arrow = textSprite("▼", { size: 64, scale: 0.9, color: "#2dff8f" }); arrow.position.set(0, 0, -0.7); grp.add(arrow);
    cp.shape = "rect"; cp.hw = s / 2; cp.hh = s / 2; cp.center = p.clone();
  }
  grp.updateMatrixWorld(true);
  const r = V3(), u = V3(), n = V3();
  grp.matrixWorld.extractBasis(r, u, n); r.normalize(); u.normalize(); n.normalize();
  cp.o = V3().setFromMatrixPosition(grp.matrixWorld); cp.r = r; cp.u = u; cp.n = n;
  return cp;
}
function buildTunnel(grp, spec, s, env) {
  const len = spec.len || 12, st = (env.tunnelStyles && env.tunnelStyles[spec.style]) || {};
  const wall = st.wall || env.carbon, roof = st.roof || wall;
  const yb = -spec.p[1] + (spec.base || 0), yt = s / 2 + 0.35, hw = s / 2 + 0.35;
  const wh = yt - yb;
  for (const sx of [-1, 1]) box(sx * (hw + 0.15), yb + wh / 2, len / 2, 0.3, wh, len, wall, { parent: grp });
  box(0, yt + 0.15, len / 2, 2 * hw + 0.6, 0.3, len, roof, { parent: grp });
  const tl = basic(st.led || 0x6fe8ff);
  for (const sx of [-1, 1]) {
    box(sx * (hw - 0.05), yt - 0.06, len / 2, 0.06, 0.06, len, tl, { parent: grp, collide: false, shadow: false });
    box(sx * (hw - 0.05), yb + 0.04, len / 2, 0.06, 0.04, len, tl, { parent: grp, collide: false, shadow: false });
  }
  // 출구 틀 (장식)
  const T = GATE_T;
  for (const [x, y, w, h] of [[0, s / 2 + T / 2, s + 2 * T, T], [-(s / 2 + T / 2), 0, T, s], [s / 2 + T / 2, 0, T, s]])
    box(x, y, len, w, h, T, env.carbon, { parent: grp, collide: false });
  if (st.deco) st.deco(grp, s, len, yb, yt, hw);
}
function setCheckpointState(cp, st, idleCol) {
  if (cp.state === st) return;
  cp.state = st;
  const col = st === "idle" ? idleCol : STATE_COL[st];
  cp.led.color.copy(col); cp.halo.color.copy(col); cp.halo.opacity = Math.min(1, STATE_OP[st] * HALO_K);
}
function disposeWorld() {
  world.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(mt => {
      for (const k of ["map", "emissiveMap"]) if (mt[k]) mt[k].dispose();
      mt.dispose();
    });
  });
  while (world.children.length) world.remove(world.children[0]);
  colliders = []; cgrid.clear(); anim.length = 0; GLOW = null;
  for (const f of FX.list) { f.alive = false; f.sp.visible = false; }
}
