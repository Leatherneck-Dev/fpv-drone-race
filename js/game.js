"use strict";
// ============================================================
//  게임: 조종기 통신 · 입력 · 비행 물리 · 레이스 · HUD · 메뉴
// ============================================================
const $ = id => document.getElementById(id);
const CFG = window.SIM_CONFIG || {};
MAPS.forEach((m, i) => Object.assign(m, Records.MAP_INFO[i]));   // 이름 · 단계 · 순위 여부

// ---------- CoDrone EDU 조종기 시리얼 프로토콜 (Robolink codrone-edu 라이브러리와 동일) ----------
//  패킷: 0x0A 0x55 | dataType | length | from | to | data... | crc16(LE)
//  CRC16-XMODEM(poly 0x1021, init 0) 을 header 4바이트 + data 에 대해 계산
const DT = { Request: 0x04, Button: 0x70, Joystick: 0x71 };
const DEV = { Drone: 0x10, Controller: 0x20, Base: 0x70 };
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1);
    t[i] = c & 0xFFFF;
  }
  return t;
})();
function crc16(bytes, crc = 0) {
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ b) & 0xFF]) & 0xFFFF;
  return crc;
}
function makePacket(dataType, from, to, data) {
  const header = [dataType, data.length, from, to];
  const crc = crc16(data, crc16(header));
  return new Uint8Array([0x0A, 0x55, ...header, ...data, crc & 0xFF, crc >> 8]);
}
const ctrl = {
  port: null, reader: null, writer: null, connected: false,
  lx: 0, ly: 0, rx: 0, ry: 0, lastBtn: 0, lastJoy: 0, joyCount: 0, hz: 0,
  targets: [DEV.Drone, DEV.Controller], targetIdx: 0, lockedTarget: null, calib: [],
};
const parser = { st: 0, type: 0, len: 0, from: 0, to: 0, data: [], crc: 0 };
function feedByte(b) {
  const p = parser;
  switch (p.st) {
    case 0: if (b === 0x0A) p.st = 1; break;
    case 1: p.st = (b === 0x55) ? 2 : (b === 0x0A ? 1 : 0); break;
    case 2: p.type = b; p.st = 3; break;
    case 3: p.len = b; p.data = []; p.st = b > 128 ? 0 : 4; break;
    case 4: p.from = b; p.st = 5; break;
    case 5: p.to = b; p.st = p.len ? 6 : 7; break;
    case 6: p.data.push(b); if (p.data.length >= p.len) p.st = 7; break;
    case 7: p.crc = b; p.st = 8; break;
    case 8: {
      p.crc |= b << 8; p.st = 0;
      if (crc16(p.data, crc16([p.type, p.len, p.from, p.to])) === p.crc) onPacket(p.type, p.data);
      break;
    }
  }
}
const s8 = v => (v > 127 ? v - 256 : v);
function onPacket(type, d) {
  if (type === DT.Joystick && d.length >= 8) {
    ctrl.lx = s8(d[0]); ctrl.ly = s8(d[1]); ctrl.rx = s8(d[4]); ctrl.ry = s8(d[5]);
    ctrl.lastJoy = performance.now(); ctrl.joyCount++;
    if (ctrl.lockedTarget === null) ctrl.lockedTarget = ctrl.targets[ctrl.targetIdx];
    autoCalibrate();
  } else if (type === DT.Button && d.length >= 3) {
    const code = d[0] | (d[1] << 8);
    if (code !== 0 && ctrl.lastBtn === 0) onControllerButton();   // 눌리는 순간만
    ctrl.lastBtn = code;
  }
}
// 연결 직후 스틱 중앙값을 자동으로 맞춤 (스틱에 손대지 않은 상태라고 가정, 값이 크면 무시)
function autoCalibrate() {
  if (ctrl.calib === null) return;
  ctrl.calib.push([ctrl.lx, ctrl.ly, ctrl.rx, ctrl.ry]);
  if (ctrl.calib.length < 15) return;
  const avg = [0, 1, 2, 3].map(k => ctrl.calib.reduce((s, v) => s + v[k], 0) / ctrl.calib.length);
  const steady = ctrl.calib.every(v => v.every((x, k) => Math.abs(x - avg[k]) < 4));
  if (steady && avg.every(v => Math.abs(v) < 22)) { S.center = { lx: avg[0], ly: avg[1], rx: avg[2], ry: avg[3] }; saveSettings(); }
  ctrl.calib = null;
}
async function connectController() {
  if (!("serial" in navigator)) { setStatus("이 브라우저는 조종기 연결을 지원하지 않아요 (Chrome·Edge 사용)", "bad"); return; }
  if (ctrl.connected) { await disconnectController(); return; }
  try {
    let port;
    try { port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x0483 }] }); }
    catch (e) { if (e.name === "NotFoundError") port = await navigator.serial.requestPort(); else throw e; }
    await port.open({ baudRate: 57600 });
    Object.assign(ctrl, { port, connected: true, lockedTarget: null, joyCount: 0, calib: [] });
    ctrl.writer = port.writable.getWriter();
    setStatus("조종기 응답 대기 중…", "wait");
    readLoop(); pollLoop();
  } catch (e) { if (e.name !== "NotFoundError") setStatus("연결 실패: " + e.message, "bad"); }
}
async function readLoop() {
  while (ctrl.connected && ctrl.port && ctrl.port.readable) {
    ctrl.reader = ctrl.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await ctrl.reader.read();
        if (done) break;
        for (const b of value) feedByte(b);
      }
    } catch (e) { /* 케이블 분리 등 */ }
    finally { try { ctrl.reader.releaseLock(); } catch (e) {} }
    if (!ctrl.port || !ctrl.port.readable) break;
  }
  if (ctrl.connected) { ctrl.connected = false; setStatus("연결이 끊어졌어요. 다시 연결하세요.", "bad"); }
}
async function pollLoop() {
  // 라이브러리의 get_joystick_data() 와 같이 Joystick 데이터를 주기적으로 요청 (약 50Hz)
  let tick = 0;
  while (ctrl.connected && ctrl.writer) {
    let to = ctrl.lockedTarget;
    if (to === null) {
      if (tick % 10 === 0) ctrl.targetIdx = (ctrl.targetIdx + 1) % ctrl.targets.length;
      to = ctrl.targets[ctrl.targetIdx];
    }
    try {
      await ctrl.writer.write(makePacket(DT.Request, DEV.Base, to, [DT.Joystick]));
      if (tick % 5 === 0) await ctrl.writer.write(makePacket(DT.Request, DEV.Base, to, [DT.Button]));
    } catch (e) { break; }
    tick++;
    if (ctrl.lockedTarget !== null && performance.now() - ctrl.lastJoy > 500) ctrl.lockedTarget = null;
    await new Promise(r => setTimeout(r, 20));
  }
}
async function disconnectController() {
  ctrl.connected = false;
  try { if (ctrl.reader) await ctrl.reader.cancel(); } catch (e) {}
  try { if (ctrl.writer) ctrl.writer.releaseLock(); } catch (e) {}
  try { if (ctrl.port) await ctrl.port.close(); } catch (e) {}
  ctrl.port = ctrl.writer = ctrl.reader = null;
  setStatus("연결 안 됨 · 키보드로 조종", "");
}
function setStatus(msg, cls) { $("connStatus").textContent = msg; $("ctrlBox").className = "ctrl " + cls; $("btnConnect").textContent = ctrl.connected ? "해제" : "연결"; }
if ("serial" in navigator) navigator.serial.addEventListener("disconnect", () => {
  if (ctrl.connected) disconnectController().then(() => setStatus("조종기 USB가 분리됐어요", "bad"));
});

// ---------- 설정 ----------
const LEVELS = {
  1: { name: "1단", label: "천천히", vmax: 4.5, tilt: 18, vz: 2.5, yaw: 95, w0: 7, cam: 0 },
  2: { name: "2단", label: "보통", vmax: 8.5, tilt: 28, vz: 3.6, yaw: 125, w0: 8.5, cam: 12 },
  3: { name: "3단", label: "빠르게", vmax: 13, tilt: 38, vz: 5.0, yaw: 160, w0: 10, cam: 24 },
};
const ALLOWED = (CFG.speedLevels || [1, 2, 3]).filter(l => LEVELS[l]);
// 비행 모드 (실제 FPV 드론의 대표 모드)
const MODES = {
  angle: { name: "앵글", en: "ANGLE", tag: "쉬움", desc: "스틱을 놓으면 자동으로 수평이 되고 높이도 유지돼요. CoDrone 조종과 같은 느낌 — 처음엔 이 모드로!" },
  horizon: { name: "호라이즌", en: "HORIZON", tag: "보통", desc: "스틱 가운데에선 자동 수평, 끝까지 밀면 뒤집기(플립)까지 돼요. 높이는 스로틀로 직접 조절해야 해요." },
  acro: { name: "아크로", en: "ACRO", tag: "어려움", desc: "자동 수평이 없어요. 기울인 각도가 그대로 유지되는 레이싱 선수용 모드 — 가장 빠르고 자유로워요." },
};
const RATE = { 1: { rate: 220, thr: 1.0, cam: 15 }, 2: { rate: 340, thr: 1.5, cam: 25 }, 3: { rate: 480, thr: 2.1, cam: 35 } };
const ALLOWED_MODES = (CFG.allowedModes || ["angle", "horizon", "acro"]).filter(m => MODES[m]);
const INV = Object.assign({ throttle: false, yaw: false, pitch: false, roll: false }, CFG.invert || {});
const SETTINGS_KEY = "fpv-race-v3";
const S = { team: "", level: 2, mode: "angle", map: 0, drill: 0, center: { lx: 0, ly: 0, rx: 0, ry: 0 }, quality: 2 };
try { Object.assign(S, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (e) {}
if (!ALLOWED.includes(+S.level)) S.level = ALLOWED.includes(2) ? 2 : ALLOWED[0];
if (!ALLOWED_MODES.includes(S.mode)) S.mode = ALLOWED_MODES[0];
// 조종 설정 (메뉴의 "조종 설정"에서 조절, 이 PC에 저장)
const TUNE_DEF = { rate: 100, expo: 35, thr: 100, dead: 5, camAuto: true, cam: 20, fov: 92 };
S.tune = Object.assign({}, TUNE_DEF, S.tune || {});
S.tune.inv = Object.assign({}, INV, S.tune.inv || {});
const TK = () => S.tune.rate / 100;
S.map = clamp(+S.map || 0, 0, MAPS.length - 1); S.quality = clamp(+S.quality, 0, 2);
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch (e) {} }
const LV = () => LEVELS[S.level];
const teamName = () => S.team.trim();

// ---------- 스틱 모드: 왼쪽(L)·오른쪽(R) 스틱의 가로(x)·세로(y)가 어떤 조종을 맡는지 ----------
const STICK_MODES = {
  1: { th: "Ry", yaw: "Lx", pitch: "Ly", roll: "Rx" },
  2: { th: "Ly", yaw: "Lx", pitch: "Ry", roll: "Rx" },   // 한국·CoDrone 기본
  3: { th: "Ry", yaw: "Rx", pitch: "Ly", roll: "Lx" },
  4: { th: "Ly", yaw: "Rx", pitch: "Ry", roll: "Lx" },
};
if (!STICK_MODES[S.stickMode]) S.stickMode = 2;
const SM = () => STICK_MODES[S.stickMode];
const stickName = f => (SM()[f][0] === "L" ? "왼쪽 스틱" : "오른쪽 스틱");
// 안내 문구의 {THR} {YAW} {PITCH} {ROLL}을 현재 스틱 모드의 스틱 이름으로
const stickText = s => s.replace(/\{(THR|YAW|PITCH|ROLL)\}/g, (_, k) => stickName({ THR: "th", YAW: "yaw", PITCH: "pitch", ROLL: "roll" }[k]));

// ---------- 입력: 조종기 > 게임패드 > 키보드 (저역통과 필터로 부드럽게) ----------
const keys = {};
const kb = { Lx: 0, Ly: 0, Rx: 0, Ry: 0 }, filt = { th: 0, yaw: 0, pitch: 0, roll: 0 };
const approach = (v, t, s) => v + clamp(t - v, -s, s);
function shape(v) {
  v = clamp(v, -1, 1);
  const a = Math.abs(v), dead = S.tune.dead / 100, expo = S.tune.expo / 100;
  if (a < dead) return 0;
  let n = (a - dead) / (1 - dead);
  n = (1 - expo) * n + expo * n * n * n;
  return Math.sign(v) * n;
}
let inputSource = "키보드";
function readInput(dt) {
  // 1) 실제 스틱 위치 (왼쪽 Lx·Ly, 오른쪽 Rx·Ry, 위·오른쪽이 +)
  const st = { Lx: 0, Ly: 0, Rx: 0, Ry: 0 };
  const live = ctrl.connected && performance.now() - ctrl.lastJoy < 400;
  const gp = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find(g => g && g.connected);
  if (live) {
    inputSource = "조종기";
    st.Lx = (ctrl.lx - S.center.lx) / 100; st.Ly = (ctrl.ly - S.center.ly) / 100;
    st.Rx = (ctrl.rx - S.center.rx) / 100; st.Ry = (ctrl.ry - S.center.ry) / 100;
  } else if (gp) {
    inputSource = "게임패드";
    st.Lx = gp.axes[0]; st.Ly = -gp.axes[1]; st.Rx = gp.axes[2] || 0; st.Ry = -(gp.axes[3] || 0);
  } else {
    inputSource = "키보드";             // W·S·A·D = 왼쪽 스틱, 방향키 = 오른쪽 스틱
    const s = dt * 3;
    kb.Ly = approach(kb.Ly, (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), s);
    kb.Lx = approach(kb.Lx, (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), s * 1.5);
    kb.Ry = approach(kb.Ry, (keys.ArrowUp ? 1 : 0) - (keys.ArrowDown ? 1 : 0), s);
    kb.Rx = approach(kb.Rx, (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0), s * 1.5);
    Object.assign(st, kb);
  }
  // 2) 스틱 모드에 따라 조종 역할로
  const m = SM();
  let th = st[m.th], yaw = st[m.yaw], pitch = st[m.pitch], roll = st[m.roll];
  const iv = S.tune.inv;
  if (iv.throttle) th = -th; if (iv.yaw) yaw = -yaw; if (iv.pitch) pitch = -pitch; if (iv.roll) roll = -roll;
  const k = 1 - Math.exp(-dt / 0.075);   // 조종기는 50Hz 계단식 값이라 프레임 사이를 부드럽게 이어줌
  filt.th += (shape(th) - filt.th) * k; filt.yaw += (shape(yaw) - filt.yaw) * k;
  filt.pitch += (shape(pitch) - filt.pitch) * k; filt.roll += (shape(roll) - filt.roll) * k;
  return { th: filt.th, yaw: filt.yaw, pitch: filt.pitch, roll: filt.roll, raw: [st.Lx, st.Ly, st.Rx, st.Ry] };
}

// ---------- 맵 만들기 ----------
let map = null, cps = [], finishPad = null, activeTrack = [], flyCurve = null, trackLen = 0, drillInfo = null;
function trackDirs(start, track, pad) {
  const P = i => (i < 0 ? [start[0], start[1]] : [track[i].p[0], track[i].p[2]]);
  const last = track.length - 1;
  return track.map((t, i) => {
    const p = P(i), prev = P(i - 1);
    let dx, dz;
    if (i === 0 && track.length > 1) { const nx = P(1); dx = p[0] - prev[0] + (nx[0] - p[0]) * 0.5; dz = p[1] - prev[1] + (nx[1] - p[1]) * 0.5; }
    else if (i === last) { const nx = pad ? [pad[0], pad[1]] : [2 * p[0] - prev[0], 2 * p[1] - prev[1]]; dx = nx[0] - prev[0]; dz = nx[1] - prev[1]; }
    else { const nx = P(i + 1); dx = nx[0] - prev[0]; dz = nx[1] - prev[1]; }
    const L = Math.hypot(dx, dz) || 1;
    return V3(dx / L, 0, dz / L);
  });
}
function buildMap(mi, drill = 0) {
  disposeWorld();
  map = MAPS[mi]; S.map = mi; S.drill = drill;
  drillInfo = map.drills ? map.drills[clamp(drill, 0, map.drills.length - 1)] : null;
  activeTrack = drillInfo ? drillInfo.track : map.track;
  const padSpec = drillInfo ? drillInfo.pad : null;
  if (map.prepare) map.prepare();
  applyTheme(map.theme);
  idleCol = C(map.theme.idle).multiplyScalar(map.theme.idleBoost || 1);
  const env = { carbon: std(0x1b1f27, { metalness: 0.55, roughness: 0.38 }), legMat: std(0x2d333d, { metalness: 0.5, roughness: 0.5 }),
    pad: padSpec, tunnelStyles: map.tunnelStyles ? map.tunnelStyles() : {} };
  const dirs = trackDirs(map.start, activeTrack, padSpec);
  cps = activeTrack.map((spec, i) => makeCheckpoint(spec, dirs[i], i, activeTrack.length, env));
  if (drillInfo) cps.forEach((cp, i) => {
    const tip = drillInfo.tips[i] && stickText(drillInfo.tips[i]); if (!tip) return;
    const t = textSprite(tip, { size: 48, scale: 0.5, bg: "rgba(10,20,40,0.72)", color: "#ffe27a", weight: 700 });
    t.position.copy(cp.center).add(V3(0, (activeTrack[i].s || 3) / 2 + 1.45, 0)); world.add(t);
  });
  const path = [map.start, ...activeTrack.map(t => [t.p[0], t.p[2]])];
  if (padSpec) path.push([padSpec[0], padSpec[1]]);
  map.build({ path, track: activeTrack, cps, quality: S.quality });
  // 출발 패드
  const sp = new THREE.Mesh(new THREE.CircleGeometry(0.75, 40), std(0x23272f, { roughness: 0.6 }));
  sp.rotation.x = -Math.PI / 2; sp.position.set(map.start[0], 0.025, map.start[1]); world.add(sp);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.7, 40), basic(0x2dff8f));
  ring.rotation.x = -Math.PI / 2; ring.position.set(map.start[0], 0.03, map.start[1]); world.add(ring);
  // 착륙장 (정밀 착륙 연습)
  finishPad = null;
  if (padSpec) {
    const [px, pz, pr] = padSpec;
    const tex = ctex(256, 256, (g) => {
      g.fillStyle = "#1a2433"; g.beginPath(); g.arc(128, 128, 126, 0, 7); g.fill();
      g.strokeStyle = "#ffc53a"; g.lineWidth = 12; g.beginPath(); g.arc(128, 128, 108, 0, 7); g.stroke();
      g.fillStyle = "#fff"; g.font = "900 150px 'Rajdhani',sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("H", 128, 138);
    });
    const p = new THREE.Mesh(new THREE.CircleGeometry(pr, 40), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    p.rotation.x = -Math.PI / 2; p.position.set(px, 0.035, pz); p.receiveShadow = true; world.add(p);
    const lab = textSprite("LANDING · 착륙", { size: 56, scale: 0.6, bg: "rgba(220,20,60,0.85)", border: "#fff" });
    lab.position.set(px, 2.6, pz); world.add(lab);
    glowSprite(px, 0.2, pz, 0xffc53a, pr * 3, 0.25);
    finishPad = { x: px, z: pz, r: pr };
  }
  // 메뉴 배경용 비행 경로 + 코스 길이
  const pts = [V3(map.start[0], 2.5, map.start[1]), ...cps.map(c => c.center.clone().add(V3(0, 1.2, 0)))];
  flyCurve = new THREE.CatmullRomCurve3(pts, !drillInfo, "centripetal");
  trackLen = 0; for (let i = 1; i < pts.length; i++) trackLen += pts[i].distanceTo(pts[i - 1]);
  if (finishPad) trackLen += Math.hypot(finishPad.x - pts[pts.length - 1].x, finishPad.z - pts[pts.length - 1].z);
  applyQuality();
  loadBestSplits();
  respawn(true);
  renderDrillBar();
}

// ---------- 비행 물리 (고도 유지형, 속도 3단계) ----------
const G = 9.81, R = 0.18;
const drone = {
  pos: V3(), prev: V3(), vel: V3(), q: new THREE.Quaternion(),
  yaw: 0, yawRate: 0, att: { p: { x: 0, v: 0 }, r: { x: 0, v: 0 } }, ang: V3(),
  grounded: true, tumble: 0, shake: 0,
};
const _e = new THREE.Euler(0, 0, 0, "YXZ"), _v = V3(), _q = new THREE.Quaternion(), _w = V3(), _hn = V3(), _t = V3(), _up = V3();
function setPose(x, y, z, yaw) {
  drone.pos.set(x, y, z); drone.prev.copy(drone.pos); drone.vel.set(0, 0, 0);
  drone.yaw = yaw; drone.yawRate = 0; drone.ang.set(0, 0, 0); drone.tumble = 0; drone.thrust = 1; drone.flipT = 0;
  drone.att.p.x = drone.att.p.v = drone.att.r.x = drone.att.r.v = 0;
  drone.q.setFromEuler(_e.set(0, yaw, 0, "YXZ"));
  filt.th = filt.yaw = filt.pitch = filt.roll = 0;
}
const headingTo = (fx, fz, tx, tz) => Math.atan2(-(tx - fx), -(tz - fz));
function spring(s, target, w0, zeta, dt) { s.v += (w0 * w0 * (target - s.x) - 2 * zeta * w0 * s.v) * dt; s.x += s.v * dt; }
function resolveCollisions() {
  let impact = 0;
  for (let it = 0; it < 3; it++) {
    const pen = collideSphere(drone.pos, R, _hn);
    if (pen <= 0) break;
    drone.pos.addScaledVector(_hn, pen + 0.001);
    const vn = drone.vel.dot(_hn);
    if (vn < 0) {
      impact = Math.max(impact, -vn);
      drone.vel.addScaledVector(_hn, -vn * 1.35);          // 반발계수 0.35
      if (-vn > 0.5) { _t.copy(drone.vel).addScaledVector(_hn, -drone.vel.dot(_hn)); drone.vel.addScaledVector(_t, -0.3); }
    }
  }
  return impact;
}
// 부딪힌 곳에 흙먼지 · 나뭇잎 · 불꽃 + 화면 흔들림 + "쿠쿠쿵" 소리
const _up0 = V3(0, 1, 0);
let lastFx = 0;
function impactFx(kind, k, n) {
  const now = performance.now();
  if (now - lastFx < 120 && k < 0.9) return;
  lastFx = now;
  const dust = map.theme.dust || [0x9a9a9a], p = drone.pos.clone().addScaledVector(n, -R);
  if (kind === "ground") burst(p, _up0, { colors: dust, count: 8 + k * 24, speed: 1.4 + k * 3, spread: 1.5, size: 0.35, grow: 3, life: 1.0, gravity: 0.3, drag: 2.5, opacity: 0.55 });
  else if (kind === "tree") {
    burst(p, n, { colors: [0x4a8634, 0x5a9c42, 0x3c7431, 0x6aa84a], count: 8 + k * 22, speed: 2 + k * 3, spread: 1.3, size: 0.16, life: 1.4, gravity: 3, drag: 1.6, opacity: 0.95 });
    burst(p, n, { colors: [0x5d4128, 0x7a5636], count: 3 + k * 6, speed: 3, spread: 1, size: 0.1, life: 0.9, gravity: 8, opacity: 1 });
  } else if (kind === "metal") burst(p, n, { colors: [0xffb347, 0xffe08a, 0xffffff], count: 8 + k * 20, speed: 4 + k * 5, spread: 0.9, size: 0.07, life: 0.45, gravity: 9, drag: 1, additive: true });
  else burst(p, n, { colors: kind === "rock" ? [0x8d9094, 0xa9acb0] : dust, count: 8 + k * 16, speed: 1.5 + k * 3, spread: 1.2, size: 0.3, grow: 2.5, life: 0.9, gravity: 0.5, drag: 2.5, opacity: 0.5 });
  hitFlash(k);
  drone.shake = Math.max(drone.shake, 0.3 + k * 0.9);
  sfx.thud(k);
}
function hitFlash(k) {
  const el = $("hitFx"); el.style.transition = "none"; el.style.opacity = String(0.25 + k * 0.6);
  requestAnimationFrame(() => { el.style.transition = "opacity .6s ease-out"; el.style.opacity = "0"; });
}
function bump(impact, kind, n) {
  const k = clamp(impact / 4, 0, 1), rnd = () => Math.random() * 2 - 1;
  if (S.mode === "angle") { drone.att.p.v += rnd() * (2 + k * 8); drone.att.r.v += rnd() * (2 + k * 8); drone.yawRate += rnd() * k * 2; }
  else drone.ang.add(_w.set(rnd(), rnd() * 0.5, rnd()).multiplyScalar(2 + k * 8));
  if (race.state === "running") race.crashes++;
  impactFx(kind, k, n);
}
// 세게 부딪히면 추락 → 잠시 뒤 출발점에서 처음부터 다시
function crash(why, kind, n) {
  if (drone.tumble > 0) return;
  drone.tumble = 1.5; drone.shake = 1.4;
  const rnd = () => Math.random() * 2 - 1;
  drone.ang.set(rnd() * 9, rnd() * 5, rnd() * 9);
  impactFx(kind, 1, n);
  banner(why, "#ff4d5e", 1300);
  sfx.crash();
}
let tumbleDust = 0;
function tumbleStep(dt) {
  drone.tumble -= dt; tumbleDust -= dt;
  const a = drone.ang.length();
  if (a > 1e-4) { _q.setFromAxisAngle(_w.copy(drone.ang).divideScalar(a), a * dt); drone.q.multiply(_q).normalize(); }
  drone.vel.y -= G * dt; drone.vel.multiplyScalar(Math.exp(-0.4 * dt));
  drone.pos.addScaledVector(drone.vel, dt);
  resolveCollisions();
  if (drone.pos.y < R) {
    const iv = -drone.vel.y;
    drone.pos.y = R; drone.vel.y = Math.abs(drone.vel.y) * 0.3;
    drone.vel.x *= Math.exp(-5 * dt); drone.vel.z *= Math.exp(-5 * dt); drone.ang.multiplyScalar(Math.exp(-6 * dt));
    if (iv > 1 && tumbleDust <= 0) { tumbleDust = 0.25; impactFx("ground", clamp(iv / 6, 0.2, 1), _up0); }
  }
  if (drone.tumble <= 0) {
    respawn(true);
    $("result").classList.add("hidden");
    banner("처음부터 다시!", "#ffc53a", 1300);
  }
}
// 호라이즌 · 아크로: 스틱 = 회전 속도, 스로틀 = 추력 (가운데가 제자리 비행)
const _lv = V3();
function rateStep(dt, inp) {
  const RT = RATE[S.level], maxRate = deg(RT.rate) * TK();
  const parked = drone.grounded && inp.th <= 0.05;
  _w.set(-inp.pitch * maxRate, -inp.yaw * maxRate * 0.6, -inp.roll * maxRate);
  if (S.mode === "horizon") {
    // 스틱 가운데 근처: 자동 수평(앵글처럼) / 끝까지: 아크로처럼 계속 회전
    _e.setFromQuaternion(drone.q, "YXZ");
    const tilt = deg(55), blend = smoothstep(0.55, 0.95, Math.max(Math.abs(inp.pitch), Math.abs(inp.roll)));
    _lv.set((-inp.pitch * tilt - _e.x) * 7, 0, (-inp.roll * tilt - _e.z) * 7);
    _w.x = lerp(_lv.x, _w.x, blend); _w.z = lerp(_lv.z, _w.z, blend);
  }
  if (parked) _w.set(0, 0, 0);
  drone.ang.lerp(_w, 1 - Math.exp(-18 * dt));
  const a = drone.ang.length();
  if (a > 1e-5) { _q.setFromAxisAngle(_v.copy(drone.ang).divideScalar(a), a * dt); drone.q.multiply(_q).normalize(); }
  const tg = S.tune.thr / 100;
  drone.thrust += (1 + inp.th * (inp.th > 0 ? RT.thr * tg : 0.95 * Math.min(1, tg)) - drone.thrust) * (1 - Math.exp(-12 * dt));
  _up.set(0, 1, 0).applyQuaternion(drone.q);
  if (!parked) drone.vel.addScaledVector(_up, drone.thrust * G * dt);
  drone.vel.y -= parked ? 0 : G * dt;
  drone.vel.multiplyScalar(Math.exp(-(0.3 + 0.016 * drone.vel.length()) * dt));
  _e.setFromQuaternion(drone.q, "YXZ"); drone.yaw = _e.y;
}
function physicsStep(dt, inp) {
  drone.prev.copy(drone.pos);
  if (drone.tumble > 0) return tumbleStep(dt);
  if (S.mode !== "angle") { rateStep(dt, inp); return physicsCommon(dt, inp); }
  const L = LV();
  const parked = drone.grounded && inp.th <= 0.05;
  const K = TK(), baseTilt = deg(L.tilt), maxTilt = clamp(baseTilt * K, deg(5), deg(50)), w0 = L.w0 * Math.sqrt(K);
  spring(drone.att.p, parked ? 0 : -inp.pitch * maxTilt, w0, 0.9, dt);
  spring(drone.att.r, parked ? 0 : -inp.roll * maxTilt, w0, 0.9, dt);
  drone.yawRate += ((parked ? 0 : -inp.yaw * deg(L.yaw) * K) - drone.yawRate) * (1 - Math.exp(-6 * dt));
  drone.yaw += drone.yawRate * dt;
  drone.q.setFromEuler(_e.set(drone.att.p.x, drone.yaw, drone.att.r.x, "YXZ"));
  _up.set(0, 1, 0).applyQuaternion(drone.q);
  // 기울기 → 수평 가속 (최고속도에서 공기저항과 균형), 스로틀 → 상승/하강 속도
  const k = 2.0, drag = Math.tan(baseTilt) * G * k / L.vmax;       // 감도를 올리면 더 기울고 더 빨라짐
  if (!parked) { const uy = Math.max(_up.y, 0.3); drone.vel.x += _up.x / uy * G * k * dt; drone.vel.z += _up.z / uy * G * k * dt; }
  const f = Math.exp(-drag * dt); drone.vel.x *= f; drone.vel.z *= f;
  drone.vel.y += (inp.th * L.vz * S.tune.thr / 100 - drone.vel.y) * (1 - Math.exp(-3.5 * dt));
  physicsCommon(dt, inp);
}
// 모든 모드 공통: 이동 → 장애물 충돌 → 바닥 → 맵 경계 → 게이트 통과
function physicsCommon(dt, inp) {
  drone.pos.addScaledVector(drone.vel, dt);
  const impact = resolveCollisions();
  if (impact > 3.8) return crash("CRASH · 충돌!", hitTag, _hn.clone());
  if (impact > 0.7) bump(impact, hitTag, _hn.clone());
  if (drone.pos.y <= R) {
    const iv = -drone.vel.y;
    drone.pos.y = R;
    drone.vel.y = Math.max(0, drone.vel.y);
    if (iv > 4.2) return crash("CRASH · 추락!", "ground", _up0);
    if (iv > 1.2) bump(iv * 0.8, "ground", _up0);
    const fr = Math.exp(-7 * dt); drone.vel.x *= fr; drone.vel.z *= fr;
    drone.grounded = true;
    if (S.mode !== "angle") {
      _up.set(0, 1, 0).applyQuaternion(drone.q);
      if (drone.thrust < 1.05) {          // 착지하면 천천히 수평으로
        drone.q.slerp(_q.setFromEuler(_e.set(0, drone.yaw, 0, "YXZ")), 1 - Math.exp(-5 * dt));
        drone.ang.multiplyScalar(Math.exp(-8 * dt));
      }
      drone.flipT = _up.y < 0.15 ? (drone.flipT || 0) + dt : 0;
      if (drone.flipT > 1.0) { drone.flipT = 0; return crash("뒤집혔어요!", "ground", _up0); }
    }
  } else drone.grounded = false;
  // 맵 경계도 벽처럼: 튕기고 효과
  const [x0, x1, z0, z1, ym] = map.bounds;
  let bImp = 0; const bN = V3();
  if (drone.pos.x < x0 || drone.pos.x > x1) { bImp = Math.max(bImp, Math.abs(drone.vel.x)); bN.set(drone.pos.x < x0 ? 1 : -1, 0, 0); drone.pos.x = clamp(drone.pos.x, x0, x1); drone.vel.x *= -0.3; }
  if (drone.pos.z < z0 || drone.pos.z > z1) { bImp = Math.max(bImp, Math.abs(drone.vel.z)); bN.set(0, 0, drone.pos.z < z0 ? 1 : -1); drone.pos.z = clamp(drone.pos.z, z0, z1); drone.vel.z *= -0.3; }
  if (drone.pos.y > ym) { bImp = Math.max(bImp, drone.vel.y); bN.set(0, -1, 0); drone.pos.y = ym; drone.vel.y = -Math.abs(drone.vel.y) * 0.3; }
  if (bImp > 0.7) bump(bImp, "solid", bN);
  checkProgress();
}

// ---------- 레이스: 1번 게이트 통과 → 시작, 마지막 게이트(또는 착륙) → 완주 ----------
const race = { state: "ready", next: 0, t0: 0, time: 0, crashes: 0, simTime: 0, splits: [] };
let bestSplits = null;
const _d0 = V3(), _d1 = V3(), _hit = V3();
function insideHole(cp, x, y) {
  if (cp.shape === "rect") return Math.abs(x) < cp.hw && Math.abs(y) < cp.hh;
  if (cp.shape === "circle") return x * x + y * y < cp.R * cp.R;
  return y > 0 && x * x + y * y < cp.R * cp.R;     // arch
}
function checkProgress() {
  if (race.next >= cps.length) {
    if (finishPad && drone.grounded && Math.hypot(drone.pos.x - finishPad.x, drone.pos.z - finishPad.z) < finishPad.r && drone.vel.length() < 1.2) finishRun();
    return;
  }
  const cp = cps[race.next];
  _d0.subVectors(drone.prev, cp.o); _d1.subVectors(drone.pos, cp.o);
  const a = _d0.dot(cp.n), b = _d1.dot(cp.n);
  if (a < 0 && b >= 0) {
    _hit.copy(_d0).lerp(_d1, a / (a - b));
    if (insideHole(cp, _hit.dot(cp.r), _hit.dot(cp.u))) onGatePassed();
  }
}
function onGatePassed() {
  const i = race.next;
  if (i === 0) {
    race.state = "running"; race.t0 = race.simTime; race.crashes = 0; race.splits = [0];
    $("result").classList.add("hidden");
    banner("GO!", "#2dff8f", 700);
  } else {
    const t = race.simTime - race.t0;
    race.splits.push(t);
    if (bestSplits && bestSplits[i] !== undefined) showDelta(t - bestSplits[i]);
  }
  race.next++;
  sfx.gate();
  if (race.next >= cps.length && !finishPad) finishRun();
}
async function finishRun() {
  const time = race.simTime - race.t0;
  if (finishPad) race.splits.push(time);
  race.state = "done"; race.time = time; race.next = 0;
  sfx.finish();
  const entry = { map: map.id, team: teamName(), time: Math.round(time * 1000) / 1000, crashes: race.crashes, level: S.level, mode: S.mode };
  const prevBest = bestSplits ? bestSplits[bestSplits.length - 1] : null;
  if (prevBest === null || time < prevBest) saveBestSplits(race.splits);
  if (drillInfo) return showResult(entry, { practice: true, stars: drillStars(time, race.crashes), prevBest });
  showResult(entry, { pending: true, prevBest });
  try { showResult(entry, Object.assign(await Records.submit(entry), { prevBest })); }
  catch (e) { console.warn(e); showResult(entry, { error: true, prevBest }); }
}
function respawn(toStart) {
  const t = race.state === "running" && !toStart && race.next > 0 ? cps[race.next - 1] : null;
  if (t) { // 마지막으로 통과한 게이트 바로 뒤에서 다시 (시간은 계속 흐름)
    const dirH = V3(t.n.x, 0, t.n.z); if (dirH.lengthSq() < 0.01) dirH.copy(t.u); dirH.y = 0; dirH.normalize();
    const p = t.center.clone().addScaledVector(dirH, 1.5);
    setPose(p.x, Math.max(t.type === "dive" ? p.y - 1.2 : p.y, R + 0.5), p.z, Math.atan2(-dirH.x, -dirH.z));
    drone.grounded = false;
  } else {
    const g = activeTrack[0].p;
    setPose(map.start[0], R, map.start[1], headingTo(map.start[0], map.start[1], g[0], g[2]));
    drone.grounded = true;
    if (toStart || race.state !== "running") { race.state = "ready"; race.next = 0; }
  }
}
// 팀별 최고기록 구간 시간 (이 PC에 저장) → 게이트마다 +/- 비교
const splitKey = () => `fpv-splits:${Records.room}:${map.id}:${S.drill}:${Records.teamKey(teamName())}:${S.mode}${S.level}`;
function loadBestSplits() { try { bestSplits = JSON.parse(localStorage.getItem(splitKey()) || "null"); } catch (e) { bestSplits = null; } }
function saveBestSplits(s) { bestSplits = s.slice(); try { localStorage.setItem(splitKey(), JSON.stringify(bestSplits)); } catch (e) {} }
function drillStars(time, crashes) {
  const target = trackLen / (LV().vmax * 0.6) + 1.5;
  const st = crashes === 0 && time <= target ? 3 : crashes <= 1 && time <= target * 1.45 ? 2 : 1;
  const key = `fpv-stars:${Records.teamKey(teamName())}:${S.drill}:${S.mode}${S.level}`;
  try { if (st > (+localStorage.getItem(key) || 0)) localStorage.setItem(key, st); } catch (e) {}
  renderDrillBar();
  return st;
}
const starsOf = (drill) => { try { return +localStorage.getItem(`fpv-stars:${Records.teamKey(teamName())}:${drill}:${S.mode}${S.level}`) || 0; } catch (e) { return 0; } };
function onControllerButton() { if (!$("menu").classList.contains("hidden")) play(); else respawn(true); }

// ---------- 사운드 ----------
let actx = null, noiseBuf = null;
function audio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); return actx; } catch (e) { return null; } }
// 낮게 울리는 "쿵" (저역 노이즈 + 떨어지는 사인파)
function thump(t0, vol, cutoff) {
  const a = audio(); if (!a) return;
  if (!noiseBuf) { noiseBuf = a.createBuffer(1, a.sampleRate * 0.5, a.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const t = a.currentTime + t0;
  const src = a.createBufferSource(), lp = a.createBiquadFilter(), g = a.createGain();
  src.buffer = noiseBuf; lp.type = "lowpass"; lp.frequency.value = cutoff;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  src.connect(lp).connect(g).connect(a.destination); src.start(t); src.stop(t + 0.32);
  const o = a.createOscillator(), og = a.createGain();
  o.type = "sine"; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(36, t + 0.26);
  og.gain.setValueAtTime(vol * 1.5, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  o.connect(og).connect(a.destination); o.start(t); o.stop(t + 0.34);
}
function crunch(vol) {
  const a = audio(); if (!a || !noiseBuf) return;
  const t = a.currentTime, src = a.createBufferSource(), bp = a.createBiquadFilter(), g = a.createGain();
  src.buffer = noiseBuf; bp.type = "bandpass"; bp.frequency.value = 1400; bp.Q.value = 0.8;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  src.connect(bp).connect(g).connect(a.destination); src.start(t); src.stop(t + 0.2);
}
function tone(freq, dur, type = "square", vol = 0.06, slide = 0) {
  try {
    audio();
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
  } catch (e) {}
}
const sfx = {
  gate: () => { tone(1046, 0.08, "triangle", 0.09); setTimeout(() => tone(1568, 0.1, "triangle", 0.08), 55); },
  thud: k => {                           // 쿠·쿠·쿵
    const v = 0.14 + k * 0.4;
    thump(0, v, 240);
    if (k > 0.3) { thump(0.075, v * 0.6, 190); thump(0.16, v * 0.38, 150); }
    if (k > 0.5) crunch(0.06 + k * 0.1);
  },
  crash: () => { thump(0.02, 0.7, 320); crunch(0.25); tone(180, 0.6, "sawtooth", 0.05, -140); },
  finish: () => [784, 988, 1175, 1568].forEach((f, i) => setTimeout(() => tone(f, 0.2, "triangle", 0.1), i * 110)),
};

// ---------- HUD ----------
const overlay = $("overlay"), og = overlay.getContext("2d");
const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(3).padStart(6, "0")}`; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let bannerT = 0, deltaT = 0;
function banner(text, color, ms) {
  const b = $("banner"); b.textContent = text; b.style.color = color;
  b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
  clearTimeout(bannerT); bannerT = setTimeout(() => { b.textContent = ""; }, ms);
}
function showDelta(d) {
  const el = $("delta");
  el.textContent = (d <= 0 ? "−" : "+") + Math.abs(d).toFixed(2);
  el.className = "show " + (d <= 0 ? "good" : "bad");
  clearTimeout(deltaT); deltaT = setTimeout(() => el.classList.remove("show"), 2200);
}
let resultT = 0;
function showResult(e, res) {
  const el = $("result");
  const stars = res.stars ? `<div class="stars">${"★".repeat(res.stars)}<i>${"★".repeat(3 - res.stars)}</i></div>` : "";
  let rank = "", sub = "";
  const pb = res.prevBest;
  const pbLine = pb === null || pb === undefined ? "첫 완주 기록!" : e.time < pb ? `팀 최고기록 ${(pb - e.time).toFixed(2)}초 단축!` : `팀 최고기록보다 ${(e.time - pb).toFixed(2)}초 느림`;
  if (res.practice) { rank = drillInfo ? `${drillInfo.name} 연습 완료` : "연습 완료"; sub = `${pbLine}<br>연습 맵은 순위에 올라가지 않아요`; }
  else if (res.pending) { rank = "기록 저장 중…"; sub = pbLine; }
  else if (res.error) { rank = "기록 저장 실패"; sub = "인터넷 연결을 확인하세요"; }
  else { rank = `현재 ${res.rank}위`; sub = res.improved ? (res.prev === null ? "순위표에 첫 기록 등록!" : `팀 최고기록 갱신! (${(res.prev - e.time).toFixed(2)}초 단축)`) : pbLine; }
  el.innerHTML = `<div class="k">FINISH</div><div class="team">${esc(e.team)}</div><div class="time">${fmt(e.time)}</div>${stars}` +
    `<div class="rank">${rank}</div><div class="sub">${sub}<br>부딪힘 ${e.crashes}회 · ${MODES[S.mode].name} · ${LV().name}</div>` +
    `<div class="foot">1번 게이트로 다시 날아가면 새 도전 · <kbd>R</kbd> 출발점으로</div>`;
  el.classList.remove("hidden");
  clearTimeout(resultT); resultT = setTimeout(() => el.classList.add("hidden"), 7000);
}
function renderKeys() {
  $("keys").innerHTML = `<div class="kb"><button class="main" id="btnMenu"><span class="ic">☰</span>메인 메뉴</button>` +
    `<button id="btnRestart"><span class="ic">⟲</span>처음으로</button></div>` +
    `<div class="kh"><kbd>M</kbd>메뉴 · <kbd>R</kbd>처음으로 · 조종기 버튼 = 처음으로</div>`;
  $("btnMenu").onclick = () => toggleMenu(true);
  $("btnRestart").onclick = () => { respawn(true); $("result").classList.add("hidden"); };
}
function renderDrillBar() {
  const bar = $("drillBar");
  document.body.classList.toggle("edu", !!(map && map.drills));
  renderKeys();
  if (!map || !map.drills) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.innerHTML = map.drills.map((d, i) => {
    const st = starsOf(i);
    return `<button data-i="${i}" class="${i === S.drill ? "sel" : ""}" title="${stickText(d.desc)}"><span class="n">${i + 1}</span><span class="ic">${d.icon}</span>` +
      `<span class="txt"><div class="nm">${d.name}</div><div class="st">${"★".repeat(st)}${"☆".repeat(3 - st)}</div></span></button>`;
  }).join("");
  bar.querySelectorAll("button").forEach(b => b.onclick = () => selectDrill(+b.dataset.i));
  renderKeys();
}
function selectDrill(i) {
  if (!map || !map.drills || i >= map.drills.length) return;
  $("result").classList.add("hidden");
  buildMap(0, i); saveSettings();
  banner(map.drills[i].name, "#34d3ff", 900);
}
function setStick(id, x, y) {
  const d = document.querySelector(`#${id} .dot`);
  d.style.left = (50 + clamp(x, -1, 1) * 40) + "%"; d.style.top = (50 - clamp(y, -1, 1) * 40) + "%";
}
const _p = V3(), _gd = V3();
// 드론에서 게이트 구멍(통과면)의 가장 가까운 점까지 거리 — 옆으로 비껴 날아도 실제 남은 거리
function gateDist(cp) {
  _gd.subVectors(drone.pos, cp.o);
  let x = _gd.dot(cp.r), y = _gd.dot(cp.u);
  const z = _gd.dot(cp.n);
  if (cp.shape === "rect") { x = Math.max(0, Math.abs(x) - cp.hw); y = Math.max(0, Math.abs(y) - cp.hh); }
  else {
    if (cp.shape === "arch" && y < 0) { x = Math.max(0, Math.abs(x) - cp.R); return Math.hypot(x, y, z); }
    const rr = Math.hypot(x, y), out = Math.max(0, rr - cp.R);
    x = rr > 0 ? x / rr * out : 0; y = rr > 0 ? y / rr * out : 0;
  }
  return Math.hypot(x, y, z);
}
function drawOverlay() {
  const w = overlay.width, h = overlay.height, dpr = overlay._dpr;
  og.clearRect(0, 0, w, h);
  // 크로스헤어
  og.strokeStyle = "rgba(255,255,255,0.5)"; og.lineWidth = 1.5 * dpr;
  const c = 9 * dpr, g = 4 * dpr;
  og.beginPath();
  og.moveTo(w / 2 - c - g, h / 2); og.lineTo(w / 2 - g, h / 2); og.moveTo(w / 2 + g, h / 2); og.lineTo(w / 2 + c + g, h / 2);
  og.moveTo(w / 2, h / 2 - c - g); og.lineTo(w / 2, h / 2 - g); og.moveTo(w / 2, h / 2 + g); og.lineTo(w / 2, h / 2 + c + g); og.stroke();
  // 다음 목표 표시 (괄호 마커 / 화면 밖이면 화살표)
  let target = null, label = "", dist = 0;
  if (race.next < cps.length) { const cp = cps[race.next]; target = cp.center; label = String(race.next + 1); dist = gateDist(cp); }
  else if (finishPad) { target = _v.set(finishPad.x, 0.3, finishPad.z); label = "H"; dist = Math.hypot(drone.pos.x - finishPad.x, drone.pos.z - finishPad.z); }
  if (!target) return;
  _p.copy(target).project(camera);
  const behind = _p.z > 1;
  let x = (_p.x * 0.5 + 0.5) * w, y = (-_p.y * 0.5 + 0.5) * h;
  if (behind) { x = w - x; y = h - y; }
  const m = 60 * dpr, on = !behind && x > m && x < w - m && y > m && y < h - m;
  og.strokeStyle = og.fillStyle = "#2dff8f"; og.lineWidth = 2.5 * dpr; og.shadowColor = "#2dff8f"; og.shadowBlur = 10 * dpr;
  if (on) {
    const s = clamp(260 / Math.max(dist, 1), 14, 60) * dpr, k = s * 0.45;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      og.beginPath(); og.moveTo(x + sx * s, y + sy * (s - k)); og.lineTo(x + sx * s, y + sy * s); og.lineTo(x + sx * (s - k), y + sy * s); og.stroke();
    }
    // 위: 게이트 번호(작게) / 아래: 남은 거리(크게) — 번호를 거리로 착각하지 않게 분리
    og.shadowBlur = 0; og.font = `700 ${15 * dpr}px Rajdhani, sans-serif`; og.textAlign = "center";   // 거리만 표시 (게이트 번호 없음)
    og.fillText(`${Math.max(1, Math.round(dist))} M`, x, y - s - 8 * dpr);   // 1m 단위 (소수점 없음)
  } else {
    const cx = w / 2, cy = h / 2, ang = Math.atan2(y - cy, x - cx), rr = Math.min(w, h) / 2 - m;
    og.save(); og.translate(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr); og.rotate(ang);
    for (const off of [0, -14 * dpr]) { og.beginPath(); og.moveTo(off + 12 * dpr, 0); og.lineTo(off - 4 * dpr, -12 * dpr); og.lineTo(off - 4 * dpr, 12 * dpr); og.closePath(); og.fill(); }
    og.restore();
  }
  og.shadowBlur = 0;
}
let idleCol = null;
function updateCheckpointStates() {
  const idle = idleCol;
  cps.forEach((cp, i) => {
    let st = "idle";
    if (i === race.next) st = "next";
    else if (race.state === "running" && i === race.next + 1) st = "after";
    else if (race.state === "running" && i < race.next) st = "passed";
    setCheckpointState(cp, st, idle);
  });
}
let hudGateN = -1;
function updateHUD(now, inp) {
  const t = race.state === "running" ? race.simTime - race.t0 : race.state === "done" ? race.time : 0;
  const tm = $("timer"), ts = fmt(t);
  if (tm.dataset.t !== ts) { tm.dataset.t = ts; tm.innerHTML = ts.replace(/\d/g, d => `<i>${d}</i>`); }
  tm.className = race.state === "running" ? "" : race.state === "done" ? "done" : "idle";
  $("hint").textContent = race.state === "ready" ? "초록색 1번 게이트를 통과하면 타이머 시작!"
    : race.state === "running" && race.next >= cps.length && finishPad ? "H 착륙장에 착륙하세요!" : "";
  const passed = race.state === "running" ? race.next : 0, total = cps.length + (finishPad ? 1 : 0);
  $("gateNum").innerHTML = `${Math.min(passed + (race.state === "running" ? 1 : 0), total)}<small>/${total}</small>`;
  if (hudGateN !== passed * 100 + total) {
    hudGateN = passed * 100 + total;
    $("gateBar").innerHTML = Array.from({ length: total }, (_, i) => `<i class="${i < passed ? "on" : i === passed && race.state === "running" ? "cur" : ""}"></i>`).join("");
  }
  $("hudTeam").textContent = teamName();
  $("hudMap").textContent = `${map.level} · ${map.name}${drillInfo ? " · " + drillInfo.name : ""} · 난이도 ${map.diffName}`;
  if (drillInfo) {
    const st = starsOf(S.drill);
    $("recBox").innerHTML = `<div class="cap">PRACTICE</div><div class="row"><span>${drillInfo.icon} ${drillInfo.name}</span><span class="stars">${"★".repeat(st)}${"☆".repeat(3 - st)}</span></div>` +
      `<div class="row"><span style="color:var(--muted);font-size:12px">${stickText(drillInfo.desc)}</span></div>` +
      (bestSplits ? `<div class="row"><span>우리 팀 최고</span><b class="gold">${fmt(bestSplits[bestSplits.length - 1])}</b></div>` : "");
  } else {
    const list = tops[map.id] || [], me = Records.teamKey(teamName()), mine = list.find(r => Records.teamKey(r.team) === me);
    $("recBox").innerHTML = `<div class="cap">TRACK RECORD</div>` +
      (list[0] ? `<div class="row"><span>👑 ${esc(list[0].team)}</span><b class="gold">${fmt(list[0].time)}</b></div>` : `<div class="row"><span>아직 1위 없음 — 도전!</span></div>`) +
      `<div class="row"><span>우리 팀 ${mine ? list.indexOf(mine) + 1 + "위" : ""}</span><b>${mine ? fmt(mine.time) : "—"}</b></div>`;
  }
  $("spd").textContent = (drone.vel.length() * 3.6).toFixed(0);
  $("alt").textContent = Math.max(0, drone.pos.y - R).toFixed(1);
  $("lvl").textContent = `${MODES[S.mode].name} · ${LV().name}` + (inputSource === "조종기" ? "" : ` · ${inputSource}`);
  setStick("stickL", inp.raw[0], inp.raw[1]); setStick("stickR", inp.raw[2], inp.raw[3]);
}

// ---------- 메뉴 / 기록 ----------
const tops = {};
MAPS.filter(m => m.ranked).forEach(m => Records.subscribeTop(m.id, 10, list => { tops[m.id] = list; if (!$("menu").classList.contains("hidden")) renderMapCards(); }));
const ART = {
  edu: "linear-gradient(135deg,#2f8cff 0%,#53d18b 100%)", field: "linear-gradient(135deg,#ff9b5c 0%,#8a3f7a 60%,#2c3f7a 100%)",
  warehouse: "linear-gradient(135deg,#1d2733 0%,#2d4d6b 50%,#00cfff 140%)", city: "linear-gradient(135deg,#120c33 0%,#4a1f7a 55%,#ff4fd8 130%)",
};
function lengthOf(m) {
  const tr = m.drills ? null : m.track; if (!tr) return null;
  let L = 0, p = V3(m.start[0], 0, m.start[1]);
  for (const t of tr) { const q = V3(...t.p); L += p.distanceTo(q); p = q; }
  return Math.round(L / 10) * 10;
}
const DIFF_COL = ["#2dff8f", "#2dff8f", "#7dff5a", "#ffc53a", "#ff8a3a", "#ff4d5e"];
const THUMB_KEY = id => `fpv-thumb-v5:${id}`;
const thumbOf = id => { try { return localStorage.getItem(THUMB_KEY(id)); } catch (e) { return null; } };
function renderMapCards() {
  $("mapCards").innerHTML = MAPS.map((m, i) => {
    const t = (tops[m.id] || [])[0], L = lengthOf(m), th = thumbOf(m.id);
    const stats = m.drills ? `<span>연습 ${m.drills.length}종</span><span>순위 없음</span>` : `<span>GATE ${m.track.length}</span><span>${L} M</span>`;
    const rec = m.drills ? "직진 · 회전 · 상승하강 · 착륙 연습" : t ? `👑 ${esc(t.team)} <b>${fmt(t.time)}</b>` : "아직 1위가 없어요 — 첫 주인공 도전!";
    const art = th ? `background-image:url(${th})` : `background:${ART[m.id]}`;
    const dots = [1, 2, 3, 4, 5].map(k => `<i class="${k <= m.diff ? "on" : ""}"></i>`).join("");
    return `<button class="mapcard ${i === S.map ? "sel" : ""}" data-i="${i}" style="--d:${DIFF_COL[m.diff]}"><div class="art" style="${art}"><span class="lv">${m.level}</span><span class="no">0${i + 1}</span></div>` +
      `<div class="body"><div class="nm">${m.name}</div><div class="sb">${m.sub}</div>` +
      `<div class="diff">난이도 <span class="dots">${dots}</span><b>${m.diffName}</b></div><div class="ft">${m.feat}</div>` +
      `<div class="st">${stats}</div><div class="rec">${rec}</div></div></button>`;
  }).join("");
  $("mapCards").querySelectorAll(".mapcard").forEach(b => b.onclick = () => {
    const i = +b.dataset.i; if (i === S.map) return;
    buildMap(i, 0); saveSettings(); renderMapCards();
  });
}
function renderSpeed() {
  $("speedSeg").innerHTML = [1, 2, 3].map(l => {
    const L = LEVELS[l], ok = ALLOWED.includes(l);
    return `<button data-l="${l}" class="${l === S.level ? "sel" : ""}" ${ok ? "" : "disabled"}><div class="bars">${[1, 2, 3].map(k => `<i class="${k <= l ? "on" : ""}"></i>`).join("")}</div>` +
      `<div class="t1">${L.name}</div><div class="t2">${L.label} · ${S.mode === "angle" ? Math.round(L.vmax * 3.6) + "km/h" : "회전 " + RATE[l].rate + "°/s"}</div></button>`;
  }).join("");
  $("speedSeg").querySelectorAll("button").forEach(b => b.onclick = () => { S.level = +b.dataset.l; saveSettings(); loadBestSplits(); renderSpeed(); });
}
// 스틱 모드 선택 + 왼쪽/오른쪽 스틱 역할 안내
const FN_KO = { th: "↑↓ 상승 / 하강", yaw: "←→ 왼쪽 / 오른쪽 회전", pitch: "↑↓ 전진 / 후진", roll: "←→ 왼쪽 / 오른쪽 이동" };
const FN_EN = { th: "THR", yaw: "YAW", pitch: "PIT", roll: "ROLL" };
const fnOf = axis => Object.keys(SM()).find(f => SM()[f] === axis);
function renderStickModes() {
  $("stickSeg").innerHTML = [1, 2, 3, 4].map(n => {
    const m = STICK_MODES[n], f = axis => Object.keys(m).find(k => m[k] === axis);
    return `<button data-n="${n}" class="${n === S.stickMode ? "sel" : ""}"><div class="t1">MODE ${n}${n === 2 ? " ★" : ""}</div>` +
      `<div class="t2">왼쪽 ${FN_EN[f("Ly")]}·${FN_EN[f("Lx")]}</div></button>`;
  }).join("");
  $("stickDesc").innerHTML = ["L", "R"].map(sd =>
    `<div><b>${sd === "L" ? "LEFT STICK · 왼쪽" : "RIGHT STICK · 오른쪽"}</b>${FN_KO[fnOf(sd + "y")]}<br>${FN_KO[fnOf(sd + "x")]}</div>`).join("");
  document.querySelector("#stickL span").textContent = `${FN_EN[fnOf("Ly")]} · ${FN_EN[fnOf("Lx")]}`;
  document.querySelector("#stickR span").textContent = `${FN_EN[fnOf("Ry")]} · ${FN_EN[fnOf("Rx")]}`;
  $("stickSeg").querySelectorAll("button").forEach(b => b.onclick = () => {
    S.stickMode = +b.dataset.n; saveSettings(); renderStickModes();
    if (map && map.drills) buildMap(0, S.drill);       // 연습 맵 힌트 문구 갱신
  });
}
function renderModes() {
  $("modeSeg").innerHTML = Object.entries(MODES).map(([k, m]) => {
    const ok = ALLOWED_MODES.includes(k);
    return `<button data-m="${k}" class="${k === S.mode ? "sel" : ""}" ${ok ? "" : "disabled"}><div class="t1">${m.name}</div><div class="t2">${m.en} · ${m.tag}</div></button>`;
  }).join("");
  $("modeDesc").textContent = MODES[S.mode].desc;
  $("modeSeg").querySelectorAll("button").forEach(b => b.onclick = () => {
    S.mode = b.dataset.m; saveSettings(); loadBestSplits(); renderModes(); renderSpeed();
    respawn(true);
  });
}
function toggleMenu(show) {
  const menu = $("menu");
  if (show === undefined) show = menu.classList.contains("hidden");
  if (!show && !teamName()) { needTeam(); return; }
  menu.classList.toggle("hidden", !show);
  document.body.classList.toggle("in-menu", show);
  if (show) { renderMapCards(); renderModes(); renderSpeed(); flyT = 0; }
}
function needTeam() { const t = $("team"); t.classList.remove("need"); void t.offsetWidth; t.classList.add("need"); t.focus(); }
function play() {
  S.team = $("team").value.trim();
  if (!teamName()) { needTeam(); return; }
  saveSettings();
  loadBestSplits();
  respawn(true);
  $("result").classList.add("hidden");
  toggleMenu(false);
  $("team").blur();
  fpsAcc = fpsN = 0;
}

// ---------- 품질 자동 조절 ----------
function applyQuality() {
  const q = S.quality;
  renderer.setPixelRatio(q === 2 ? Math.min(devicePixelRatio, 2) : q === 1 ? 1 : 0.75);
  sun.shadow.mapSize.set(q === 2 ? 2048 : 1024, q === 2 ? 2048 : 1024);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  if (q === 0) sun.castShadow = false;
  world.traverse(o => { if (o.userData.grass) o.visible = q > 0; });
  resize();
}
let fpsAcc = 0, fpsN = 0;
function monitorFps(dt) {
  fpsAcc += dt; fpsN++;
  if (fpsAcc < 4) return;
  const fps = fpsN / fpsAcc; fpsAcc = fpsN = 0;
  if (fps < 28 && S.quality > 0) { S.quality--; saveSettings(); applyQuality(); }
}

// ---------- 메인 루프 ----------
function resize() {
  const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio, 2);
  renderer.setSize(w, h, false); canvas.style.width = w + "px"; canvas.style.height = h + "px";
  camera.aspect = w / h; camera.updateProjectionMatrix();
  overlay.width = w * dpr; overlay.height = h * dpr; overlay._dpr = dpr;
  overlay.style.width = w + "px"; overlay.style.height = h + "px";
}
addEventListener("resize", resize);
addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT") { if (e.code === "Enter") play(); return; }
  keys[e.code] = true;
  const inMenu = !$("menu").classList.contains("hidden");
  if (e.code === "Enter" && inMenu) play();
  if (e.code === "KeyM" || e.code === "Escape") toggleMenu();
  if (!inMenu && e.code === "KeyR") { respawn(true); $("result").classList.add("hidden"); }
  if (!inMenu && map.drills && /^Digit[1-6]$/.test(e.code)) selectDrill(+e.code.slice(5) - 1);
  if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
});
addEventListener("keyup", e => { keys[e.code] = false; });

const STEP = 1 / 240;
let last = performance.now(), acc = 0, T = 0, flyT = 0, lastCount = 0, lastHzT = 0;
const _tiltQ = new THREE.Quaternion(), _shakeQ = new THREE.Quaternion(), X_AXIS = V3(1, 0, 0), _look = V3();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now; T += dt;
  const inp = readInput(dt);
  const inMenu = !$("menu").classList.contains("hidden");
  if (!inMenu) {
    acc += dt;
    while (acc >= STEP) { physicsStep(STEP, inp); race.simTime += STEP; acc -= STEP; }
  }
  for (const f of anim) f(T, dt);
  if (inMenu && flyCurve) {
    // 메뉴 배경: 코스를 따라 천천히 비행
    flyT = (flyT + dt * 4.5 / Math.max(trackLen, 30)) % 1;
    const a = flyCurve.getPointAt(flyT), b = flyCurve.getPointAt((flyT + 0.04) % 1);
    camera.position.copy(a).add(V3(0, 2.8, 0)); _look.copy(b).add(V3(0, 1.2, 0)); camera.up.set(0, 1, 0); camera.lookAt(_look);
    camera.fov = 75; camera.updateProjectionMatrix();
  } else {
    camera.position.copy(drone.pos);
    const camTilt = !S.tune.camAuto ? S.tune.cam : S.mode === "angle" ? LV().cam : RATE[S.level].cam;     // 자동: 빠를수록 카메라를 위로
    camera.quaternion.copy(drone.q).multiply(_tiltQ.setFromAxisAngle(X_AXIS, deg(camTilt)));
    if (drone.shake > 0.01) {             // 충돌 흔들림: 묵직하게 덜컹거리다 잦아듦
      const s = drone.shake * drone.shake * 0.07;
      camera.quaternion.multiply(_shakeQ.setFromEuler(_e.set(Math.sin(T * 41) * s, Math.sin(T * 33 + 1.3) * s * 0.6, Math.sin(T * 27 + 2.1) * s * 1.6)));
      camera.position.y += Math.sin(T * 47) * s * 0.25;
      drone.shake *= Math.exp(-4.5 * dt);
    }
    const fov = S.tune.fov + clamp(drone.vel.length() * 0.9, 0, 14);   // 빠를수록 시야가 살짝 넓어짐
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * (1 - Math.exp(-4 * dt)); camera.updateProjectionMatrix(); }
  }
  followSun(camera.position); sky.position.copy(camera.position);
  updateCheckpointStates();
  fxUpdate(dt);
  renderFrame();
  if (!inMenu) { drawOverlay(); updateHUD(now, inp); monitorFps(dt); }
  if (now - lastHzT > 1000) { ctrl.hz = ctrl.joyCount - lastCount; lastCount = ctrl.joyCount; lastHzT = now; }
  if (inMenu && ctrl.connected) {
    if (now - ctrl.lastJoy < 400) setStatus(`조종기 연결됨 · ${ctrl.hz}Hz 수신 중`, "ok");
    else setStatus("조종기 응답 대기 중… (전원 확인)", "wait");
  }
}

// ---------- 시작 ----------
$("titleKo").textContent = CFG.title && CFG.title !== "FPV 드론 레이스" ? CFG.title : "드론 레이스";
$("roomTag").textContent = Records.room;
$("boardLink").href = `board.html?room=${encodeURIComponent(Records.room)}`;
$("team").value = S.team;
$("team").addEventListener("input", () => { S.team = $("team").value; $("team").classList.remove("need"); saveSettings(); });
$("btnPlay").onclick = play;
$("btnConnect").onclick = connectController;
$("btnCalib").onclick = () => { if (ctrl.connected) { S.center = { lx: ctrl.lx, ly: ctrl.ly, rx: ctrl.rx, ry: ctrl.ry }; saveSettings(); banner("보정 완료", "#34d3ff", 700); } };
// 조종 설정 패널
const TUNE_UI = [["tRate", "rate", "%"], ["tExpo", "expo", "%"], ["tThr", "thr", "%"], ["tDead", "dead", "%"], ["tCam", "cam", "°"], ["tFov", "fov", "°"]];
const INV_UI = [["tInvT", "throttle"], ["tInvY", "yaw"], ["tInvP", "pitch"], ["tInvR", "roll"]];
function renderTune() {
  for (const [id, k, u] of TUNE_UI) { $(id).value = S.tune[k]; $(id + "V").textContent = S.tune[k] + u; }
  $("tCamAuto").checked = S.tune.camAuto; $("tCam").disabled = S.tune.camAuto;
  if (S.tune.camAuto) $("tCamV").textContent = "자동";
  for (const [id, k] of INV_UI) $(id).checked = !!S.tune.inv[k];
}
for (const [id, k] of TUNE_UI) $(id).addEventListener("input", () => { S.tune[k] = +$(id).value; saveSettings(); renderTune(); });
for (const [id, k] of INV_UI) $(id).addEventListener("change", () => { S.tune.inv[k] = $(id).checked; saveSettings(); });
$("tCamAuto").addEventListener("change", () => { S.tune.camAuto = $("tCamAuto").checked; saveSettings(); renderTune(); });
// 기본값: 감도·카메라·반전 + 스틱 중앙 보정까지 처음 상태로
$("tReset").onclick = () => {
  S.tune = Object.assign({}, TUNE_DEF, { inv: Object.assign({}, INV) });
  S.center = { lx: 0, ly: 0, rx: 0, ry: 0 };
  saveSettings(); renderTune();
  const b = $("tReset"); b.textContent = "✓ 기본값으로 되돌렸어요"; setTimeout(() => { b.textContent = "↺ 기본값으로 되돌리기"; }, 1500);
};
renderTune();
renderModes(); renderSpeed(); renderStickModes(); renderKeys();
// 그래픽 드라이버가 WebGL을 끊으면(메모리 부족 등) 자동으로 다시 불러옴
canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); $("loading").textContent = "RELOADING GRAPHICS…"; $("loading").classList.remove("hidden"); });
canvas.addEventListener("webglcontextrestored", () => location.reload());

// 처음 한 번: 맵마다 실제 화면을 찍어 메뉴 카드 이미지로 저장
const nextTick = () => new Promise(r => setTimeout(r, 30));
async function captureThumbs() {
  const todo = MAPS.map((m, i) => i).filter(i => !thumbOf(MAPS[i].id));
  for (let n = 0; n < todo.length; n++) {
    const i = todo[n];
    $("loading").textContent = `PREPARING MAPS  ${n + 1} / ${todo.length}`;
    await nextTick();
    buildMap(i, 0);
    const a = flyCurve.getPointAt(0.03), b = flyCurve.getPointAt(0.09);
    camera.position.copy(a).add(V3(0, 3.5, 0)); camera.lookAt(b.clone().add(V3(0, 1, 0))); camera.fov = 70; camera.updateProjectionMatrix();
    followSun(camera.position); sky.position.copy(camera.position); updateCheckpointStates();
    renderFrame();
    const cv = document.createElement("canvas"); cv.width = 480; cv.height = 270;
    const src = renderer.domElement;
    if (!src.width || !src.height) continue;          // 창이 아직 0 크기면 다음에 다시 찍음
    const ar = src.width / src.height, sw = ar > 16 / 9 ? src.height * 16 / 9 : src.width, sh = sw * 9 / 16;
    try {
      cv.getContext("2d").drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, 480, 270);
      localStorage.setItem(THUMB_KEY(MAPS[i].id), cv.toDataURL("image/jpeg", 0.82));
    } catch (e) {}
  }
}
(document.fonts ? document.fonts.ready : Promise.resolve()).then(async () => {
  resize();
  const startMap = S.map, startDrill = S.map === 0 ? clamp(+S.drill || 0, 0, MAPS[0].drills.length - 1) : 0;
  await captureThumbs();
  buildMap(startMap, startDrill);
  renderMapCards();
  $("loading").classList.add("hidden");
  requestAnimationFrame(frame);
});
