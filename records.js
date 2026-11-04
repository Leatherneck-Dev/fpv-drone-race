// ============================================================
//  기록 저장/공유 모듈 (시뮬레이터와 순위 화면이 함께 사용)
//  - Firebase 설정이 있으면: 온라인(Firestore) — 모든 PC의 기록이 실시간 공유
//  - 없으면: 로컬 — 같은 브라우저의 탭끼리만 공유 (시험용)
//  저장 구조: rooms/{room}/best_{mapId}/{팀}  (팀별 최고기록)
//             rooms/{room}/feed/{자동}         (최근 완주 기록)
// ============================================================
(function () {
  "use strict";
  const cfg = window.SIM_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const room = ((params.get("room") || cfg.room || "class").replace(/[^\w가-힣-]/g, "").slice(0, 30)) || "class";
  const teamKey = t => String(t).trim().replace(/[\/.#$\[\]\s]+/g, "_").slice(0, 40) || "noname";

  const MAP_INFO = [
    // diff: 난이도 1~5, feat: 코스 특징
    { id: "edu", name: "교육용 맵", sub: "드론 연습장", level: "연습", ranked: false,   // 연습 전용: 기록 저장 안 함
      diff: 1, diffName: "입문", feat: "넓은 게이트 · 단계별 연습 6종" },
    { id: "field", name: "그린 필드", sub: "노을 지는 시골 코스", level: "실전 1", ranked: true, gates: 16,
      diff: 2, diffName: "쉬움", feat: "넓은 들판 · 완만한 회전 · 언덕 다이브" },
    { id: "warehouse", name: "물류 창고", sub: "실내 장애물 코스", level: "실전 2", ranked: true, gates: 15,
      diff: 3, diffName: "보통", feat: "좁은 통로 · 컨테이너 터널 · 높낮이 변화" },
    { id: "city", name: "메트로 시티", sub: "야경 빌딩 고공 코스", level: "실전 3", ranked: true, gates: 16,
      diff: 5, diffName: "어려움", feat: "옥상 고공 비행 · 다이브 · 빌딩 사이 급회전" },
  ];
  const LEVEL_NAME = { 1: "1단", 2: "2단", 3: "3단" };
  const MODE_NAME = { angle: "앵글", horizon: "호라이즌", acro: "아크로" };

  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => fail(new Error("load " + src));
      document.head.appendChild(s);
    });
  }

  function firebaseImpl() {
    if (!firebase.apps.length) firebase.initializeApp(cfg.firebase);
    const db = firebase.firestore();
    const ts = () => firebase.firestore.FieldValue.serverTimestamp();
    const roomDoc = db.collection("rooms").doc(room);
    const best = m => roomDoc.collection("best_" + m);
    const feed = roomDoc.collection("feed");
    return {
      kind: "online",
      async submit(e) {
        const ref = best(e.map).doc(teamKey(e.team));
        let improved = false, prev = null;
        await db.runTransaction(async tx => {
          const s = await tx.get(ref);
          prev = s.exists ? s.data().time : null;
          improved = prev === null || e.time < prev;
          if (improved) tx.set(ref, Object.assign({}, e, { at: ts() }));
        });
        feed.add(Object.assign({}, e, { improved, at: ts() })).catch(err => console.warn(err));
        const myBest = improved ? e.time : prev;
        const faster = await best(e.map).where("time", "<", myBest).get();
        return { improved, prev, rank: faster.size + 1 };
      },
      subscribeTop(map, n, cb) {
        return best(map).orderBy("time").limit(n)
          .onSnapshot(s => cb(s.docs.map(d => d.data())), err => console.warn("top", err));
      },
      subscribeFeed(n, cb) {
        return feed.orderBy("at", "desc").limit(n)
          .onSnapshot(s => cb(s.docs.map(d => d.data())), err => console.warn("feed", err));
      },
    };
  }

  function localImpl() {
    const K = k => `fpvsim:${room}:${k}`;
    const read = k => { try { return JSON.parse(localStorage.getItem(K(k)) || "null"); } catch (e) { return null; } };
    const write = (k, v) => { try { localStorage.setItem(K(k), JSON.stringify(v)); } catch (e) {} };
    const listeners = new Set();
    const notify = () => listeners.forEach(f => f());
    const bc = "BroadcastChannel" in window ? new BroadcastChannel("fpvsim-" + room) : null;
    if (bc) bc.onmessage = notify;
    addEventListener("storage", e => { if (e.key && e.key.startsWith(K(""))) notify(); });
    const topOf = (map, n) => Object.values(read("best_" + map) || {}).sort((a, b) => a.time - b.time).slice(0, n);
    return {
      kind: "local",
      async submit(e) {
        const all = read("best_" + e.map) || {}, key = teamKey(e.team);
        const prev = all[key] ? all[key].time : null;
        const improved = prev === null || e.time < prev;
        if (improved) all[key] = Object.assign({}, e, { at: Date.now() });
        write("best_" + e.map, all);
        const f = read("feed") || [];
        f.unshift(Object.assign({}, e, { improved, at: Date.now() }));
        write("feed", f.slice(0, 50));
        notify(); if (bc) bc.postMessage(1);
        const myBest = improved ? e.time : prev;
        return { improved, prev, rank: Object.values(all).filter(r => r.time < myBest).length + 1 };
      },
      subscribeTop(map, n, cb) { const f = () => cb(topOf(map, n)); listeners.add(f); f(); return () => listeners.delete(f); },
      subscribeFeed(n, cb) { const f = () => cb((read("feed") || []).slice(0, n)); listeners.add(f); f(); return () => listeners.delete(f); },
      clear() {
        MAP_INFO.forEach(m => write("best_" + m.id, {})); write("feed", []);
        notify(); if (bc) bc.postMessage(1);
      },
    };
  }

  let impl = null;
  const useFb = !!(cfg.firebase && cfg.firebase.projectId);
  const ready = (async () => {
    if (useFb) {
      await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
      await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js");
      impl = firebaseImpl();
    } else impl = localImpl();
    return impl;
  })().catch(err => {
    console.warn("Firebase 연결 실패 → 로컬 모드", err);
    impl = localImpl(); impl.kind = "local-fallback";
    return impl;
  });

  function sub(method) {
    return (...args) => {
      let un = null, dead = false;
      ready.then(i => { if (!dead) un = i[method](...args); });
      return () => { dead = true; if (un) un(); };
    };
  }

  window.Records = {
    room, teamKey, ready, MAP_INFO, LEVEL_NAME, MODE_NAME,
    get kind() { return impl ? impl.kind : "loading"; },
    submit: e => MAP_INFO.some(m => m.id === e.map && m.ranked)
      ? ready.then(i => i.submit(e))
      : Promise.resolve({ practice: true }),
    subscribeTop: sub("subscribeTop"),
    subscribeFeed: sub("subscribeFeed"),
    clearLocal: () => ready.then(i => i.clear && i.clear()),
  };
})();
