"use strict";
// ============================================================
//  맵: 환경(build) + 코스(track)
//  track 항목: { t: gate|ring|arch|dive|tunnel, p:[x, y, z], s: 크기(m), base: 받침 높이, len/style: 터널 }
// ============================================================
function pathDist(path, x, z) {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i], [bx, bz] = path[i + 1];
    const vx = bx - ax, vz = bz - az, L = vx * vx + vz * vz || 1;
    const t = clamp(((x - ax) * vx + (z - az) * vz) / L, 0, 1);
    best = Math.min(best, Math.hypot(x - (ax + vx * t), z - (az + vz * t)));
  }
  return best;
}
// 같은 모양을 많이 쓰는 소품은 인스턴싱으로 묶음
const batches = new Map();
function batch(key, geoFn, mat, m, shadow = true) {
  let b = batches.get(key);
  if (!b) batches.set(key, b = { geo: geoFn(), mat, mats: [], shadow });
  b.mats.push(m);
}
function flushBatches() { for (const b of batches.values()) instanced(b.geo, b.mat, b.mats, { shadow: b.shadow }); batches.clear(); }

// ---------- 공통 소품 ----------
function fenceLine(x0, z0, x1, z1, mat, h = 1.1) {
  const L = Math.hypot(x1 - x0, z1 - z0), yaw = Math.atan2(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / 2.5));
  for (let i = 0; i <= n; i++) { const t = i / n; batch("fpost" + h, () => new THREE.BoxGeometry(0.12, h, 0.12), mat, M(lerp(x0, x1, t), h / 2, lerp(z0, z1, t), yaw)); }
  for (const y of [h * 0.45, h * 0.9]) box((x0 + x1) / 2, y, (z0 + z1) / 2, 0.06, 0.09, L, mat, { collide: false, yaw });
  solidBox((x0 + x1) / 2, h / 2, (z0 + z1) / 2, 0.2, h, L, yaw);
}
function trafficCone(x, z, mats) {
  batch("cone", () => { const g = new THREE.ConeGeometry(0.22, 0.6, 14); g.translate(0, 0.3, 0); return g; }, mats.cone, M(x, 0, z));
  batch("coneBase", () => new THREE.BoxGeometry(0.42, 0.04, 0.42), mats.dark, M(x, 0.02, z));
}
function flagPole(x, z, color, h = 5) {
  cyl(x, h / 2, z, 0.05, 0.06, h, std(0xdddddd, { metalness: 0.6, roughness: 0.4 }), { seg: 8 });
  const shape = new THREE.Shape(); shape.moveTo(0, 0); shape.lineTo(0, -2.4); shape.quadraticCurveTo(0.5, -1.2, 0.9, -0.1); shape.lineTo(0, 0);
  const g = new THREE.ShapeGeometry(shape);
  const m = new THREE.Mesh(g, std(color, { side: THREE.DoubleSide, roughness: 0.6 }));
  m.position.set(x + 0.06, h - 0.1, z); m.rotation.y = Math.random() * Math.PI; m.castShadow = true; world.add(m);
  const ph = Math.random() * 6;
  anim.push(t => { m.rotation.y += Math.sin(t * 1.7 + ph) * 0.004; m.scale.x = 1 + Math.sin(t * 3 + ph) * 0.06; });
}
function tent(x, z, yaw, color) {
  const top = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.4, 4, 1, true), std(color, { side: THREE.DoubleSide }));
  top.position.set(x, 3.0, z); top.rotation.y = yaw + Math.PI / 4; top.castShadow = true; world.add(top);
  const wm = std(0xf2f2f2, { metalness: 0.5, roughness: 0.4 });
  for (const [a, b] of [[-1.8, -1.8], [1.8, -1.8], [-1.8, 1.8], [1.8, 1.8]]) {
    const cx = x + a * Math.cos(yaw) + b * Math.sin(yaw), cz = z - a * Math.sin(yaw) + b * Math.cos(yaw);
    cyl(cx, 1.15, cz, 0.04, 0.04, 2.3, wm, { seg: 6 });
  }
  solidBox(x, 2.9, z, 3.8, 1.4, 3.8, yaw);
  box(x, 0.4, z - 0.6, 1.8, 0.8, 0.7, std(0xffffff), { yaw, collide: true });
}
// 관람석: yaw 방향으로 계단이 올라감
function bleacher(x, z, yaw, len, mat, seatMat) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  for (let i = 0; i < 5; i++) {
    const h = 0.5 * (i + 1);
    box(x + fx * i * 0.8, h / 2, z + fz * i * 0.8, len, h, 0.8, i % 2 ? mat : seatMat, { yaw: yaw, collide: false, geo: new THREE.BoxGeometry(len, h, 0.8) });
  }
  solidBox(x + fx * 1.6, 1.25, z + fz * 1.6, len, 2.5, 4, yaw);
}
function lake(x, z, r, waterCol, shoreCol) {
  const shore = new THREE.Mesh(new THREE.CircleGeometry(r + 3, 48), std(shoreCol, { roughness: 1 }));
  shore.rotation.x = -Math.PI / 2; shore.position.set(x, 0.02, z); shore.receiveShadow = true; world.add(shore);
  const w = new THREE.Mesh(new THREE.CircleGeometry(r, 48), std(waterCol, { roughness: 0.06, metalness: 0.4 }));
  w.rotation.x = -Math.PI / 2; w.position.set(x, 0.04, z); w.receiveShadow = true; world.add(w);
}
function windmill(x, z, s = 1) {
  const white = std(0xf1ede4), dark = std(0x3b3f46, { metalness: 0.4, roughness: 0.5 });
  cyl(x, 9 * s, z, 1.4 * s, 2.6 * s, 18 * s, white, { seg: 16 });
  const cap = new THREE.Mesh(new THREE.ConeGeometry(1.9 * s, 2.4 * s, 16), dark); cap.position.set(x, 19.2 * s, z); world.add(cap);
  const hub = new THREE.Group(); hub.position.set(x, 17.4 * s, z + 2.2 * s); world.add(hub);
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.3 * s, 9 * s, 0.12 * s), white); b.position.y = 4.6 * s;
    const arm = new THREE.Group(); arm.rotation.z = i * Math.PI / 2; arm.add(b); hub.add(arm); b.castShadow = true;
  }
  anim.push((t, dt) => { hub.rotation.z -= dt * 0.6; });
}
function hayBale(x, z, yaw, mat) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 1.4, 16), mat);
  m.rotation.set(0, yaw, Math.PI / 2, "YXZ"); m.position.set(x, 0.75, z); m.castShadow = m.receiveShadow = true; world.add(m);
  solidBox(x, 0.75, z, 1.4, 1.5, 1.5, yaw + Math.PI / 2);
}

// ============================================================
//  1. 교육용 맵 — 드론 연습장 (연습 6종)
// ============================================================
const EDU_DRILLS = [
  // {PITCH} {THR} {YAW} {ROLL}: 선택한 스틱 모드에 맞는 "왼쪽/오른쪽 스틱"으로 바뀜
  { key: "straight", name: "직진", icon: "⬆", desc: "{PITCH}을 위로 밀어 앞으로",
    track: [[0, 2, -12], [0, 2, -26], [0, 2, -40], [0, 2, -54]].map(p => ({ t: "gate", p, s: 3.4 })),
    tips: ["{PITCH} ↑ = 앞으로", "스틱을 살짝만!", "속도를 일정하게", "마지막 게이트!"] },
  { key: "updown", name: "상승·하강", icon: "↕", desc: "{THR} 위아래로 높이 조절",
    track: [[0, 1.8, -12], [0, 4.5, -26], [0, 1.8, -40], [0, 5.5, -54], [0, 2.2, -68]].map(p => ({ t: "gate", p, s: 3.2 })),
    tips: ["낮은 게이트", "{THR} ↑ = 상승", "{THR} ↓ = 하강", "더 높이!", "천천히 내려와요"] },
  { key: "right", name: "우회전", icon: "↱", desc: "{YAW}을 오른쪽으로 돌며 비행",
    track: [[0, 2, -14], [7, 2, -27], [19, 2, -33], [31, 2, -29], [38, 2, -17]].map(p => ({ t: "gate", p, s: 3.4 })),
    tips: ["곧게 출발", "{YAW} → = 오른쪽으로 회전", "회전하며 앞으로", "조금 더 오른쪽", "완성!"] },
  { key: "left", name: "좌회전", icon: "↰", desc: "{YAW}을 왼쪽으로 돌며 비행",
    track: [[0, 2, -14], [-7, 2, -27], [-19, 2, -33], [-31, 2, -29], [-38, 2, -17]].map(p => ({ t: "gate", p, s: 3.4 })),
    tips: ["곧게 출발", "{YAW} ← = 왼쪽으로 회전", "회전하며 앞으로", "조금 더 왼쪽", "완성!"] },
  { key: "slalom", name: "S자 슬라럼", icon: "〰", desc: "좌우로 번갈아 방향 바꾸기",
    track: [[0, 2, -12], [-6, 2, -25], [6, 2, -38], [-6, 2, -51], [6, 2, -64], [0, 2, -77]].map(p => ({ t: "gate", p, s: 3.2 })),
    tips: ["출발!", "왼쪽으로", "오른쪽으로", "다시 왼쪽", "다시 오른쪽", "가운데로 마무리"] },
  { key: "landing", name: "정밀 착륙", icon: "H", desc: "게이트 통과 후 H 위에 착륙",
    track: [[0, 2, -12], [0, 2, -24]].map(p => ({ t: "gate", p, s: 3.4 })), pad: [0, -34, 1.4],
    tips: ["앞으로", "속도를 줄여요 → H에 착륙"] },
];
const MAP_EDU = {
  id: "edu", start: [0, 0], bounds: [-50, 50, -92, 22, 25],
  theme: { skyTop: 0x2a74d8, skyMid: 0xd4e9ff, skyBottom: 0x9bb47e, fog: 0xd4e9ff, fogNear: 160, fogFar: 1300,
    sunDir: [0.45, 0.85, 0.35], sunColor: 0xfff4e0, sunInt: 1.7, hemiSky: 0xcfe4ff, hemiGround: 0x5d7a3d, hemiInt: 0.75, exposure: 1.0,
    idle: 0x3d9bff, dust: [0x9c8f6a, 0xb8a57a, 0x7d9a5a] },
  drills: EDU_DRILLS,
  build(ctx) {
    const [x0, x1, z0, z1] = this.bounds;
    terrain({ flat: [x0 - 20, x1 + 20, z0 - 20, z1 + 20], tex: TEX.grass(620), colors: [0xffffff, 0xd6e4a6, 0x9aa3a6], hill: 22, mountain: 160 });
    // 연습장 잔디 + 흰 라인
    const turf = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), std(0xffffff, { map: TEX.turf([10, 11]), roughness: 0.95 }));
    turf.rotation.x = -Math.PI / 2; turf.position.set((x0 + x1) / 2, 0.01, (z0 + z1) / 2); turf.receiveShadow = true; world.add(turf);
    const line = basic(0xffffff, { toneMapped: true });
    const strip = (x, z, w, d) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), line); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.02, z); world.add(m); };
    strip((x0 + x1) / 2, z0 + 1, x1 - x0 - 2, 0.25); strip((x0 + x1) / 2, z1 - 1, x1 - x0 - 2, 0.25);
    strip(x0 + 1, (z0 + z1) / 2, 0.25, z1 - z0 - 2); strip(x1 - 1, (z0 + z1) / 2, 0.25, z1 - z0 - 2);
    strip(0, 8, 14, 0.25);
    // 울타리 + 깃발
    const fenceMat = std(0xf5f5f5, { roughness: 0.6 });
    fenceLine(x0, z0, x1, z0, fenceMat); fenceLine(x0, z1, x1, z1, fenceMat);
    fenceLine(x0, z0, x0, z1, fenceMat); fenceLine(x1, z0, x1, z1, fenceMat);
    const flagCols = [0xff4d6d, 0xffc43d, 0x3dd6ff, 0x7cff6b];
    [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [x0, -35], [x1, -35]].forEach(([x, z], i) => flagPole(x, z, flagCols[i % 4], 6));
    // 텐트 · 관람석 · 간판
    tent(22, 14, 0, 0x2f80ff); tent(30, 14, 0, 0xff4d6d); tent(-22, 14, 0, 0xffb02e); tent(-30, 14, 0, 0x2fd27a);
    bleacher(-60, -30, Math.PI / 2, 40, std(0x8a95a5), std(0x2f6fe0));
    bleacher(60, -30, -Math.PI / 2, 40, std(0x8a95a5), std(0xe03f5f));
    const sign = signPlane("드론 연습장 · DRONE ACADEMY", 26, 4.4, { bg: "#0d2a52", color: "#ffffff", border: "#3dd6ff" });
    sign.position.set(0, 6.2, z0 - 12); world.add(sign);
    for (const sx of [-11, 11]) cyl(sx, 2.2, z0 - 12.2, 0.18, 0.18, 4.4, std(0x9aa3ad, { metalness: 0.6 }));
    // 연습 경로 안내 점선 + 게이트 옆 콘
    const dots = new THREE.MeshBasicMaterial({ color: C(0xffffff), transparent: true, opacity: 0.85 });
    const path = ctx.path;
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1], L = Math.hypot(bx - ax, bz - az);
      for (let s = 1.6; s < L - 1; s += 2.2)
        batch("dot", () => { const g = new THREE.CircleGeometry(0.2, 10); g.rotateX(-Math.PI / 2); return g; }, dots,
          M(ax + (bx - ax) * s / L, 0.03, az + (bz - az) * s / L), false);
    }
    const mats = { cone: std(0xff6a1a, { roughness: 0.5 }), dark: std(0x222222) };
    ctx.track.forEach(t => { const cp = t.p; trafficCone(cp[0] - 2.6, cp[2] + 1.5, mats); trafficCone(cp[0] + 2.6, cp[2] + 1.5, mats); });
    // 주변 숲 · 풀숲 · 구름
    scatter({ seed: 11, count: 700, area: [-320, 320, -360, 260], avoid: (x, z, r) => x > x0 - 14 - r && x < x1 + 14 + r && z > z0 - 22 - r && z < z1 + 14 + r,
      kinds: [{ geo: VEG.pine(), weight: 3, scale: [1.0, 2.0], collide: treeCollide.pine }, { geo: VEG.leafy(), weight: 2, scale: [0.9, 1.6], collide: treeCollide.leafy },
              { geo: VEG.bush(), weight: 2, scale: [0.8, 1.6], collide: treeCollide.bush }] });
    if (ctx.quality > 0) grassTufts({ seed: 3, count: 5000, area: [-120, 120, -160, 100], avoid: (x, z) => x > x0 - 1 && x < x1 + 1 && z > z0 - 1 && z < z1 + 1 });
    clouds({ count: 28, seed: 4 });
    flushBatches();
  },
};

// ============================================================
//  2. 그린 필드 — 노을 지는 시골 코스
// ============================================================
const MAP_FIELD = {
  id: "field", start: [0, 0], bounds: [-72, 104, -112, 50, 42],
  theme: { skyTop: 0x2c5aa0, skyMid: 0xffc896, skyBottom: 0x7c6a4a, fog: 0xf1c69e, fogNear: 110, fogFar: 1150,
    sunDir: [-0.62, 0.2, -0.6], sunColor: 0xffc27e, sunInt: 1.9, sunGlow: 0xffa760, sunSize: 1.4,
    hemiSky: 0xb9cdf5, hemiGround: 0x5e4a2c, hemiInt: 0.7, exposure: 1.05, idle: 0xff3d8b, dust: [0xb59a6a, 0x8c7a55, 0x7a8a4a] },
  track: [
    { t: "gate", p: [0, 2.2, -20], s: 3 },
    { t: "gate", p: [6, 2.6, -42], s: 3 },
    { t: "ring", p: [14, 4, -66], s: 3.2 },
    { t: "tunnel", p: [28, 1.9, -76], s: 3.2, len: 12, style: "barn" },
    { t: "gate", p: [58, 3, -72], s: 3 },
    { t: "arch", p: [74, 0, -48], s: 7 },
    { t: "gate", p: [76, 2.4, -24], s: 3 },
    { t: "gate", p: [64, 8.4, 2], s: 3, base: 6 },          // 언덕 위
    { t: "dive", p: [50, 5, 10], s: 3.6 },                  // 위에서 아래로
    { t: "gate", p: [34, 2, 14], s: 3 },                    // 다리 아래
    { t: "ring", p: [14, 3, 18], s: 3.2 },
    { t: "gate", p: [-6, 2.5, 10], s: 3 },
    { t: "gate", p: [-22, 4, -6], s: 3 },
    { t: "gate", p: [-30, 2.2, -28], s: 3 },
    { t: "arch", p: [-24, 0, -50], s: 7 },
    { t: "gate", p: [-8, 2.4, -34], s: 3 },
  ],
  tunnelStyles: () => ({
    barn: { wall: std(0xffffff, { map: TEX.planks("#9b2f22") }), roof: std(0x4a3a30), led: 0xffd28a,
      deco(grp, s, len, yb, yt, hw) {
        const roofMat = std(0x55463c, { roughness: 0.8 });
        for (const sx of [-1, 1]) {
          const r = new THREE.Mesh(new THREE.BoxGeometry(hw * 1.55, 0.18, len + 1.2), roofMat);
          r.position.set(sx * hw * 0.62, yt + 0.32 + hw * 0.42, len / 2); r.rotation.z = -sx * 0.62; r.castShadow = true; grp.add(r);
        }
        const trim = std(0xf4efe6);
        for (const z of [-0.02, len + 0.02]) for (const sx of [-1, 1]) box(sx * (hw + 0.15), (yb + yt) / 2, z, 0.34, yt - yb, 0.1, trim, { parent: grp, collide: false });
      } },
  }),
  build(ctx) {
    const [x0, x1, z0, z1] = this.bounds, path = ctx.path;
    terrain({ flat: [x0 - 15, x1 + 15, z0 - 15, z1 + 15], tex: TEX.grass(620), colors: [0xffffff, 0xd9d39a, 0x8f8a86], hill: 26, mountain: 190 });
    // 언덕 (게이트 8)
    const hill = new THREE.Mesh(new THREE.SphereGeometry(20, 56, 28), std(0xffffff, { map: TEX.grass(8), roughness: 0.95 }));
    hill.position.set(64, -14, 2); hill.receiveShadow = true; hill.castShadow = true; world.add(hill);
    sphereCollider(64, -14, 2, 20);
    // 개울 + 나무 다리 (게이트 10)
    const water = std(0x3c6f8c, { roughness: 0.05, metalness: 0.45 }), sand = std(0xcdb88d, { roughness: 1 });
    for (const [w, y, m] of [[12, 0.02, sand], [7, 0.035, water]]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(w, 120), m); pl.rotation.x = -Math.PI / 2; pl.position.set(34, y, 12); pl.receiveShadow = true; world.add(pl);
    }
    const wood = std(0xffffff, { map: TEX.planks("#7a5434") });
    box(34, 5.1, 14, 4.6, 0.4, 24, wood);
    for (const sx of [-2.2, 2.2]) {
      box(34 + sx, 5.8, 14, 0.1, 0.1, 24, wood, { collide: false });
      for (let z = 2.5; z <= 25.5; z += 2.3) box(34 + sx, 5.55, z, 0.1, 0.9, 0.1, wood, { collide: false });
      solidBox(34 + sx, 5.6, 14, 0.2, 1, 24);
    }
    for (const z of [2.4, 25.6]) for (const sx of [-1.8, 1.8]) box(34 + sx, 2.45, z, 0.5, 4.9, 0.5, wood);
    // 풍차 · 호수 · 건초 · 울타리 · 깃발
    windmill(130, -150, 1.4); windmill(-140, -60, 1.1);
    lake(-58, -82, 20, 0x3c6f8c, 0xbfae84);
    const hay = std(0xd9b45a, { roughness: 1 }), rng = seeded(31);
    for (let i = 0, n = 0; i < 400 && n < 30; i++) {
      const x = lerp(x0 + 4, x1 - 4, rng()), z = lerp(z0 + 4, z1 - 4, rng());
      if (pathDist(path, x, z) < 6 || Math.abs(x - 34) < 8 || Math.hypot(x - 64, z - 2) < 18 || Math.hypot(x + 58, z + 82) < 26) continue;
      hayBale(x, z, rng() * 3, hay); n++;
    }
    const fenceMat = std(0xffffff, { map: TEX.planks("#8a6a48") });
    fenceLine(-66, 36, 20, 36, fenceMat); fenceLine(48, 40, 98, 40, fenceMat); fenceLine(96, -100, 96, -10, fenceMat);
    const fc = [0xff3d8b, 0xffd23f, 0x2de2ff, 0xffffff];
    ctx.track.forEach((t, i) => {
      if (t.t === "dive" || t.base) return;
      const g = ctx.cps[i]; const side = i % 2 ? 1 : -1, off = (t.s || 3) / 2 + 2.6;
      const x = g.o.x + g.r.x * off * side, z = g.o.z + g.r.z * off * side;
      if (pathDist(path, x, z) > 2) flagPole(x, z, fc[i % fc.length], 5.5);
    });
    // 숲
    const avoid = (x, z, r) => pathDist(path, x, z) < 6.5 + r || Math.abs(x - 34) < 7 + r && z > -45 && z < 75 ||
      Math.hypot(x - 64, z - 2) < 21 + r || Math.hypot(x + 58, z + 82) < 25 + r || Math.hypot(x, z) < 8;
    scatter({ seed: 21, count: 1100, area: [-330, 360, -420, 300], avoid, kinds: [
      { geo: VEG.pine(), weight: 3, scale: [1.0, 2.1], collide: treeCollide.pine },
      { geo: VEG.leafy(), weight: 3, scale: [0.9, 1.8], collide: treeCollide.leafy, tint: [1.08, 1.0, 0.85] },
      { geo: VEG.bush(), weight: 3, scale: [0.8, 1.7], collide: treeCollide.bush },
      { geo: VEG.rock(), weight: 0.8, scale: [0.6, 1.8], collide: treeCollide.rock }] });
    if (ctx.quality > 0) grassTufts({ seed: 7, count: 9000, area: [x0 - 30, x1 + 30, z0 - 30, z1 + 30], color: 0xe0d8a0,
      avoid: (x, z) => Math.abs(x - 34) < 6 || Math.hypot(x + 58, z + 82) < 23 || Math.hypot(x, z) < 3 });
    clouds({ count: 30, seed: 6, color: 0xffd9bf });
    flushBatches();
  },
};

// ============================================================
//  3. 물류 창고 — 실내 다층 코스
// ============================================================
const WH = { x0: -42, x1: 42, z0: -104, z1: 12, H: 16 };
const MAP_WAREHOUSE = {
  // 경계는 벽 바깥 → 실제 벽·천장 충돌체에 먼저 부딪힘
  id: "warehouse", start: [0, 0], bounds: [WH.x0 - 0.3, WH.x1 + 0.3, WH.z0 - 0.3, WH.z1 + 0.3, WH.H + 0.3],
  theme: { indoor: true, skyTop: 0x111111, skyMid: 0x111111, fog: 0x1b1f25, fogNear: 45, fogFar: 175,
    skyTop: 0x9a948a, skyMid: 0x6a6660, skyBottom: 0x3a3a3c,              // 실내 반사광 색 (하늘은 안 보임)
    sunDir: [0.2, 1, 0.1], sunColor: 0xffffff, sunGlow: 0x000000, sunInt: 0, hemiSky: 0xfff0da, hemiGround: 0x30343b, hemiInt: 0.95, exposure: 1.15, idle: 0x00cfff,
    dust: [0x9a9da1, 0xc0c3c6] },
  track: [
    { t: "gate", p: [0, 2, -14], s: 2.6 },
    { t: "gate", p: [8, 5, -30], s: 2.6 },
    { t: "ring", p: [26, 3.5, -36], s: 2.8 },
    { t: "tunnel", p: [30, 2.2, -50], s: 2.8, len: 18, style: "container" },
    { t: "gate", p: [30, 4, -80], s: 2.6 },
    { t: "gate", p: [22, 10, -92], s: 2.6, base: 8.75 },      // 캣워크 위
    { t: "dive", p: [6, 7, -90], s: 3.0 },
    { t: "gate", p: [-10, 2, -86], s: 2.6 },                 // 컨베이어 아래
    { t: "ring", p: [-26, 4, -72], s: 2.8 },
    { t: "gate", p: [-32, 7.5, -54], s: 2.6 },
    { t: "gate", p: [-30, 2, -36], s: 2.6 },
    { t: "gate", p: [-18, 3, -24], s: 2.6 },
    { t: "ring", p: [-28, 5, -8], s: 2.8 },
    { t: "gate", p: [-14, 2, 4], s: 2.6 },
    { t: "gate", p: [-4, 2.6, -4], s: 2.6 },
  ],
  tunnelStyles: () => ({
    container: { wall: std(0xffffff, { map: TEX.corrugated("#2b5f9e"), roughness: 0.6, metalness: 0.3 }),
      roof: std(0xffffff, { map: TEX.corrugated("#24507f"), roughness: 0.6, metalness: 0.3 }), led: 0x8af2ff },
  }),
  build(ctx) {
    const { x0, x1, z0, z1, H } = WH, path = ctx.path, W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    // 바닥 · 벽 · 지붕
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), std(0xffffff, { map: TEX.concrete([7, 10]), roughness: 0.55, metalness: 0.05 }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0, cz); floor.receiveShadow = true; world.add(floor);
    const lowWall = std(0xffffff, { map: TEX.concrete([8, 1]) }), upWall = std(0xffffff, { map: TEX.corrugated("#5d6976"), metalness: 0.3, roughness: 0.6 });
    upWall.map.repeat.set(20, 3);
    const ns = { shadow: false };
    for (const [x, z, w, d] of [[cx, z0 - 0.5, W + 2, 1], [cx, z1 + 0.5, W + 2, 1], [x0 - 0.5, cz, 1, D + 2], [x1 + 0.5, cz, 1, D + 2]]) {
      box(x, 1.5, z, w, 3, d, lowWall, Object.assign({ collide: false }, ns));
      box(x, 3 + (H - 3) / 2, z, w, H - 3, d, upWall, Object.assign({ collide: false }, ns));
      solidBox(x, H / 2, z, w, H, d);
    }
    box(cx, H + 0.5, cz, W + 2, 1, D + 2, std(0x3a3f47, { roughness: 0.7 }), ns);
    const sky = basic(0xe3ecff, { toneMapped: true });
    for (let z = z0 + 10; z < z1 - 4; z += 16) { const p = new THREE.Mesh(new THREE.PlaneGeometry(W - 12, 2.4), sky); p.rotation.x = Math.PI / 2; p.position.set(cx, H - 0.02, z); world.add(p); }
    const truss = std(0x4a5563, { metalness: 0.6, roughness: 0.5 });
    for (let z = z0 + 6; z < z1; z += 12) box(cx, 14.6, z, W, 0.5, 0.35, truss);
    // 바닥 차선 · 구역 글자
    const yellow = basic(0xf2c400, { toneMapped: true });
    const lane = (x, z, w, d) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), yellow); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.015, z); world.add(m); };
    lane(x0 + 3, cz, 0.25, D - 6); lane(x1 - 3, cz, 0.25, D - 6); lane(cx, z0 + 3, W - 6, 0.25); lane(cx, z1 - 3, W - 6, 0.25);
    [["A", x0 + 0.05, -20, Math.PI / 2], ["B", x0 + 0.05, -70, Math.PI / 2], ["C", x1 - 0.05, -20, -Math.PI / 2], ["D", x1 - 0.05, -70, -Math.PI / 2]].forEach(([t, x, z, ry]) => {
      const s = signPlane("ZONE " + t, 9, 3.2, { bg: "#c99a00", color: "#16181c" }); s.position.set(x, 8, z); s.rotation.y = ry; world.add(s);
    });
    const door = std(0xffffff, { map: TEX.corrugated("#8d949c"), metalness: 0.4 });
    for (const x of [-24, 0, 24]) { const d = box(x, 3.5, z0 + 0.02, 8, 7, 0.1, door, { collide: false }); d.receiveShadow = true; }
    // 조명 (매달린 램프 + 일부 실제 광원)
    const shade = std(0x2b3038, { metalness: 0.6, roughness: 0.4 }), bulb = basic(0xfff1d0);
    for (let x = -30; x <= 30; x += 15) for (let z = -96; z <= 6; z += 14) {
      batch("shade", () => new THREE.CylinderGeometry(0.5, 1.0, 0.6, 16, 1, true), shade, M(x, 13.8, z), false);
      batch("bulb", () => { const g = new THREE.CircleGeometry(0.85, 16); g.rotateX(Math.PI / 2); return g; }, bulb, M(x, 13.5, z), false);
      batch("cable", () => new THREE.CylinderGeometry(0.02, 0.02, 2.2, 4), shade, M(x, 15.0, z), false);
      glowSprite(x, 13.3, z, 0xffe2b0, 5.5, 0.28);
      cylCollider(x, z, 1.0, 13.4, H);
    }
    for (const [x, z] of [[-20, -22], [20, -22], [-20, -72], [20, -72]]) { const l = new THREE.PointLight(C(0xffe7c4), 0.9, 75, 1.3); l.position.set(x, 12, z); world.add(l); }
    // 캣워크 (게이트 6)
    const steel = std(0x6b7785, { metalness: 0.7, roughness: 0.4 }), grate = std(0x3f4852, { metalness: 0.6, roughness: 0.5 });
    box(23, 8.6, -92, 30, 0.3, 4, grate);
    box(23, 9.3, -94, 30, 0.06, 0.06, steel, { collide: false }); box(23, 9.7, -94, 30, 0.06, 0.06, steel, { collide: false });
    solidBox(23, 9.2, -94, 30, 1.2, 0.2);
    for (let x = 9; x <= 37; x += 7) box(x, 4.2, -92, 0.3, 8.4, 0.3, steel);
    for (let i = 0; i < 12; i++) box(39.5, 0.36 + i * 0.7, -94 + i * 0.75, 2.2, 0.12, 0.8, grate, { collide: false });   // 계단
    // 컨베이어 (게이트 8 위)
    const belt = std(0x23272e, { roughness: 0.6 });
    box(-10, 4.6, -85, 1.6, 0.5, 30, belt); box(-10, 4.9, -85, 1.8, 0.1, 30, steel, { collide: false });
    for (const z of [-98, -93, -78, -73]) for (const sx of [-0.7, 0.7]) box(-10 + sx, 2.2, z, 0.15, 4.4, 0.15, steel);
    // 선반 랙 + 상자
    const upr = std(0x2a64b8, { metalness: 0.5, roughness: 0.5 }), beam = std(0xf08a1a, { metalness: 0.4, roughness: 0.5 });
    const carton = std(0xc4945a), carton2 = std(0xa77a44), wrap = std(0xdfe6ea, { roughness: 0.3, transparent: true, opacity: 0.9 });
    const rng = seeded(41);
    const free = (x, z, hw, hd, clr) => {
      for (const [a, b] of [[0, 0], [-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd], [0, -hd], [0, hd]]) if (pathDist(path, x + a, z + b) < clr) return false;
      return Math.hypot(x, z) > 6;
    };
    const rack = (x, z, len) => {
      const hw = 1.2, h = 8;
      for (const sx of [-hw, hw]) for (let k = 0; k <= len; k += len / 4)
        batch("upr", () => new THREE.BoxGeometry(0.12, h, 0.12), upr, M(x + sx, h / 2, z - len / 2 + k));
      for (const y of [0.15, 2.7, 5.3, 7.9]) for (const sx of [-hw, hw])
        box(x + sx, y, z, 0.1, 0.16, len, beam, { collide: false });
      for (const y of [0.25, 2.85, 5.45]) for (let k = 1; k < len; k += 2.4) {
        if (rng() < 0.15) continue;
        const s = 1.2 + rng() * 0.6;
        batch(rng() < 0.5 ? "c1" : "c2", () => new THREE.BoxGeometry(1, 1, 1), rng() < 0.5 ? carton : carton2,
          M(x + (rng() - 0.5) * 0.3, y + s * 0.5, z - len / 2 + k, rng() * 0.2, s, s * (0.8 + rng() * 0.5)));
      }
      solidBox(x, h / 2, z, 2 * hw + 0.2, h, len);
    };
    for (const x of [-37, -25, -13, -1, 11, 23, 35]) for (const z of [-94, -78, -62, -46, -30, -14]) {
      if (!free(x, z, 1.3, 6, 3.6)) continue;
      if (x > 6 && x < 40 && z < -86) continue;           // 캣워크
      if (Math.abs(x + 10) < 4 && z < -68) continue;       // 컨베이어
      rack(x, z, 12);
    }
    // 컨테이너 더미
    const cCols = ["#b33a2e", "#2b5f9e", "#2f8a52", "#d98b1f", "#6b4fa0"].map(c => std(0xffffff, { map: TEX.corrugated(c), metalness: 0.3, roughness: 0.6 }));
    for (let i = 0, n = 0; i < 300 && n < 16; i++) {
      const x = lerp(x0 + 4, x1 - 4, rng()), z = lerp(z0 + 6, z1 - 6, rng()), yaw = rng() < 0.5 ? 0 : Math.PI / 2;
      if (!free(x, z, 3.2, 3.2, 4.2) || colliders.some(k => Math.hypot(k.c.x - x, k.c.z - z) < k.br * 0.6 + 3.4)) continue;
      const stack = 1 + Math.floor(rng() * 2);
      for (let k = 0; k < stack; k++) box(x, 1.3 + k * 2.6, z, 2.44, 2.6, 6.06, cCols[(rng() * 5) | 0], { yaw });
      n++;
    }
    // 팔레트 · 지게차
    for (let i = 0, n = 0; i < 500 && n < 40; i++) {
      const x = lerp(x0 + 2, x1 - 2, rng()), z = lerp(z0 + 2, z1 - 2, rng());
      if (!free(x, z, 0.8, 0.8, 3) || colliders.some(k => Math.hypot(k.c.x - x, k.c.z - z) < k.br * 0.7 + 1.2)) continue;
      const hgt = 0.6 + rng() * 1.4;
      box(x, 0.08, z, 1.2, 0.16, 1.2, std(0x9a7a50), { collide: false });
      box(x, 0.16 + hgt / 2, z, 1.1, hgt, 1.1, rng() < 0.5 ? wrap : carton);
      n++;
    }
    const fk = std(0xf2b705, { metalness: 0.3, roughness: 0.5 }), fkDark = std(0x22252a);
    for (let i = 0, n = 0; i < 200 && n < 4; i++) {
      const x = lerp(x0 + 5, x1 - 5, rng()), z = lerp(z0 + 5, z1 - 5, rng()), yaw = rng() * 6;
      if (!free(x, z, 1.5, 1.5, 4) || colliders.some(k => Math.hypot(k.c.x - x, k.c.z - z) < k.br * 0.7 + 2)) continue;
      box(x, 0.9, z, 1.2, 1.2, 2.2, fk, { yaw }); box(x, 2.0, z, 1.1, 0.08, 1.4, fkDark, { yaw, collide: false });
      box(x + Math.sin(yaw) * 1.2, 1.6, z + Math.cos(yaw) * 1.2, 0.9, 3.2, 0.12, fkDark, { yaw });
      n++;
    }
    flushBatches();
  },
};

// ============================================================
//  4. 메트로 시티 — 야경 네온 도시
// ============================================================
const MAP_CITY = {
  id: "city", start: [0, 0], bounds: [-140, 150, -170, 80, 70],
  theme: { skyTop: 0x040817, skyMid: 0x2a2350, skyBottom: 0x0b0d18, fog: 0x161a35, fogNear: 70, fogFar: 760,
    sunDir: [0.35, 0.55, -0.6], sunColor: 0x9db0ff, sunInt: 0.6, sunGlow: 0x8090c8, sunSize: 0.35, stars: 1,
    hemiSky: 0x5a6ab0, hemiGround: 0x2a1c2a, hemiInt: 0.55, exposure: 1.15, halo: 1.8, idle: 0xd8f0ff, dust: [0x6a6f78, 0x8a8f98] },
  track: [
    { t: "gate", p: [0, 2.6, -18], s: 2.8 },
    { t: "gate", p: [0, 6, -40], s: 2.8 },
    { t: "gate", p: [4, 4.5, -56], s: 2.8 },                 // 고가도로 아래
    { t: "ring", p: [20, 8, -78], s: 3 },
    { t: "gate", p: [44, 14, -90], s: 2.8 },                 // 구름다리 아래
    { t: "gate", p: [68, 22, -80], s: 2.8, base: 19 },       // 옥상
    { t: "dive", p: [88, 15, -74], s: 3.4 },
    { t: "gate", p: [92, 4, -56], s: 2.8 },                  // 고가도로 아래 (두 번째)
    { t: "tunnel", p: [84, 2.8, -16], s: 3, len: 20, style: "city" },
    { t: "gate", p: [50, 6, -2], s: 2.8 },
    { t: "ring", p: [30, 10, 8], s: 3 },
    { t: "gate", p: [8, 4, 18], s: 2.8 },
    { t: "gate", p: [-16, 8, 8], s: 2.8 },
    { t: "gate", p: [-34, 3, -12], s: 2.8 },
    { t: "ring", p: [-30, 6, -34], s: 3 },
    { t: "gate", p: [-12, 2.8, -26], s: 2.8 },
  ],
  tunnelStyles: () => ({
    city: { wall: std(0xffffff, { map: TEX.concrete([4, 1]) }), roof: std(0x3a3f48), led: 0xff4fd8,
      deco(grp, s, len, yb, yt, hw) {          // 터널 위·양옆을 감싸는 빌딩 (건물 사이 통로)
        const f = CITY_FACADES[1], mats = [f, f, CITY_ROOF, CITY_ROOF, f, f], top = yt + 0.3 + 22;
        for (const sd of [-1, 1]) box(sd * (hw + 0.3 + 3), (yb + top) / 2, len / 2, 6, top - yb, len + 2, mats, { parent: grp, geo: boxGeoUV(6, top - yb, len + 2, 6) });
        box(0, yt + 0.3 + 11, len / 2, 2 * hw + 0.6, 22, len + 2, mats, { parent: grp, geo: boxGeoUV(2 * hw + 0.6, 22, len + 2, 6) });
      } },
  }),
  prepare() { makeCityMaterials(); },
  build(ctx) {
    const path = ctx.path, rng = seeded(53);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), std(0xffffff, { map: TEX.asphalt(260), roughness: 0.75, metalness: 0.1 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; world.add(ground);
    // 코스를 따라 도로 (차선 표시)
    const road = std(0xffffff, { map: TEX.asphalt(1), roughness: 0.6, metalness: 0.15, color: C(0x8a8f99) });
    const laneMat = new THREE.MeshBasicMaterial({ map: TEX.lane([1, 1]), transparent: true, color: C(0xd8d8d8) });
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1], L = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(bx - ax, bz - az);
      const r = new THREE.Mesh(new THREE.PlaneGeometry(11, L + 11), road);
      r.rotation.set(-Math.PI / 2, 0, 0); r.rotateOnWorldAxis(V3(0, 1, 0), yaw); r.position.set((ax + bx) / 2, 0.01 + i * 0.0005, (az + bz) / 2); r.receiveShadow = true; world.add(r);
      const lt = laneMat.clone(); lt.map = laneMat.map.clone(); lt.map.needsUpdate = true; lt.map.repeat.set(1, L / 6);
      const l = new THREE.Mesh(new THREE.PlaneGeometry(0.5, L), lt); l.rotation.set(-Math.PI / 2, 0, 0); l.rotateOnWorldAxis(V3(0, 1, 0), yaw);
      l.position.set((ax + bx) / 2, 0.03, (az + bz) / 2); world.add(l);
    }
    const blocks = [];   // 직접 배치한 건물 (무작위 건물과 겹치지 않게)
    const building = (x, z, w, d, h, fi, yaw = 0) => {
      const g = boxGeoUV(w, h, d, 6), f = CITY_FACADES[fi % CITY_FACADES.length];
      const m = box(x, h / 2, z, w, h, d, [f, f, CITY_ROOF, CITY_ROOF, f, f], { geo: g, yaw, shadow: false });   // 밤이라 그림자 생략 (가볍게)
      blocks.push({ x, z, r: Math.hypot(w, d) / 2 });
      // 옥상 소품
      if (h > 12) for (let k = 0; k < 3; k++)
        batch("ac", () => new THREE.BoxGeometry(1.6, 1, 1.6), CITY_ROOF, M(x + (rng() - 0.5) * (w - 3), h + 0.5, z + (rng() - 0.5) * (d - 3), yaw));
      if (h > 35 && rng() < 0.6) {
        cyl(x, h + 4, z, 0.08, 0.15, 8, CITY_ROOF, { collide: false, seg: 6 });
        const g2 = glowSprite(x, h + 8.2, z, 0xff2a2a, 3, 0.9), ph = rng() * 6;
        anim.push(t => { g2.material.opacity = Math.sin(t * 3 + ph) > 0.3 ? 0.95 : 0.1; });
      }
      return m;
    };
    // 구름다리 탑 (게이트 5, 12), 옥상 빌딩 (게이트 6)
    const besideGate = (i, off, w, d, h, fi) => { const g = ctx.cps[i]; for (const sd of [-1, 1]) building(g.o.x + g.r.x * off * sd, g.o.z + g.r.z * off * sd, w, d, h, fi, Math.atan2(g.n.x, g.n.z)); };
    besideGate(4, 10, 10, 12, 42, 2); besideGate(11, 9, 9, 10, 24, 3);
    const bridgeMat = std(0x9fb3c8, { metalness: 0.6, roughness: 0.25, emissive: C(0x203048) });
    for (const [i, y, off] of [[4, 21, 10], [11, 12.5, 9]]) {
      const g = ctx.cps[i];
      box(g.o.x, y, g.o.z, 2 * off - 8, 2.6, 3.2, bridgeMat, { yaw: Math.atan2(g.n.x, g.n.z) + Math.PI / 2 });
      for (const sd of [-1, 1]) box(g.o.x + g.n.x * 1.65 * sd, y - 0.6, g.o.z + g.n.z * 1.65 * sd, 2 * off - 8, 0.12, 0.05, basic(0x60e0ff), { yaw: Math.atan2(g.n.x, g.n.z) + Math.PI / 2, collide: false, shadow: false });
    }
    building(68, -80, 14, 14, 19, 4);
    const pad = signPlane("H", 6, 6, { bg: "#202a36", color: "#ffd23f", border: "#ffd23f" }); pad.rotation.x = -Math.PI / 2; pad.position.set(68, 19.02, -76); world.add(pad);
    // 고가도로 + 자동차
    const conc = std(0xffffff, { map: TEX.concrete([30, 1]) });
    box(5, 10, -56, 310, 1, 12, conc);
    for (const sz of [-6, 6]) box(5, 11, -56 + sz, 310, 1, 0.3, conc);
    for (let x = -140; x <= 150; x += 24) if (pathDist(path, x, -56) > 5) box(x, 4.75, -56, 2, 9.5, 3, conc);
    for (let x = -140; x <= 150; x += 20) glowSprite(x, 15, -56, 0xffc070, 4, 0.45);
    const carN = 34, carBody = new THREE.InstancedMesh(new THREE.BoxGeometry(4, 1.1, 1.8), std(0x22262e, { metalness: 0.6, roughness: 0.35 }), carN);
    const headL = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.25, 1.4), basic(0xfff3d8), carN);
    const tailL = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.25, 1.4), basic(0xff2a3a), carN);
    [carBody, headL, tailL].forEach(m => { m.frustumCulled = false; world.add(m); });
    const cars = Array.from({ length: carN }, (_, i) => ({ x: lerp(-150, 160, rng()), lane: i % 2 ? 1 : -1, v: lerp(14, 24, rng()) }));
    const tmp = new THREE.Object3D();
    anim.push((t, dt) => {
      cars.forEach((c, i) => {
        c.x += c.v * dt * c.lane; if (c.x > 160) c.x = -150; if (c.x < -150) c.x = 160;
        const z = -56 + c.lane * 2.8;
        tmp.position.set(c.x, 11.1, z); tmp.rotation.set(0, 0, 0); tmp.updateMatrix(); carBody.setMatrixAt(i, tmp.matrix);
        tmp.position.set(c.x + c.lane * 2.02, 11.0, z); tmp.updateMatrix(); headL.setMatrixAt(i, tmp.matrix);
        tmp.position.set(c.x - c.lane * 2.02, 11.0, z); tmp.updateMatrix(); tailL.setMatrixAt(i, tmp.matrix);
      });
      carBody.instanceMatrix.needsUpdate = headL.instanceMatrix.needsUpdate = tailL.instanceMatrix.needsUpdate = true;
    });
    // 무작위 빌딩 (코스와 거리 유지)
    const neonCols = ["#3ff3ff", "#ff4fd8", "#ffe14f", "#5bff8f", "#ff6a3d"], neonWords = ["DRONE", "FPV", "NEON", "PIXEL", "24H", "CAFE", "드론", "레이스", "GAME", "SKY", "HOTEL", "MART"];
    let signs = 0;
    for (let i = 0, n = 0; i < 2600 && n < 115; i++) {
      const x = lerp(-150, 170, rng()), z = lerp(-190, 100, rng());
      const w = lerp(8, 18, rng()), d = lerp(8, 18, rng()), h = lerp(10, 26, rng()) + Math.pow(rng(), 3) * 70;
      const rr = Math.hypot(w, d) / 2;
      if (pathDist(path, x, z) < rr + 5.5) continue;
      if (Math.abs(z + 56) < 6 + rr) continue;
      if (blocks.some(b => Math.hypot(b.x - x, b.z - z) < b.r + rr + 1.5)) continue;
      if (Math.hypot(x - 84, z + 16) < 30 + rr) continue;    // 터널 빌딩 자리
      building(x, z, w, d, h, n);
      n++;
      // 코스 쪽 벽에 네온 간판
      if (signs < 20 && pathDist(path, x, z) < rr + 18) {
        const faces = [[1, 0, w / 2], [-1, 0, w / 2], [0, 1, d / 2], [0, -1, d / 2]];
        let bestF = faces[0], bestD = Infinity;
        for (const f of faces) { const px = x + f[0] * (f[2] + 6), pz = z + f[1] * (f[2] + 6), dd = pathDist(path, px, pz); if (dd < bestD) { bestD = dd; bestF = f; } }
        const col = neonCols[(rng() * neonCols.length) | 0], word = neonWords[(rng() * neonWords.length) | 0];
        const sw = Math.min(8, (bestF[0] ? d : w) * 0.7), sh = sw * 0.35, sy = lerp(5, Math.min(h - 3, 14), rng());
        const s = signPlane(word, sw, sh, { bg: "#0a0a12", color: col, border: col, emissive: true, glow: true });
        s.material.color.setScalar(0.7);                 // 간판이 게이트보다 눈에 띄지 않게
        s.position.set(x + bestF[0] * (bestF[2] + 0.06), sy, z + bestF[1] * (bestF[2] + 0.06)); s.rotation.y = Math.atan2(bestF[0], bestF[1]); world.add(s);
        glowSprite(x + bestF[0] * (bestF[2] + 1.2), sy, z + bestF[1] * (bestF[2] + 1.2), parseInt(col.slice(1), 16), sw * 1.2, 0.16);
        signs++;
      }
    }
    // 가로등
    const poleMat = std(0x2a2e36, { metalness: 0.6, roughness: 0.4 });
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1], L = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / L, nz = (bx - ax) / L;
      for (let s = 6; s < L - 3; s += 16) {
        const side = (Math.floor(s / 16) + i) % 2 ? 1 : -1, x = ax + (bx - ax) * s / L + nx * 6.5 * side, z = az + (bz - az) * s / L + nz * 6.5 * side;
        if (pathDist(path, x, z) < 4) continue;
        batch("pole", () => new THREE.CylinderGeometry(0.08, 0.12, 6, 6), poleMat, M(x, 3, z)); cylCollider(x, z, 0.14, 0, 6);
        glowSprite(x - nx * 0.8 * side, 6.0, z - nz * 0.8 * side, 0xffd59a, 1.8, 0.7);
      }
    }
    // 먼 스카이라인
    const far = [];
    for (let i = 0; i < 260; i++) { const a = rng() * Math.PI * 2, r = lerp(300, 750, rng()), h = lerp(30, 170, rng()), w = lerp(18, 40, rng());
      far.push(M(Math.cos(a) * r, h / 2, Math.sin(a) * r, rng() * 3, 1).multiply(new THREE.Matrix4().makeScale(w, h, w))); }
    instanced(new THREE.BoxGeometry(1, 1, 1), std(0x0f1220, { emissive: C(0x131a33) }), far, { shadow: false });
    flushBatches();
  },
};
// 도시 건물 재질 (공유)
let CITY_FACADES = [], CITY_ROOF = null;
function makeCityMaterials() {
  CITY_FACADES = [["#3a4352", "#1a2233"], ["#4a4038", "#221c18"], ["#2f3a48", "#141b26"], ["#45474f", "#1c1e24"], ["#38404a", "#10161e"]].map(([b, w]) => {
    const t = TEX.facade(b, w, true);
    return std(0xffffff, { map: t.map, emissiveMap: t.emis, emissive: C(0xffffff), emissiveIntensity: 0.55, roughness: 0.55, metalness: 0.25 });
  });
  CITY_ROOF = std(0x262a33, { roughness: 0.8 });
}

const MAPS = [MAP_EDU, MAP_FIELD, MAP_WAREHOUSE, MAP_CITY];
