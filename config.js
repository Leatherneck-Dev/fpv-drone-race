// ============================================================
//  선생님용 설정 파일 — 이 파일만 고치면 됩니다.
// ============================================================
window.SIM_CONFIG = {
  // 화면에 표시될 이름
  title: "FPV 드론 레이스",

  // 수업(방) 코드 기본값. 링크 뒤에 ?room=코드 를 붙이면 그 코드가 우선합니다.
  // 예) https://내사이트/?room=1104-3반   /   https://내사이트/board.html?room=1104-3반
  // 수업마다 코드를 바꾸면 순위표가 새로 시작됩니다.
  room: "class",

  // 여러 PC의 기록을 한 화면에 모으는 Firebase 설정 (프로젝트: fpv-drone-race)
  // null 로 바꾸면 "로컬 모드": 같은 PC·같은 브라우저 안에서만 순위가 공유됩니다.
  // (웹 apiKey는 공개돼도 되는 값이고, 보안은 Firestore 규칙이 담당합니다)
  firebase: {
    apiKey: "AIzaSyDashyyNN6Fo6kwcn-0q3lNdOWpwctj0Mw",
    authDomain: "fpv-drone-race.firebaseapp.com",
    projectId: "fpv-drone-race",
    appId: "1:404204779535:web:bbf00ba91d78726d5ecb7a",
  },

  // 학생이 고를 수 있는 최고 속도 단계 (1: 천천히, 2: 보통, 3: 빠르게)
  // 모두 같은 속도로 겨루게 하려면 하나만 남기세요. 예) [2]
  speedLevels: [1, 2, 3],

  // 학생이 고를 수 있는 비행 모드: "angle"(앵글·쉬움) "horizon"(호라이즌·보통) "acro"(아크로·어려움)
  // 모두 같은 모드로 겨루게 하려면 하나만 남기세요. 예) ["angle"]
  allowedModes: ["angle", "horizon", "acro"],

  // 스틱 반전 기본값 (각 PC의 메뉴 "조종 설정"에서도 바꿀 수 있어요)
  invert: { throttle: false, yaw: false, pitch: false, roll: false },
};
