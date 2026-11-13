// 학생 화면 로직 (단계 2: 로그인·처음 등록 · 공지판 · 공지 상세 · 항목 체크 · 공지 바로가기 링크
//                  단계 3: 제출 표시 · 투표 · 한 줄 메모 · 마감 지난 응답 읽기 전용)
// 서버와 주고받는 일은 전부 api.js가 맡고, 이 파일은 화면만 다룬다.
// 서버에서 온 글은 항상 글자(textContent)로만 넣는다. innerHTML은 쓰지 않는다.
// 옛 휴대폰 브라우저를 생각해 ?. 와 ?? 문법은 쓰지 않는다.

import * as api from "./api.js";

const app = document.getElementById("app");

const RETRY_DELAY_MS = 1500; // 저장 실패 후 자동으로 한 번 더 시도하기까지 기다리는 시간
const SOON_MS = 72 * 60 * 60 * 1000; // [마감 임박] 탭: 마감까지 72시간 이내
const STALE_MS = 60 * 1000; // 공지판으로 돌아왔을 때 목록이 이보다 오래됐으면 뒤에서 새로 받는다
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000; // 한국 시각 = UTC+9 (서머타임 없음)
const MEMO_MAX = 100; // 한 줄 메모·의견 글자 수(서버와 같음)
const SHORT_CHOICE = 8; // 선택지가 모두 이 글자 수 이하면 2열 타일, 하나라도 길면 1열

const CATEGORIES = ["일반", "수행평가", "학교행사", "가정통신문", "제출물"];
const CATEGORY_CLASS = { 일반: "cat-1", 수행평가: "cat-2", 학교행사: "cat-3", 가정통신문: "cat-4", 제출물: "cat-5" };
const TABS = [
  { key: "todo", label: "미응답" },
  { key: "soon", label: "마감 임박" },
  { key: "all", label: "전체" },
];
const BOARD_STATE = { cb: "board" }; // 주소 기록(history)에 남기는 표시

/* ================= 화면 상태 ================= */

let screen = ""; // 지금 보이는 화면: setup | login | loading | error | board | detail
// 화면을 바꿀 때마다 1씩 늘린다. 늦게 도착한 서버 답이 이미 사라진 화면을 건드리지 않게 하는 표시.
let screenGen = 0;
// 로그인·로그아웃할 때마다 1씩 늘린다. 늦게 끝난 저장이 다른 로그인 상태에 섞이지 않게 하는 표시.
let sessionGen = 0;
let regInfo = null; // 처음 등록 정보 { open, from, to, className }
let board = null; // 공지판 { number, notices, byId, loadedAt }
// 공지별 체크 상태. 상세에서 한 번 열면 로그인이 끝날 때까지 유지하고, 공지판도 이것을 보고 상태를 그린다.
let entries = new Map();
let view = freshView(); // 공지판에서 고른 탭·칩 등
let boardRefs = null; // 공지판 화면이 떠 있을 때 다시 그릴 요소들
let refreshing = false;
let timingNote = ""; // 맨 아래 작은 회색 '서버 응답 ○초'
let timingEl = null;
let idSeq = 0;

function freshView() {
  return { tab: null, cat: "전체", pastOpen: false, scrollY: 0, lastOpened: null };
}

function resetSession() {
  sessionGen++;
  entries = new Map();
  board = null;
  view = freshView();
  refreshing = false;
  timingNote = "";
}

function beginScreen(name) {
  screen = name;
  screenGen++;
  boardRefs = null;
  timingEl = null;
  entries.forEach((entry) => {
    entry.view = null;
  });
  return screenGen;
}

/* ================= 작은 도우미 ================= */

// 화면 요소 만들기. 서버에서 온 글은 항상 글자 노드로만 들어간다.
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach((key) => {
      const value = props[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class") el.className = value;
      else if (key.indexOf("on") === 0) el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, "");
      else el.setAttribute(key, String(value));
    });
  }
  appendAll(el, children);
  return el;
}

function appendAll(el, children) {
  children.forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) appendAll(el, child);
    else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  });
}

function mount(...nodes) {
  app.textContent = "";
  appendAll(app, nodes);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seconds(ms) {
  return (Math.max(0, ms || 0) / 1000).toFixed(2) + "초";
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function kst(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + KST_MS);
  return {
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: "일월화수목금토".charAt(d.getUTCDay()),
    hm: pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()),
  };
}

function formatDeadline(iso) {
  const p = kst(iso);
  return p ? `${p.month}월 ${p.day}일(${p.weekday}) ${p.hm}` : null;
}

// 한국 시각 날짜 번호(날짜가 바뀔 때마다 1씩 커짐). D-Day 계산용.
function kstDay(ms) {
  return Math.floor((ms + KST_MS) / DAY_MS);
}

function parseNumber(text) {
  const s = String(text || "").trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= 1 && n <= 9999 ? n : null;
}

function isPin(text) {
  return /^\d{4}$/.test(text);
}

function sortedList(set) {
  return Array.from(set).sort((a, b) => a - b);
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function focusQuietly(el) {
  try {
    el.focus({ preventScroll: true });
  } catch (e) {
    el.focus();
  }
}

/* ---------- 선 아이콘 (모양은 고정값, 서버 값은 들어가지 않음) ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  bell: { fill: true, parts: [["p", "M12 3a6 6 0 0 0-6 6v3.6L4.4 15.4A1 1 0 0 0 5.3 17h13.4a1 1 0 0 0 .9-1.6L18 12.6V9a6 6 0 0 0-6-6zm-2.3 15a2.4 2.4 0 0 0 4.6 0z"]] },
  login: { parts: [["p", "M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"], ["p", "M10 16l4-4-4-4M14 12H4"]] },
  userPlus: { parts: [["c", 9, 8, 4], ["p", "M3 20a6 6 0 0 1 12 0M19 8v6M16 11h6"]] },
  idCard: { sw: 1.8, parts: [["r", 3, 5, 18, 14, 2], ["c", 9, 11, 2], ["p", "M6 16a3 3 0 0 1 6 0M14 10h4M14 13h3"]] },
  keypad: { sw: 1.8, parts: [["r", 3, 6, 18, 12, 2], ["p", "M7 12h.01M11 12h.01M15 12h.01"]] },
  lock: { parts: [["r", 5, 11, 14, 9, 2], ["p", "M8 11V8a4 4 0 0 1 8 0v3"]] },
  eye: { sw: 1.8, parts: [["p", "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"], ["c", 12, 12, 3]] },
  eyeOff: { sw: 1.8, parts: [["p", "M3 3l18 18"], ["p", "M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.3 4.2M6.6 6.6C3.7 8.5 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"], ["p", "M9.9 9.9a3 3 0 0 0 4.2 4.2"]] },
  checkCircle: { parts: [["c", 12, 12, 9], ["p", "M8 12l3 3 5-6"]] },
  history: { parts: [["p", "M3 12a9 9 0 1 0 3-6.7L3 8"], ["p", "M3 3v5h5M12 8v4l3 2"]] },
  link: { parts: [["p", "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"], ["p", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"]] },
  megaphone: { parts: [["p", "M4 10v4h3l6 4V6L7 10z"], ["p", "M17 9a4 4 0 0 1 0 6"]] },
  warning: { parts: [["p", "M12 3l9 16H3z"], ["p", "M12 10v4M12 17v.5"]] },
  arrowRight: { parts: [["p", "M5 12h14M13 6l6 6-6 6"]] },
  bolt: { parts: [["p", "M13 2L4 14h7l-1 8 9-12h-7z"]] },
  pin: { sw: 2.4, parts: [["p", "M9 4h6l-1 6 3 3H7l3-3z"], ["p", "M12 13v7"]] },
  check: { sw: 3, parts: [["p", "M5 12l5 5 9-10"]] },
  chevronRight: { sw: 2.4, parts: [["p", "M9 6l6 6-6 6"]] },
  chevronLeft: { sw: 2.4, parts: [["p", "M15 5l-7 7 7 7"]] },
  chevronDown: { sw: 2.2, parts: [["p", "M6 9l6 6 6-6"]] },
  chevronUp: { sw: 2.2, parts: [["p", "M6 15l6-6 6 6"]] },
  calendar: { parts: [["r", 4, 5, 16, 15, 2], ["p", "M8 3v4M16 3v4M4 10h16"]] },
  info: { parts: [["c", 12, 12, 9], ["p", "M12 11v5M12 8v.5"]] },
  alert: { parts: [["c", 12, 12, 9], ["p", "M12 7.5v5.5M12 16.5v.5"]] },
  refresh: { parts: [["p", "M20 12a8 8 0 1 1-2.3-5.7L20 8"], ["p", "M20 3v5h-5"]] },
  close: { parts: [["p", "M6 6l12 12M18 6L6 18"]] },
  search: { parts: [["c", 11, 11, 7], ["p", "M20 20l-4-4"]] },
  inbox: { parts: [["p", "M4 13h4l2 3h4l2-3h4"], ["p", "M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"]] },
  file: { parts: [["p", "M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"], ["p", "M14 3v4h4M9 12h6M9 16h4"]] },
  undo: { parts: [["p", "M9 14L4 9l5-5"], ["p", "M4 9h10a6 6 0 0 1 0 12h-3"]] },
};

function icon(name, size) {
  const def = ICONS[name];
  const svg = document.createElementNS(SVG_NS, "svg");
  const px = String(size || 20);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", px);
  svg.setAttribute("height", px);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "icon");
  if (def.fill) {
    svg.setAttribute("fill", "currentColor");
  } else {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", String(def.sw || 2));
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  }
  def.parts.forEach((part) => {
    let el;
    if (part[0] === "p") {
      el = document.createElementNS(SVG_NS, "path");
      el.setAttribute("d", part[1]);
    } else if (part[0] === "c") {
      el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("cx", part[1]);
      el.setAttribute("cy", part[2]);
      el.setAttribute("r", part[3]);
    } else {
      el = document.createElementNS(SVG_NS, "rect");
      el.setAttribute("x", part[1]);
      el.setAttribute("y", part[2]);
      el.setAttribute("width", part[3]);
      el.setAttribute("height", part[4]);
      el.setAttribute("rx", part[5]);
    }
    svg.appendChild(el);
  });
  return svg;
}

/* ---------- 버튼·입력 칸 ---------- */

function button(cls, label, opts) {
  opts = opts || {};
  return h(
    "button",
    { type: opts.type || "button", class: cls, onclick: opts.onclick || null },
    opts.before ? icon(opts.before, opts.size || 20) : null,
    h("span", { class: "btn-label" }, label),
    opts.after ? icon(opts.after, opts.size || 20) : null
  );
}

function setBusy(btn, busyText) {
  const label = btn.querySelector(".btn-label");
  btn.dataset.label = label.textContent;
  label.textContent = busyText;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
}

function clearBusy(btn) {
  const label = btn.querySelector(".btn-label");
  if (btn.dataset.label) label.textContent = btn.dataset.label;
  btn.disabled = false;
  btn.removeAttribute("aria-busy");
}

function digitsOnly(input) {
  input.addEventListener("input", () => {
    const v = input.value.replace(/\D/g, "").slice(0, 4);
    if (v !== input.value) input.value = v;
  });
  return input;
}

function numberInput(id, value) {
  return digitsOnly(
    h("input", {
      id,
      type: "text",
      inputmode: "numeric",
      pattern: "[0-9]*",
      maxlength: "4",
      autocomplete: "off",
      placeholder: "번호 입력",
      value: value ? String(value) : null,
    })
  );
}

function pinInput(id, cls) {
  return digitsOnly(
    h("input", {
      id,
      class: cls,
      type: "password",
      inputmode: "numeric",
      pattern: "[0-9]*",
      maxlength: "4",
      autocomplete: "off",
      placeholder: "숫자 4자리",
    })
  );
}

function fieldHead(forId, labelChildren, aside) {
  return h("div", { class: "field-head" }, h("label", { class: "field-label", for: forId }, labelChildren), aside || null);
}

function msgBox() {
  return h("p", { class: "msg", role: "status", "aria-live": "polite" });
}

function say(box, text, tone) {
  box.className = "msg msg-" + (tone || "error");
  box.textContent = text;
}

// 탭 줄에서 ← → 키로 옮겨 다니기
function wireTabKeys(tabs, select) {
  tabs.forEach((tab, i) => {
    tab.addEventListener("keydown", (e) => {
      let j = -1;
      if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = tabs.length - 1;
      if (j < 0) return;
      e.preventDefault();
      select(j);
      tabs[j].focus();
    });
  });
}

function appIcon() {
  return h(
    "div",
    { class: "app-icon", "aria-hidden": "true" },
    h("div", { class: "app-icon-inner" }, icon("bell", 28)),
    h("span", { class: "app-icon-dot" })
  );
}

function timingFooter() {
  timingEl = h("p", { class: "timing" }, timingNote);
  return timingEl;
}

// parts: [["로그인", 밀리초], ["공지판", 밀리초]]
function noteTiming(parts) {
  timingNote = "서버 응답 " + parts.map((p) => `${p[0]} ${seconds(p[1])}`).join(" · ");
  if (timingEl) timingEl.textContent = timingNote;
}

/* ---------- 주소(?n=공지ID)와 뒤로가기 ---------- */

function readNoticeParam() {
  try {
    const v = new URLSearchParams(window.location.search).get("n");
    const s = v ? v.trim() : "";
    return s ? s.slice(0, 64) : null;
  } catch (e) {
    return null;
  }
}

function urlFor(id) {
  const path = window.location.pathname;
  return id ? path + "?n=" + encodeURIComponent(id) : path;
}

function pushUrl(id) {
  try {
    window.history.pushState({ cb: "detail", id }, "", urlFor(id));
  } catch (e) {
    // 주소를 못 바꿔도 화면은 계속 동작한다.
  }
}

function replaceUrl(id, state) {
  try {
    window.history.replaceState(state, "", urlFor(id));
  } catch (e) {
    // 위와 같음
  }
}

function historyState() {
  try {
    return window.history.state || {};
  } catch (e) {
    return {};
  }
}

/* ================= 오류 안내 ================= */

function errorText(res) {
  const code = res && res.error;
  switch (code) {
    case "NETWORK":
      return "서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.";
    case "TIMEOUT":
      return "서버가 30초 동안 답하지 않았어요. 잠시 뒤 다시 시도해 주세요.";
    case "BAD_RESPONSE":
      return "서버 답을 읽지 못했어요. 선생님께 알려 주세요.";
    case "NOT_CONFIGURED":
      return "서버 주소가 설정되지 않았어요. 선생님께 알려 주세요.";
    case "SERVER_BUSY":
      return "지금 접속한 사람이 많아요. 잠시 뒤 다시 눌러 주세요.";
    case "SERVER_ERROR":
      return "서버에 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.";
    case "UNKNOWN_ACTION":
      return "화면과 서버가 서로 맞지 않아요. 선생님께 알려 주세요.";
    case "AUTH_REQUIRED":
      return "로그인이 풀렸어요. 다시 로그인해 주세요.";
    case "REG_CLOSED":
      return "지금은 처음 등록 시간이 아니에요. 선생님 안내를 기다려 주세요.";
    case "OUT_OF_RANGE":
      return regInfo && regInfo.open && regInfo.from != null
        ? `지금은 ${regInfo.from}~${regInfo.to}번만 등록할 수 있어요.`
        : "지금 등록할 수 있는 번호가 아니에요. 선생님 안내를 확인해 주세요.";
    case "ALREADY_REGISTERED":
      return "이미 등록된 번호예요. [로그인] 탭에서 로그인하세요. 비밀번호를 잊었다면 선생님께 초기화를 부탁하세요.";
    case "BAD_NUMBER":
      return "번호를 숫자로 정확히 입력해 주세요.";
    case "BAD_PIN":
      return "비밀번호는 숫자 4자리로 입력해 주세요.";
    case "WEAK_PIN":
      return "같은 숫자(예: 1111)나 연속 숫자(예: 1234, 9876)는 쓸 수 없어요. 다른 숫자로 정해 주세요.";
    case "NOT_REGISTERED":
      return regInfo && regInfo.open
        ? "아직 등록하지 않은 번호예요. [처음 등록] 탭에서 먼저 등록해 주세요."
        : "아직 등록하지 않은 번호예요. 번호를 확인하거나 선생님께 물어보세요.";
    case "WRONG_PIN": {
      const left = Number(res.remaining);
      return Number.isFinite(left) && left > 0
        ? `비밀번호가 틀렸어요. 남은 기회는 ${left}번이에요. 모두 틀리면 10분 동안 잠겨요.`
        : "비밀번호가 틀렸어요.";
    }
    case "LOCKED": {
      const p = kst(res.lockedUntil);
      return p
        ? `비밀번호를 5번 틀려서 잠겼어요. ${p.hm}에 풀려요(한국 시각). 그때 다시 시도해 주세요.`
        : "비밀번호를 5번 틀려서 잠겼어요. 10분 뒤에 다시 시도해 주세요.";
    }
    case "NOT_FOUND":
      return "이 공지를 찾을 수 없어요. 선생님이 공지를 끝냈을 수 있어요. 화면을 새로고침해 주세요.";
    case "CLOSED":
      return "마감이 지나서 더 이상 바꿀 수 없어요.";
    case "BAD_REQUEST":
      return (res && res.message) || "요청이 올바르지 않아요. 화면을 새로고침해 주세요.";
    default:
      return (res && res.message) || `문제가 생겼어요. (${code || "알 수 없음"})`;
  }
}

function isRetryable(res) {
  const code = res && res.error;
  return (
    code === "NETWORK" ||
    code === "TIMEOUT" ||
    code === "SERVER_BUSY" ||
    code === "SERVER_ERROR" ||
    code === "BAD_RESPONSE"
  );
}

function saveFailText(res) {
  switch (res && res.error) {
    case "NETWORK":
      return "저장하지 못했어요. 인터넷 연결을 확인하고 [다시 시도]를 눌러 주세요.";
    case "TIMEOUT":
      return "저장하지 못했어요. 서버가 30초 동안 답하지 않았어요. [다시 시도]를 눌러 주세요.";
    case "SERVER_BUSY":
    case "SERVER_ERROR":
    case "BAD_RESPONSE":
      return "저장하지 못했어요. 잠시 뒤 [다시 시도]를 눌러 주세요.";
    default:
      return "저장하지 못했어요. " + errorText(res);
  }
}

/* ================= 1. 설정이 필요해요 ================= */

function showSetupNeeded() {
  beginScreen("setup");
  mount(
    h(
      "div",
      { class: "page page-login" },
      h("div", { class: "hero" }, appIcon(), h("h1", { class: "hero-title" }, "우리 반 공지판")),
      h(
        "section",
        { class: "state-card" },
        h("div", { class: "state-icon is-amber" }, icon("info", 28)),
        h("h2", null, "설정이 필요해요"),
        h("p", null, "서버 주소가 아직 들어 있지 않아요."),
        h("p", { class: "muted" }, "선생님: frontend/config.js 파일의 API_URL에 Apps Script 웹 앱 주소를 넣어 주세요."),
        h("p", { class: "muted" }, "학생: 이 화면이 보이면 선생님께 알려 주세요.")
      )
    )
  );
}

/* ================= 2. 로그인 · 처음 등록 (시안 ①, ①-2) ================= */

function showLogin(opts) {
  opts = opts || {};
  const gen = beginScreen("login");
  const saved = api.getSavedNumber();
  const fromLink = Boolean(readNoticeParam()); // 단톡방 공지 링크(?n=)로 들어왔는지

  // ---- 위쪽 소개: 로그인 탭(가운데 아이콘) / 처음 등록 탭(작은 제목) ----
  const classText = h("span", null, "");
  const classBadge = h(
    "span",
    { class: "class-badge is-pending" },
    h("span", { class: "dot", "aria-hidden": "true" }),
    classText
  );
  const heroLogin = h(
    "div",
    { class: "hero" },
    appIcon(),
    classBadge,
    h("h1", { class: "hero-title" }, "우리 반 공지판"),
    h("p", { class: "hero-sub" }, "우리 반 하루의 시작과 끝, 공지부터 챙겨요")
  );
  const heroReg = h(
    "div",
    { class: "hero-compact", hidden: true },
    h("h1", { class: "hero-title-sm" }, "우리 반 공지판", h("span", { class: "dot", "aria-hidden": "true" })),
    h("p", { class: "hero-sub" }, "처음 온 학생은 4자리 비밀번호를 정해 주세요")
  );

  // ---- 탭: 처음 등록이 열려 있을 때만 보인다 ----
  const tabLogin = h(
    "button",
    {
      type: "button",
      role: "tab",
      id: "tab-login",
      class: "seg-tab seg-tab-lg",
      "aria-controls": "panel-login",
      onclick: () => selectTab("login"),
    },
    icon("login", 18),
    "로그인"
  );
  const tabReg = h(
    "button",
    {
      type: "button",
      role: "tab",
      id: "tab-reg",
      class: "seg-tab seg-tab-lg",
      "aria-controls": "panel-reg",
      onclick: () => selectTab("reg"),
    },
    icon("userPlus", 18),
    "처음 등록"
  );
  const tabs = h("div", { class: "seg", role: "tablist", "aria-label": "로그인 방법", hidden: true }, tabLogin, tabReg);
  wireTabKeys([tabLogin, tabReg], (i) => selectTab(i === 0 ? "login" : "reg"));

  // ---- 로그인 ----
  const loginNumber = numberInput("login-number", saved);
  const loginPin = pinInput("login-pin", "pin-input");
  const eyeBtn = h(
    "button",
    { type: "button", class: "eye-btn", "aria-label": "비밀번호 보기", "aria-pressed": "false", onclick: toggleEye },
    icon("eye", 22)
  );
  const loginBtn = button("btn btn-primary btn-lg", "로그인", { type: "submit", before: "checkCircle" });
  const loginMsg = msgBox();
  const loginForm = h(
    "form",
    {
      class: "form-card",
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        submitLogin();
      },
    },
    fieldHead("login-number", "번호", h("span", { class: "field-aside" }, "숫자만")),
    h("div", { class: "input-wrap" }, h("span", { class: "input-icon" }, icon("idCard", 20)), loginNumber),
    fieldHead(
      "login-pin",
      ["비밀번호 ", h("span", { class: "field-label-sub" }, "(숫자 4자리)")],
      h("span", { class: "pin-chip" }, icon("lock", 12), "숫자 PIN")
    ),
    h(
      "div",
      { class: "input-wrap input-wrap-btn" },
      h("span", { class: "input-icon" }, icon("keypad", 20)),
      loginPin,
      eyeBtn
    ),
    loginBtn,
    loginMsg
  );
  const regLine = h(
    "p",
    { hidden: true },
    "처음이라면 ",
    h(
      "button",
      {
        type: "button",
        class: "text-link",
        onclick: () => {
          selectTab("reg");
          tabReg.focus();
        },
      },
      "[처음 등록]"
    ),
    "에서 비밀번호를 정하세요"
  );
  const panelLogin = h(
    "div",
    { id: "panel-login", class: "stack" },
    loginForm,
    h(
      "div",
      { class: "help" },
      regLine,
      h("p", { class: "help-row" }, icon("history", 16), "비밀번호를 잊었으면 담임 선생님께 초기화를 부탁하세요")
    ),
    h(
      "div",
      { class: "box box-amber" },
      h("div", { class: "box-icon" }, icon("link", 20)),
      h(
        "div",
        null,
        h("b", null, "공지 바로가기 링크"),
        h("br"),
        fromLink
          ? "로그인하면 단톡방에서 누른 공지가 바로 열려요."
          : "단톡방 링크로 들어왔다면 로그인한 뒤 그 공지가 바로 열려요."
      )
    )
  );

  function toggleEye() {
    const show = loginPin.type === "password";
    loginPin.type = show ? "text" : "password";
    eyeBtn.setAttribute("aria-pressed", String(show));
    eyeBtn.setAttribute("aria-label", show ? "비밀번호 숨기기" : "비밀번호 보기");
    eyeBtn.textContent = "";
    eyeBtn.appendChild(icon(show ? "eyeOff" : "eye", 22));
  }

  // ---- 처음 등록 ----
  const regRange = h("span", null, "지금 처음 등록을 받고 있어요");
  const regExample = h("span", { class: "field-aside" }, "숫자만");
  const regNumber = numberInput("reg-number", null);
  const regPin = pinInput("reg-pin", "pin-solo");
  const regPin2 = pinInput("reg-pin2", "pin-solo");
  const regBtn = button("btn btn-primary btn-lg", "등록하고 시작하기", { type: "submit", after: "arrowRight" });
  const regMsg = msgBox();
  const regForm = h(
    "form",
    {
      class: "form-card",
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        submitRegister();
      },
    },
    fieldHead("reg-number", "번호", regExample),
    h("div", { class: "input-wrap" }, regNumber, h("span", { class: "unit", "aria-hidden": "true" }, "번")),
    fieldHead(
      "reg-pin",
      ["비밀번호 정하기 ", h("span", { class: "field-label-sub" }, "(4자리)")],
      h("span", { class: "field-aside field-aside-warn" }, "숫자만 가능")
    ),
    regPin,
    fieldHead("reg-pin2", "비밀번호 한 번 더"),
    regPin2,
    h(
      "div",
      { class: "warn-box" },
      icon("warning", 20),
      h(
        "span",
        null,
        "쉬운 비밀번호인 ",
        h("b", null, "같은 숫자(1111)"),
        "나 ",
        h("b", null, "연속된 숫자(1234)"),
        "는 쓸 수 없어요. 비밀번호는 친구에게 알려 주지 마세요."
      )
    ),
    regBtn,
    regMsg
  );
  const panelReg = h(
    "div",
    { id: "panel-reg", class: "stack", hidden: true },
    h(
      "div",
      { class: "box box-amber" },
      h("div", { class: "box-icon" }, icon("megaphone", 20)),
      h(
        "div",
        null,
        h("span", { class: "live-chip" }, "진행 중"),
        h("b", null, "등록 기간 안내"),
        h("br"),
        regRange
      )
    ),
    regForm,
    h(
      "p",
      { class: "help" },
      h(
        "span",
        null,
        "이미 등록했나요? ",
        h(
          "button",
          {
            type: "button",
            class: "text-link text-link-dark",
            onclick: () => {
              selectTab("login");
              tabLogin.focus();
            },
          },
          "로그인으로 돌아가기"
        )
      )
    ),
    h(
      "div",
      { class: "box box-white" },
      h("div", { class: "box-icon" }, icon("bolt", 20)),
      h(
        "div",
        null,
        "단톡방 공지 링크로 들어왔다면, 등록을 마친 뒤 ",
        h("b", null, "그 공지"),
        "로 바로 연결돼요."
      )
    )
  );

  function selectTab(name) {
    const isReg = name === "reg";
    tabLogin.setAttribute("aria-selected", String(!isReg));
    tabReg.setAttribute("aria-selected", String(isReg));
    tabLogin.tabIndex = isReg ? -1 : 0;
    tabReg.tabIndex = isReg ? 0 : -1;
    panelLogin.hidden = isReg;
    panelReg.hidden = !isReg;
    heroLogin.hidden = isReg;
    heroReg.hidden = !isReg;
  }

  let preferApplied = false;
  function applyRegInfo() {
    // 학급명 배지: "○○ 학생 전용"
    const name = regInfo && typeof regInfo.className === "string" ? regInfo.className.trim() : "";
    classText.textContent = name ? `${name} 학생 전용` : "";
    classBadge.classList.remove("is-pending");
    classBadge.hidden = !name;

    const open = Boolean(regInfo && regInfo.open);
    tabs.hidden = !open;
    regLine.hidden = !open;
    // 탭이 보일 때만 탭 패널로 알린다(화면 읽기 프로그램용)
    [
      [panelLogin, "tab-login"],
      [panelReg, "tab-reg"],
    ].forEach((pair) => {
      if (open) {
        pair[0].setAttribute("role", "tabpanel");
        pair[0].setAttribute("aria-labelledby", pair[1]);
      } else {
        pair[0].removeAttribute("role");
        pair[0].removeAttribute("aria-labelledby");
      }
    });
    if (!open) {
      selectTab("login");
      return;
    }
    regRange.textContent = "";
    if (regInfo.from != null && regInfo.to != null) {
      appendAll(regRange, ["지금 ", h("b", { class: "u" }, `${regInfo.from}~${regInfo.to}번`), " 학생의 처음 등록을 받고 있어요"]);
      regExample.textContent = `예: ${regInfo.from}번이면 ${regInfo.from}`;
    } else {
      regRange.textContent = "지금 처음 등록을 받고 있어요";
    }
    // 비밀번호가 초기화돼 다시 등록해야 하는 경우, 처음 한 번만 [처음 등록] 탭으로 옮기고 번호를 채워 둔다.
    if (opts.preferRegister && !preferApplied) {
      preferApplied = true;
      selectTab("reg");
      if (saved && !regNumber.value) regNumber.value = String(saved);
      if (opts.message) say(regMsg, opts.message, opts.tone || "info"); // 로그인 탭의 안내는 가려지므로 여기에도 보여 준다
    }
  }

  async function submitLogin() {
    if (loginBtn.disabled) return;
    const number = parseNumber(loginNumber.value);
    const pin = loginPin.value;
    if (number === null) return say(loginMsg, "번호를 숫자로 입력해 주세요.");
    if (!isPin(pin)) return say(loginMsg, "비밀번호는 숫자 4자리예요.");

    say(loginMsg, "", "info");
    setBusy(loginBtn, "로그인하는 중…");
    const res = await api.login(number, pin);
    if (gen !== screenGen) return;
    clearBusy(loginBtn);
    if (res.ok) {
      resetSession();
      enterApp({ label: "로그인", elapsedMs: res.elapsedMs });
      return;
    }
    if (res.error === "WRONG_PIN" || res.error === "BAD_PIN" || res.error === "LOCKED") {
      loginPin.value = "";
    }
    say(loginMsg, errorText(res));
  }

  async function submitRegister() {
    if (regBtn.disabled) return;
    const number = parseNumber(regNumber.value);
    const pin = regPin.value;
    if (number === null) return say(regMsg, "번호를 숫자로 입력해 주세요.");
    if (regInfo && regInfo.open && regInfo.from != null && (number < regInfo.from || number > regInfo.to)) {
      return say(regMsg, errorText({ error: "OUT_OF_RANGE" }));
    }
    if (!isPin(pin)) return say(regMsg, "비밀번호는 숫자 4자리로 정해 주세요.");
    if (regPin2.value !== pin) {
      regPin2.value = "";
      return say(regMsg, "두 비밀번호가 달라요. '비밀번호 한 번 더' 칸에 다시 입력해 주세요.");
    }

    say(regMsg, "", "info");
    setBusy(regBtn, "등록하는 중…");
    const res = await api.register(number, pin);
    if (gen !== screenGen) return;
    clearBusy(regBtn);
    if (res.ok) {
      resetSession();
      enterApp({ label: "등록", elapsedMs: res.elapsedMs });
      return;
    }
    if (res.error === "WEAK_PIN" || res.error === "BAD_PIN") {
      regPin.value = "";
      regPin2.value = "";
    }
    if (res.error === "REG_CLOSED") {
      regInfo = { open: false, from: null, to: null, className: regInfo ? regInfo.className : "" };
      applyRegInfo();
      say(loginMsg, errorText(res));
      return;
    }
    say(regMsg, errorText(res));
  }

  selectTab("login");
  mount(h("div", { class: "page page-login" }, heroLogin, heroReg, tabs, panelLogin, panelReg));
  window.scrollTo(0, 0);

  if (opts.message) say(loginMsg, opts.message, opts.tone || "info");

  // 처음 등록이 열려 있는지 확인(기다리지 않고 로그인 칸은 바로 쓸 수 있다)
  if (regInfo) applyRegInfo();
  api.getRegInfo().then((res) => {
    if (gen !== screenGen) return;
    regInfo = res.ok
      ? { open: Boolean(res.open), from: res.from, to: res.to, className: res.className }
      : null;
    applyRegInfo();
  });
}

/* ================= 3. 불러오기 · 오류 ================= */

function barHeader(number) {
  return h(
    "header",
    { class: "bar" },
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("h1", { class: "bar-title" }, "우리 반 공지판"),
    number
      ? h("span", { class: "me-badge" }, h("span", { class: "dot dot-sm", "aria-hidden": "true" }), `${number}번`)
      : null,
    h("button", { type: "button", class: "bar-link", onclick: logout }, "로그아웃")
  );
}

function skeletonCard() {
  return h(
    "div",
    { class: "skel-card", "aria-hidden": "true" },
    h("div", { class: "skel skel-tag" }),
    h("div", { class: "skel skel-title" }),
    h("div", { class: "skel-row" }, h("div", { class: "skel skel-chip" }), h("div", { class: "skel skel-btn" }))
  );
}

function showLoading() {
  const gen = beginScreen("loading");
  mount(
    barHeader(api.getSavedNumber()),
    h(
      "div",
      { class: "page", "aria-busy": "true" },
      h("div", { class: "skel skel-seg", "aria-hidden": "true" }),
      h("p", { class: "loading-text", role: "status" }, "공지를 불러오는 중…"),
      skeletonCard(),
      skeletonCard(),
      skeletonCard()
    )
  );
  window.scrollTo(0, 0);
  return gen;
}

function showLoadError(res, intro) {
  beginScreen("error");
  mount(
    barHeader(api.getSavedNumber()),
    h(
      "div",
      { class: "page" },
      h(
        "section",
        { class: "state-card", role: "alert" },
        h("div", { class: "state-icon" }, icon("alert", 28)),
        h("h2", null, "공지를 불러오지 못했어요"),
        h("p", null, errorText(res)),
        button("btn btn-primary btn-lg", "다시 불러오기", { before: "refresh", onclick: () => enterApp(intro) })
      ),
      timingFooter()
    )
  );
  window.scrollTo(0, 0);
}

// 로그인(또는 저장된 로그인)으로 들어올 때: 공지판을 받고, 주소에 ?n=가 있으면 그 공지를 연다.
async function enterApp(intro) {
  const gen = showLoading();
  const res = await api.getBoard();
  if (gen !== screenGen) return; // 로그아웃했거나 로그인 화면으로 넘어감(AUTH_REQUIRED)
  if (!res.ok) {
    noteTiming([["공지판", res.elapsedMs]]);
    showLoadError(res, intro);
    return;
  }
  applyBoard(res);
  noteTiming(intro ? [[intro.label, intro.elapsedMs], ["공지판", res.elapsedMs]] : [["공지판", res.elapsedMs]]);
  routeFromUrl();
}

function applyBoard(res) {
  const notices = Array.isArray(res.notices)
    ? res.notices.filter((n) => n && typeof n.id === "string" && n.id)
    : [];
  const byId = new Map();
  notices.forEach((n) => byId.set(n.id, n));
  // 이번 로그인에서 학생이 만진 체크는 화면 상태를 그대로 둔다(저장 중인 것이 서버 목록보다 최신일 수 있음).
  // 다만 공지가 사라졌거나, 유형·항목·메모 허용이 바뀌었거나, 마감됐으면 서버 기록으로 다시 맞춘다.
  entries.forEach((entry, id) => {
    const n = byId.get(id);
    if (!n) entries.delete(id);
    else if (!entry.inFlight && (n.closed || noticeSig(n) !== entry.sig)) entries.delete(id);
  });
  board = {
    number: res.number != null ? res.number : api.getSavedNumber(),
    notices,
    byId,
    loadedAt: Date.now(),
  };
}

function routeFromUrl() {
  const id = readNoticeParam();
  if (!id) {
    showBoard();
    return;
  }
  if (board.byId.has(id)) {
    const st = historyState();
    if (!(st.cb === "detail" && st.id === id)) {
      // 링크로 처음 들어온 경우: 아래에 공지판 기록을 하나 깔아 두어 뒤로가기가 공지판으로 오게 한다.
      replaceUrl(null, BOARD_STATE);
      pushUrl(id);
    }
    showDetail(id);
    return;
  }
  replaceUrl(null, BOARD_STATE);
  showBoard({ notFound: true });
}

function onPopState() {
  if (!board || (screen !== "board" && screen !== "detail")) return;
  const id = readNoticeParam();
  if (!id) {
    if (screen === "detail") showBoard({ restore: true });
    return;
  }
  if (!board.byId.has(id)) {
    replaceUrl(null, BOARD_STATE);
    showBoard({ notFound: true });
    return;
  }
  if (screen === "board") {
    view.scrollY = window.pageYOffset || 0;
    view.lastOpened = id;
  }
  showDetail(id);
}

function logout() {
  api.clearSession();
  resetSession();
  replaceUrl(null, BOARD_STATE);
  showLogin({ message: "로그아웃했어요.", tone: "info" });
}

/* ================= 4. 공지판 (시안 ②) ================= */

function itemsOf(notice) {
  return Array.isArray(notice.items) ? notice.items.map(String) : [];
}

// 이 화면이 다룰 응답 모양
//   CHECKLIST 항목 체크 · SUBMIT 제출 표시 · POLL 투표 · READONLY 읽기만(항목 없는 체크 공지) · null 이 화면이 모르는 유형
function kindOf(notice) {
  const count = itemsOf(notice).length;
  if (notice.type === "CHECKLIST") return count > 0 ? "CHECKLIST" : "READONLY";
  if (notice.type === "SUBMIT") return "SUBMIT";
  if (notice.type === "POLL") return count > 0 ? "POLL" : null;
  return null;
}

// 공지의 응답 모양이 바뀌었는지 알아보는 표시(유형·메모 허용·항목)
function noticeSig(notice) {
  return [notice.type, notice.memoAllowed ? "memo" : ""].concat(itemsOf(notice)).join("\n");
}

// 한 줄 메모 정리: 서버(api_memo_)와 똑같이 줄바꿈·제어 글자를 공백으로, 공백 여러 개는 하나로, 앞뒤 공백 제거.
// 100자를 넘으면 자른다(한글 입력 중에 칸 제한을 넘는 휴대폰이 있어서).
function normalizeMemo(text) {
  let m = String(text || "")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (m.length > MEMO_MAX) {
    m = m.slice(0, MEMO_MAX);
    if (/[\uD800-\uDBFF]$/.test(m)) m = m.slice(0, -1); // 이모지 반쪽이 남지 않게
    m = m.trim();
  }
  return m;
}

function initialSubmitted(notice) {
  return Boolean(notice.myResponse && notice.myResponse.submitted === true);
}

function initialChoice(notice, items) {
  const c = notice.myResponse ? notice.myResponse.choice : null;
  return Number.isInteger(c) && c >= 0 && c < items.length ? c : null;
}

function initialMemo(notice) {
  if (!notice.memoAllowed) return "";
  const m = notice.myResponse ? notice.myResponse.memo : "";
  return typeof m === "string" ? m : "";
}

function isClosed(notice) {
  const entry = entries.get(notice.id);
  return Boolean(notice.closed || (entry && entry.closed));
}

function deadlineMs(notice) {
  const t = notice.deadline ? Date.parse(notice.deadline) : NaN;
  return Number.isFinite(t) ? t : null;
}

function isSoon(notice) {
  const t = deadlineMs(notice);
  return !isClosed(notice) && t !== null && t - Date.now() <= SOON_MS;
}

function initialChecked(notice, items) {
  const mine = notice.myResponse && Array.isArray(notice.myResponse.checked) ? notice.myResponse.checked : [];
  return sortedList(new Set(mine.filter((i) => Number.isInteger(i) && i >= 0 && i < items.length)));
}

// 카드에 보일 내 상태: 학생이 이번에 만진 응답이 있으면 그것을, 없으면 서버 기록을 본다.
// [미응답] 탭 개수도 이것의 done으로 센다(모든 유형).
function progressOf(notice) {
  const kind = kindOf(notice);
  const entry = entries.get(notice.id);
  const failed = Boolean(entry && entry.phase === "failed");
  const items = itemsOf(notice);
  if (kind === "READONLY") return { kind, done: true, failed: false }; // 항목 없는 체크 공지: 읽기만
  if (kind === "CHECKLIST") {
    const count = entry ? entry.checked.size : initialChecked(notice, items).length;
    return { kind, total: items.length, count, done: count === items.length, failed };
  }
  if (kind === "SUBMIT") {
    return { kind, done: entry ? entry.submitted : initialSubmitted(notice), failed };
  }
  if (kind === "POLL") {
    const choice = entry ? entry.choice : initialChoice(notice, items);
    return { kind, done: choice !== null, choiceText: choice !== null ? items[choice] : "", failed };
  }
  return { kind, done: Boolean(notice.myResponse && notice.myResponse.done), failed: false };
}

function countTodo() {
  return board.notices.filter((n) => !isClosed(n) && !progressOf(n).done).length;
}

function categoryTag(category) {
  if (!category) return null;
  return h("span", { class: "tag " + (CATEGORY_CLASS[category] || "") }, category);
}

function pinTag() {
  return h("span", { class: "tag tag-pin" }, icon("pin", 12), "고정");
}

// D-Day: 한국 시각 날짜 기준. 오늘 마감 'D-Day', 3일 이내 진한 주황, 7일 이내 옅은 주황, 그 밖은 회색.
function dueBadge(notice, closed, extraClass) {
  let text;
  let spoken = null;
  let tone;
  const t = deadlineMs(notice);
  if (closed) {
    text = "마감";
    tone = "past";
  } else if (t === null) {
    text = "마감 없음";
    tone = "none";
  } else {
    const diff = kstDay(t) - kstDay(Date.now());
    if (diff <= 0) {
      text = "D-Day";
      spoken = "오늘 마감";
      tone = "urgent";
    } else {
      text = "D-" + diff;
      spoken = `마감 ${diff}일 전`;
      tone = diff <= 3 ? "urgent" : diff <= 7 ? "soon" : "plain";
    }
  }
  return h(
    "span",
    { class: `due due-${tone}` + (extraClass ? " " + extraClass : "") },
    spoken ? [h("span", { "aria-hidden": "true" }, text), h("span", { class: "sr-only" }, spoken)] : text
  );
}

function stateText(text) {
  return h("span", { class: "state-text" }, text); // 긴 선택지는 말줄임(…)으로 자른다
}

function statusChip(p, closed) {
  if (p.failed) return h("span", { class: "state state-bad" }, icon("alert", 14), "저장 안 됨");
  if (p.kind === "SUBMIT") {
    if (p.done) return h("span", { class: "state state-ok" }, icon("check", 14), "제출함");
    if (closed) return h("span", { class: "state state-past" }, "제출 표시 안 함");
    return h("span", { class: "state state-todo" }, "아직 제출 표시 안 함");
  }
  if (p.kind === "POLL") {
    if (p.done) return h("span", { class: "state state-ok" }, icon("check", 14), stateText("응답함 · " + p.choiceText));
    if (closed) return h("span", { class: "state state-past" }, "고르지 않았어요");
    return h("span", { class: "state state-todo" }, "아직 안 골랐어요");
  }
  if (p.done) return h("span", { class: "state state-ok" }, icon("check", 14), "완료");
  if (closed) return h("span", { class: "state state-past" }, "끝내지 못했어요");
  if (p.total && p.count > 0) return h("span", { class: "state state-todo" }, `체크 ${p.total - p.count}개 남음`);
  return h("span", { class: "state state-todo" }, "아직 안 했어요");
}

// 카드 버튼 글자: 제출·투표는 시안 ②대로 '제출 표시'·'응답하기' / '내 응답 보기 >', 항목 체크는 단계 2 그대로.
function cardButtonLabel(p, closed) {
  const todo = !closed && !p.done;
  const answerable = p.kind === "SUBMIT" || p.kind === "POLL";
  if (todo) {
    if (p.kind === "SUBMIT") return { text: "제출 표시", chevron: false };
    if (p.kind === "POLL") return { text: "응답하기", chevron: false };
    return { text: "확인하기", chevron: true };
  }
  if (answerable && p.done) return { text: "내 응답 보기", chevron: true };
  return { text: "보기", chevron: true };
}

function noticeCard(notice) {
  const p = progressOf(notice);
  const closed = isClosed(notice);
  const titleId = "nt" + ++idSeq;
  const todo = !closed && !p.done;
  const label = cardButtonLabel(p, closed);
  const btn = h(
    "button",
    {
      type: "button",
      class: "btn-card" + (todo ? " btn-card-primary" : "") + (label.chevron ? "" : " btn-card-plain"),
      "aria-describedby": titleId,
    },
    label.text,
    label.chevron ? icon("chevronRight", 16) : null
  );
  if (boardRefs) boardRefs.buttons.set(notice.id, btn);
  // 카드 어디를 눌러도 상세로 간다(안의 버튼을 눌러도 이 한 곳에서 처리).
  return h(
    "article",
    { class: "ncard", "aria-labelledby": titleId, onclick: () => openNotice(notice.id) },
    h("div", { class: "ncard-top" }, notice.pinned ? pinTag() : null, categoryTag(notice.category), dueBadge(notice, closed)),
    h("h2", { class: "ncard-title", id: titleId }, notice.title || "(제목 없음)"),
    h("div", { class: "ncard-bottom" }, statusChip(p, closed), btn)
  );
}

function emptyState(hasPast) {
  const cat = view.cat === "전체" ? null : view.cat;
  let title;
  let sub = null;
  let iconName = "inbox";
  let ok = false;
  if (view.tab === "todo") {
    title = cat ? `‘${cat}’에는 미응답 공지가 없어요` : "미응답 공지가 없어요";
    sub = cat ? null : "할 일을 모두 마쳤어요. 새 공지가 오면 여기에 보여요.";
    iconName = "check";
    ok = true;
  } else if (view.tab === "soon") {
    title = cat ? `‘${cat}’에는 3일 안에 마감되는 공지가 없어요` : "3일 안에 마감되는 공지가 없어요";
    iconName = "calendar";
  } else {
    title = cat
      ? hasPast
        ? `진행 중인 ‘${cat}’ 공지가 없어요`
        : `‘${cat}’ 공지가 없어요`
      : hasPast
        ? "진행 중인 공지가 없어요"
        : "아직 공지가 없어요";
    sub = cat ? null : "새 공지가 오면 여기에 보여요.";
  }
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty-icon" + (ok ? " is-ok" : "") }, icon(iconName, 22)),
    h("p", { class: "empty-title" }, title),
    sub ? h("p", { class: "empty-sub" }, sub) : null
  );
}

function notFoundBanner() {
  const box = h(
    "div",
    { class: "banner", role: "alert" },
    h("div", { class: "box-icon" }, icon("search", 20)),
    h(
      "div",
      { class: "banner-text" },
      h("b", null, "공지를 찾을 수 없어요"),
      h("span", null, "나에게 온 공지가 아니거나, 선생님이 이미 끝낸 공지일 수 있어요.")
    ),
    h("button", { type: "button", class: "banner-close", "aria-label": "안내 닫기", onclick: () => box.remove() }, icon("close", 20))
  );
  return box;
}

function showBoard(opts) {
  opts = opts || {};
  if (!board) {
    enterApp(null);
    return;
  }
  const gen = beginScreen("board");
  // 처음 열 때: 미응답이 있으면 [미응답], 없으면 [전체]. 그 뒤로는 학생이 고른 탭을 유지한다.
  if (view.tab === null) view.tab = countTodo() > 0 ? "todo" : "all";

  const refs = { tabs: {}, chips: {}, buttons: new Map(), body: null, todoCount: null };
  boardRefs = refs;

  const tabButtons = TABS.map((t) => {
    const btn = h(
      "button",
      {
        type: "button",
        role: "tab",
        id: "tab-" + t.key,
        class: "seg-tab",
        "aria-controls": "board-panel",
        onclick: () => setTab(t.key),
      },
      t.label
    );
    refs.tabs[t.key] = btn;
    return btn;
  });
  refs.todoCount = h("span", { class: "count", "aria-hidden": "true" });
  refs.tabs.todo.appendChild(refs.todoCount);
  wireTabKeys(tabButtons, (i) => setTab(TABS[i].key));

  const chipButtons = ["전체"].concat(CATEGORIES).map((cat) => {
    const btn = h(
      "button",
      { type: "button", class: "chip " + (CATEGORY_CLASS[cat] || ""), onclick: () => setCategory(cat) },
      cat
    );
    refs.chips[cat] = btn;
    return btn;
  });

  refs.body = h("div", { id: "board-panel", role: "tabpanel", class: "board-body" });

  const storageWarn = api.canRememberLogin()
    ? null
    : h(
        "p",
        { class: "note note-amber" },
        icon("info", 18),
        "이 브라우저는 로그인을 기억하지 못해요. 창을 닫으면 다시 로그인해야 해요."
      );

  mount(
    barHeader(board.number),
    h(
      "div",
      { class: "page" },
      opts.notFound ? notFoundBanner() : null,
      storageWarn,
      h("div", { class: "seg", role: "tablist", "aria-label": "공지 보기" }, tabButtons),
      h("div", { class: "chips", role: "group", "aria-label": "카테고리로 거르기" }, chipButtons),
      refs.body,
      timingFooter()
    )
  );
  renderBoardBody();

  if (opts.restore) {
    // 상세에서 돌아옴: 보던 자리로, 그 카드의 버튼에 초점
    window.scrollTo(0, view.scrollY);
    const btn = view.lastOpened ? refs.buttons.get(view.lastOpened) : null;
    if (btn) focusQuietly(btn);
  } else {
    window.scrollTo(0, 0);
  }

  if (Date.now() - board.loadedAt > STALE_MS) refreshBoard();
  return gen;
}

function setTab(key) {
  view.tab = key;
  view.pastOpen = false;
  renderBoardBody();
}

function setCategory(cat) {
  view.cat = cat;
  renderBoardBody();
  const chip = boardRefs && boardRefs.chips[cat];
  if (chip && chip.scrollIntoView) {
    try {
      chip.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (e) {
      // 옛 브라우저: 안 움직여도 된다
    }
  }
}

function renderBoardBody() {
  const refs = boardRefs;
  if (!refs || !board) return;

  const todoCount = countTodo();
  refs.todoCount.textContent = String(todoCount);
  refs.todoCount.hidden = todoCount === 0;
  refs.tabs.todo.setAttribute("aria-label", todoCount ? `미응답 ${todoCount}개` : "미응답");
  TABS.forEach((t) => {
    const on = t.key === view.tab;
    refs.tabs[t.key].setAttribute("aria-selected", String(on));
    refs.tabs[t.key].tabIndex = on ? 0 : -1;
  });
  refs.body.setAttribute("aria-labelledby", "tab-" + view.tab);
  Object.keys(refs.chips).forEach((cat) => {
    refs.chips[cat].setAttribute("aria-pressed", String(cat === view.cat));
  });

  const inCategory = (n) => view.cat === "전체" || n.category === view.cat;
  const open = board.notices.filter((n) => !isClosed(n));
  let shown = open;
  if (view.tab === "todo") shown = open.filter((n) => !progressOf(n).done);
  else if (view.tab === "soon") shown = open.filter(isSoon);
  shown = shown.filter(inCategory);
  const past = view.tab === "all" ? board.notices.filter((n) => isClosed(n) && inCategory(n)) : [];

  refs.buttons = new Map();
  refs.body.textContent = "";
  refs.body.appendChild(shown.length ? h("div", { class: "cards" }, shown.map(noticeCard)) : emptyState(past.length > 0));

  if (past.length) {
    // 마감 지난 공지: '지난 공지 N개 보기'(처음엔 접힘)
    const pastList = h(
      "div",
      { id: "past-list", class: "cards", hidden: !view.pastOpen },
      h("p", { class: "past-title" }, "마감이 지난 공지 · 읽기만 할 수 있어요"),
      past.map(noticeCard)
    );
    const toggle = h("button", {
      type: "button",
      class: "past-toggle",
      "aria-controls": "past-list",
      onclick: () => {
        view.pastOpen = !view.pastOpen;
        pastList.hidden = !view.pastOpen;
        paintToggle();
      },
    });
    const paintToggle = () => {
      toggle.setAttribute("aria-expanded", String(view.pastOpen));
      toggle.textContent = "";
      appendAll(toggle, [
        view.pastOpen ? "지난 공지 접기" : `지난 공지 ${past.length}개 보기`,
        icon(view.pastOpen ? "chevronUp" : "chevronDown", 18),
      ]);
    };
    paintToggle();
    refs.body.appendChild(toggle);
    refs.body.appendChild(pastList);
  }
}

// 공지판으로 돌아왔는데 목록이 오래됐으면 뒤에서 새로 받아 다시 그린다(그동안은 지금 목록을 보여 줌).
async function refreshBoard() {
  if (refreshing) return;
  refreshing = true;
  const session = sessionGen;
  const res = await api.getBoard();
  if (session !== sessionGen) return;
  refreshing = false;
  if (!res.ok) return; // 조용히 넘어간다. AUTH_REQUIRED는 api.js가 로그인 화면으로 보낸다.
  if (screen !== "board") return; // 다른 화면으로 갔으면 다음에 공지판을 열 때 다시 받는다.
  applyBoard(res);
  noteTiming([["공지판", res.elapsedMs]]);
  renderBoardBody();
}

function openNotice(id) {
  view.scrollY = window.pageYOffset || 0;
  view.lastOpened = id;
  pushUrl(id);
  showDetail(id);
}

/* ================= 5. 공지 상세 (시안 ③) ================= */

function showDetail(id) {
  const notice = board && board.byId.get(id);
  if (!notice) {
    replaceUrl(null, BOARD_STATE);
    showBoard({ notFound: true });
    return;
  }
  beginScreen("detail");
  const closed = isClosed(notice);
  const deadline = notice.deadline ? formatDeadline(notice.deadline) : null;
  const titleEl = h("h1", { class: "detail-title", tabindex: "-1" }, notice.title || "(제목 없음)");
  const body = typeof notice.body === "string" ? notice.body.replace(/\r\n?/g, "\n") : "";

  mount(
    h(
      "header",
      { class: "bar bar-detail" },
      h("button", { type: "button", class: "back-btn", onclick: goBackToBoard }, icon("chevronLeft", 20), "공지판"),
      board.number ? h("span", { class: "me-badge me-badge-soft" }, `${board.number}번`) : null
    ),
    h(
      "div",
      { class: "page" },
      h(
        "div",
        { class: "detail-tags" },
        notice.pinned ? pinTag() : null,
        categoryTag(notice.category),
        dueBadge(notice, closed, "due-inline")
      ),
      titleEl,
      h(
        "p",
        { class: "detail-meta" },
        icon("calendar", 16),
        deadline ? `마감 ${deadline}` + (closed ? " · 지남" : "") : "마감 없음"
      ),
      closed
        ? h("p", { class: "note note-muted" }, icon("lock", 18), "마감이 지난 공지예요. 읽기만 할 수 있어요.")
        : null,
      body ? h("div", { class: "body-card" }, body) : null,
      responseSection(notice),
      timingFooter()
    )
  );
  window.scrollTo(0, 0);
  focusQuietly(titleEl);
}

function goBackToBoard() {
  if (historyState().cb === "detail") {
    // 공지판에서 들어왔거나 링크로 들어왔을 때 아래에 공지판 기록을 깔아 두었다 → 브라우저 뒤로가기와 같게.
    const gen = screenGen;
    window.history.back();
    // 어떤 앱 안 브라우저에서 뒤로가기 신호(popstate)가 오지 않을 때를 대비
    setTimeout(() => {
      if (gen === screenGen && screen === "detail") {
        replaceUrl(null, BOARD_STATE);
        showBoard({ restore: true });
      }
    }, 700);
    return;
  }
  replaceUrl(null, BOARD_STATE);
  showBoard({ restore: true });
}

function responseSection(notice) {
  const kind = kindOf(notice);
  if (kind === "READONLY") return null; // 체크 항목이 없는 공지: 읽기만
  if (!kind) {
    return h(
      "p",
      { class: "note note-muted" },
      icon("info", 18),
      "이 공지의 응답은 아직 이 화면에서 할 수 없어요. 화면을 새로고침해 보세요."
    );
  }
  const entry = getEntry(notice);
  if (kind === "CHECKLIST") return checklistCard(entry);
  if (kind === "SUBMIT") return submitCard(entry);
  return pollCard(entry);
}

function getEntry(notice) {
  let entry = entries.get(notice.id);
  if (entry) return entry;
  const kind = kindOf(notice);
  const items = itemsOf(notice);
  const memo = kind === "CHECKLIST" ? "" : initialMemo(notice);
  entry = {
    id: notice.id,
    kind, // CHECKLIST | SUBMIT | POLL
    items,
    sig: noticeSig(notice),
    memoAllowed: kind !== "CHECKLIST" && Boolean(notice.memoAllowed),
    session: sessionGen,
    // ---- 화면에 보이는(학생이 원하는) 상태. 유형마다 쓰는 칸이 다르다. ----
    checked: new Set(kind === "CHECKLIST" ? initialChecked(notice, items) : []), // 항목 체크
    submitted: initialSubmitted(notice), // 제출 표시
    choice: initialChoice(notice, items), // 투표(고른 선택지 번호, 없으면 null)
    memo, // 저장하기로 정한 메모(정리된 글자)
    draft: memo, // 메모 칸에 지금 쓰여 있는 글자(아직 저장 버튼을 안 눌렀을 수 있음)
    // ----
    saved: null, // 서버가 마지막으로 확인해 준 상태(바로 아래에서 채움)
    hadResponse: Boolean(notice.myResponse),
    closed: Boolean(notice.closed),
    inFlight: false, // 저장 요청을 보내는 중인지(재시도 대기 포함)
    phase: "idle", // idle | saving | retrying | saved | failed | closed
    error: null,
    view: null, // 상세 화면이 열려 있을 때 그 화면의 요소들
  };
  entry.saved = snapshotOf(entry);
  entries.set(notice.id, entry);
  return entry;
}

/* ---------- 응답 카드 공통 조각 ---------- */

// 저장 상태(오른쪽 위 작은 글자)와 저장 실패 안내 상자
function addSaveBits(entry, v) {
  v.save = h("span", { class: "save-state", role: "status", "aria-live": "polite" });
  v.failText = h("p", null);
  v.retry = button("btn btn-danger", "다시 시도", { before: "refresh", size: 18, onclick: () => retrySave(entry) });
  v.fail = h("div", { class: "save-fail", role: "alert", hidden: true }, v.failText, v.retry);
}

function paintPill(badge, done, closed, todoText, pastText) {
  badge.textContent = "";
  if (done) {
    badge.className = "pill pill-ok";
    appendAll(badge, [icon("check", 12), "완료"]);
  } else if (closed) {
    badge.className = "pill pill-past";
    badge.textContent = pastText;
  } else {
    badge.className = "pill pill-soon";
    badge.textContent = todoText;
  }
}

function paintFoot(foot, closed, openText, closedText) {
  foot.textContent = "";
  appendAll(foot, closed ? [icon("lock", 15), closedText] : [icon("info", 15), openText]);
}

// 키보드(Enter·Space)로 누른 버튼인지. 손가락·마우스로 누르면 detail이 1 이상이다.
function byKeyboard(e) {
  return !e || e.detail === 0;
}

/* ---------- 항목 체크 카드 (시안 ③) ---------- */

function checklistCard(entry) {
  const base = "chk" + ++idSeq;
  const v = { rows: [] };
  v.bar = h("div", { class: "check-bar" });
  v.badge = h("span", { class: "pill" });
  addSaveBits(entry, v);

  const list = h("ul", { class: "check-list" });
  entry.items.forEach((text, i) => {
    const input = h("input", { type: "checkbox", id: `${base}-${i}`, class: "check-input" });
    input.addEventListener("change", () => toggleItem(entry, i, input.checked));
    const label = h("label", { class: "check-row", for: input.id }, input, h("span", { class: "check-text" }, text));
    list.appendChild(h("li", null, label));
    v.rows.push({ input, label });
  });

  v.foot = h("p", { class: "check-foot" });

  entry.view = v;
  renderEntry(entry);
  return h(
    "section",
    { class: "check-card", "aria-labelledby": base + "-title" },
    h("div", { class: "check-track", "aria-hidden": "true" }, v.bar),
    h("div", { class: "check-head" }, h("h2", { id: base + "-title" }, "확인 체크리스트"), v.badge, v.save),
    list,
    v.fail,
    v.foot
  );
}

/* ---------- 제출 표시 카드 ---------- */

function submitCard(entry) {
  const base = "sub" + ++idSeq;
  const v = {};
  v.badge = h("span", { class: "pill" });
  addSaveBits(entry, v);

  // '낼 것' 목록(제출물 이름)
  const gives = entry.items.length
    ? h(
        "div",
        { class: "give" },
        h("p", { class: "resp-label", id: base + "-give" }, "낼 것"),
        h(
          "ul",
          { class: "give-list", "aria-labelledby": base + "-give" },
          entry.items.map((text) => h("li", { class: "give-row" }, icon("file", 18), h("span", null, text)))
        )
      )
    : null;

  v.submitBtn = button("btn btn-primary btn-lg", "제출했어요", {
    before: "checkCircle",
    onclick: () => setSubmitted(entry, true),
  });
  // 누른 뒤 같은 자리에 나오는 초록 상자(누르는 칸이 아니라서 두 번 눌러도 취소되지 않는다)
  v.doneBox = h(
    "div",
    { class: "submit-done", tabindex: "-1" },
    h("span", { class: "submit-done-icon" }, icon("check", 20)),
    "제출했어요"
  );
  v.noneBox = h("p", { class: "submit-none" }, icon("lock", 18), "제출 표시를 하지 않았어요");
  v.cancelBtn = button("btn btn-sub", "제출 취소", { before: "undo", size: 18, onclick: () => setSubmitted(entry, false) });
  v.undoRow = h("div", { class: "undo-row" }, h("span", null, "잘못 눌렀다면"), v.cancelBtn);

  v.memo = entry.memoAllowed
    ? memoBlock(entry, base, {
        label: "한 줄 메모",
        save: "메모 저장",
        pending: "[제출했어요]를 누르면 메모도 함께 저장돼요.",
        readLabel: "내 메모",
      })
    : null;
  v.foot = h("p", { class: "resp-foot" });

  entry.view = v;
  renderEntry(entry);
  return h(
    "section",
    { class: "check-card resp-card", "aria-labelledby": base + "-title" },
    h("div", { class: "check-head" }, h("h2", { id: base + "-title" }, "제출 표시"), v.badge, v.save),
    gives,
    v.submitBtn,
    v.doneBox,
    v.noneBox,
    v.undoRow,
    v.memo ? v.memo.el : null,
    v.fail,
    v.foot
  );
}

/* ---------- 투표 카드 (시안 ④) ---------- */

function pollCard(entry) {
  const base = "poll" + ++idSeq;
  const v = { tiles: [] };
  v.badge = h("span", { class: "pill" });
  addSaveBits(entry, v);
  v.heading = h("h2", { id: base + "-title" }, "하나를 고르세요");

  // 선택지가 모두 짧으면 2열 타일, 하나라도 길면 1열 목록
  const short = entry.items.every((text) => text.length <= SHORT_CHOICE);
  const group = h("div", {
    role: "radiogroup",
    "aria-labelledby": base + "-title",
    class: "poll-grid" + (short ? "" : " is-list"),
  });
  entry.items.forEach((text, i) => {
    const input = h("input", { type: "radio", name: base, id: `${base}-${i}`, class: "poll-input" });
    input.addEventListener("change", () => {
      if (input.checked) choose(entry, i);
    });
    const label = h("label", { class: "poll-tile", for: input.id }, input, h("span", { class: "poll-text" }, text));
    group.appendChild(label);
    v.tiles.push({ input, label });
  });

  v.clearBtn = button("btn btn-sub btn-clear", "선택 지우기", { before: "close", size: 18, onclick: (e) => clearChoice(entry, e) });
  v.noneBox = h("p", { class: "submit-none" }, icon("lock", 18), "고르지 않았어요");
  v.memo = entry.memoAllowed
    ? memoBlock(entry, base, {
        label: "의견 한 줄",
        save: "의견 저장",
        pending: "선택지를 고르면 의견도 함께 저장돼요.",
        readLabel: "내 의견",
      })
    : null;
  v.foot = h("p", { class: "resp-foot" });

  entry.view = v;
  renderEntry(entry);
  return h(
    "section",
    { class: "check-card resp-card", "aria-labelledby": base + "-title" },
    h("div", { class: "check-head" }, v.heading, v.badge, v.save),
    group,
    v.noneBox,
    v.clearBtn,
    v.memo ? v.memo.el : null,
    v.fail,
    v.foot
  );
}

/* ---------- 한 줄 메모·의견 칸 ---------- */

function memoBlock(entry, base, text) {
  const id = base + "-memo";
  const input = h("input", {
    id,
    type: "text",
    class: "memo-input",
    maxlength: String(MEMO_MAX),
    autocomplete: "off",
    enterkeyhint: "done",
    placeholder: "개인정보는 쓰지 마세요",
    "aria-describedby": id + "-hint " + id + "-count",
  });
  input.value = entry.draft;
  const count = h("span", { id: id + "-count", class: "memo-count" });
  const save = button("btn btn-primary btn-memo", text.save, { onclick: (e) => saveMemo(entry, e) });
  const pending = h("p", { class: "memo-pending" }, icon("info", 15), text.pending);
  const readText = h("p", { class: "memo-read-text" });
  const read = h("div", { class: "memo-read" }, h("p", { class: "resp-label" }, text.readLabel), readText);
  const edit = h(
    "div",
    { class: "memo" },
    h(
      "label",
      { class: "memo-label", for: id },
      text.label + " ",
      h("span", { class: "field-label-sub" }, `(선택 · ${MEMO_MAX}자)`)
    ),
    input,
    h(
      "div",
      { class: "memo-meta" },
      h("span", { id: id + "-hint" }, "이름·연락처 같은 개인정보는 쓰지 마세요."),
      count
    ),
    pending,
    save
  );
  input.addEventListener("input", () => {
    entry.draft = input.value;
    renderMemo(entry);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter는 그냥 둔다
    e.preventDefault();
    if (!save.hidden) saveMemo(entry, null);
  });
  return { el: h("div", { class: "memo-wrap" }, edit, read), edit, input, count, save, pending, read, readText };
}

function renderMemo(entry) {
  const m = entry.view && entry.view.memo;
  if (!m) return;
  const primaryDone = entry.kind === "SUBMIT" ? entry.submitted : entry.choice !== null;
  m.edit.hidden = entry.closed;
  // 마감 뒤에는 저장된 메모를 글자로만 보여 준다(없으면 칸을 숨김).
  m.read.hidden = !entry.closed || !entry.memo;
  m.readText.textContent = entry.memo;
  const len = m.input.value.length;
  m.count.textContent = `${len}/${MEMO_MAX}`;
  m.count.classList.toggle("is-over", len > MEMO_MAX);
  const dirty = !entry.closed && normalizeMemo(entry.draft) !== entry.memo;
  // 제출(또는 선택)한 뒤 메모를 고치면 [메모 저장]. 그 전이면 제출·선택 때 함께 저장된다고 알려 준다.
  m.save.hidden = !(dirty && primaryDone);
  m.pending.hidden = !(dirty && !primaryDone);
}

// 메모 칸의 글자를 '저장하기로 정한 메모'로 확정한다(서버와 같은 규칙으로 정리).
function commitDraft(entry) {
  if (!entry.memoAllowed) return;
  entry.memo = normalizeMemo(entry.draft);
  entry.draft = entry.memo;
  const m = entry.view && entry.view.memo;
  if (m && m.input.value !== entry.memo) m.input.value = entry.memo;
}

/* ================= 응답 저장: 기다리지 않는 저장 (항목 체크·제출 표시·투표 공통) =================
 * - 누르면 화면은 즉시 바뀌고, 저장은 뒤에서 한다.
 * - 공지 하나당 요청은 한 번에 하나만 보낸다.
 * - 요청이 끝났을 때 화면 상태가 마지막으로 보낸 것과 다르면, 최신 상태 전체를 다시 보낸다.
 *   (그래서 서버에 마지막으로 기록되는 것은 항상 화면의 최신 상태다)
 * - 실패하면 1.5초 뒤 한 번 더 시도하고, 그래도 실패하면 '저장 안 됨'과 [다시 시도]를 보여 준다.
 * - 저장 중에 공지판으로 돌아가도 저장은 계속된다(상태는 로그인 동안 entries에 남는다).
 */

// 지금 화면 상태를 서버에 보낼 모양으로 찍어 둔다.
function snapshotOf(entry) {
  if (entry.kind === "CHECKLIST") return { checked: sortedList(entry.checked) };
  if (entry.kind === "SUBMIT") return { submitted: entry.submitted, memo: entry.memo };
  return { choice: entry.choice, memo: entry.memo };
}

function sameSnapshot(a, b) {
  if (a.checked || b.checked) return Boolean(a.checked && b.checked) && sameList(a.checked, b.checked);
  return a.submitted === b.submitted && a.choice === b.choice && a.memo === b.memo;
}

// 마감으로 저장이 거절됐을 때: 서버에 마지막으로 저장된 상태로 화면을 되돌린다.
function restoreSnapshot(entry, snap) {
  if (entry.kind === "CHECKLIST") {
    entry.checked = new Set(snap.checked);
    return;
  }
  if (entry.kind === "SUBMIT") entry.submitted = snap.submitted;
  else entry.choice = snap.choice;
  entry.memo = snap.memo;
  entry.draft = snap.memo;
  const m = entry.view && entry.view.memo;
  if (m) m.input.value = snap.memo;
}

function sendSnapshot(entry, snap) {
  const memo = entry.memoAllowed ? snap.memo : null; // 메모를 받지 않는 공지에는 memo를 아예 넣지 않는다
  if (entry.kind === "CHECKLIST") return api.saveChecklist(entry.id, snap.checked);
  if (entry.kind === "SUBMIT") return api.saveSubmit(entry.id, snap.submitted, memo);
  return api.savePoll(entry.id, snap.choice, memo);
}

// 학생이 응답을 바꿀 때마다: 화면을 먼저 바꾸고 저장을 건다. 바꿀 수 없는 상태면 false.
function changeEntry(entry, apply) {
  if (entry.closed || entry.session !== sessionGen) {
    renderEntry(entry);
    return false;
  }
  apply();
  if (!entry.inFlight) {
    entry.phase = "idle";
    entry.error = null;
  }
  renderEntry(entry);
  requestSave(entry);
  return true;
}

function toggleItem(entry, index, on) {
  changeEntry(entry, () => {
    if (on) entry.checked.add(index);
    else entry.checked.delete(index);
  });
}

function setSubmitted(entry, on) {
  const changed = changeEntry(entry, () => {
    entry.submitted = on;
    commitDraft(entry); // 칸에 써 둔 메모도 함께 보낸다
  });
  // 누른 버튼이 사라지므로 초점을 옮긴다: 제출 → 초록 상자, 취소 → [제출했어요]
  const v = entry.view;
  if (changed && v) focusQuietly(on ? v.doneBox : v.submitBtn);
}

function choose(entry, index) {
  if (entry.choice === index) return;
  changeEntry(entry, () => {
    entry.choice = index;
    commitDraft(entry); // 칸에 써 둔 의견도 함께 보낸다
  });
}

function clearChoice(entry, e) {
  const changed = changeEntry(entry, () => {
    entry.choice = null;
    commitDraft(entry);
  });
  // [선택 지우기]가 사라지므로, 키보드로 눌렀다면 첫 선택지로 초점을 옮긴다.
  const v = entry.view;
  if (changed && v && v.tiles.length && byKeyboard(e)) focusQuietly(v.tiles[0].input);
}

function saveMemo(entry, e) {
  if (normalizeMemo(entry.draft) === entry.memo) {
    // 앞뒤 공백만 바뀐 경우: 보낼 것 없이 칸만 정리한다.
    commitDraft(entry);
    renderEntry(entry);
    return;
  }
  const changed = changeEntry(entry, () => commitDraft(entry));
  // [메모 저장]이 사라지므로, 키보드로 눌렀다면 메모 칸으로 초점을 돌려 둔다(손가락이면 자판이 뜨지 않게 그대로).
  const m = entry.view && entry.view.memo;
  if (changed && m && byKeyboard(e)) focusQuietly(m.input);
}

function retrySave(entry) {
  if (entry.inFlight || entry.closed) return;
  entry.phase = "idle";
  entry.error = null;
  requestSave(entry);
}

function requestSave(entry) {
  // 이미 보내는 중이면 기다린다. 그 요청이 끝날 때 최신 상태를 다시 보낸다.
  if (entry.inFlight) return;
  sendLatest(entry, 1);
}

async function sendLatest(entry, attempt) {
  const snap = snapshotOf(entry);
  entry.inFlight = true;
  entry.phase = attempt === 1 ? "saving" : "retrying";
  renderEntry(entry);

  const res = await sendSnapshot(entry, snap);
  if (entry.session !== sessionGen) return; // 그사이 로그아웃·다시 로그인함

  if (res.ok) {
    entry.saved = snap;
    entry.hadResponse = true;
    entry.error = null;
    noteTiming([["저장", res.elapsedMs]]);
    if (!sameSnapshot(snap, snapshotOf(entry))) {
      // 보내는 동안 학생이 또 바꿨다 → 최신 상태 전체를 다시 보낸다.
      sendLatest(entry, 1);
      return;
    }
    entry.inFlight = false;
    entry.phase = "saved";
    renderEntry(entry);
    return;
  }

  if (res.error === "AUTH_REQUIRED") return; // api.js가 로그인 화면으로 보낸다.

  if (res.error === "CLOSED") {
    // 마감됨: 서버에 마지막으로 저장된 상태로 되돌리고 더는 바꾸지 못하게 한다.
    entry.inFlight = false;
    entry.closed = true;
    restoreSnapshot(entry, entry.saved);
    entry.phase = "closed";
    renderEntry(entry);
    if (screen === "board") renderBoardBody();
    return;
  }

  if (attempt === 1 && isRetryable(res)) {
    entry.phase = "retrying";
    renderEntry(entry);
    await sleep(RETRY_DELAY_MS);
    if (entry.session !== sessionGen) return;
    sendLatest(entry, 2); // 기다리는 동안 또 바꿨다면 그 최신 상태를 보낸다.
    return;
  }

  entry.inFlight = false;
  entry.phase = "failed";
  entry.error = res;
  renderEntry(entry);
  if (screen === "board") renderBoardBody(); // 공지판 카드에 '저장 안 됨' 표시
}

/* ---------- 화면 다시 그리기 ---------- */

function renderEntry(entry) {
  const v = entry.view;
  if (!v) return;
  if (entry.kind === "CHECKLIST") renderChecklist(entry, v);
  else if (entry.kind === "SUBMIT") renderSubmit(entry, v);
  else renderPoll(entry, v);
  renderSaveState(entry, v);
}

function renderChecklist(entry, v) {
  const total = entry.items.length;
  const count = entry.checked.size;
  const done = count === total;

  v.rows.forEach((row, i) => {
    const on = entry.checked.has(i);
    row.input.checked = on;
    row.input.disabled = entry.closed;
    row.label.classList.toggle("is-on", on);
    row.label.classList.toggle("is-locked", entry.closed);
  });

  v.bar.style.width = (total ? Math.round((count / total) * 100) : 0) + "%";
  v.bar.classList.toggle("is-done", done);

  v.badge.textContent = "";
  if (done) {
    v.badge.className = "pill pill-ok";
    appendAll(v.badge, [icon("check", 12), "완료"]);
  } else if (entry.closed) {
    v.badge.className = "pill pill-past";
    v.badge.textContent = `${count}/${total} 체크`;
  } else {
    v.badge.className = "pill pill-soon";
    v.badge.textContent = `${total - count}개 남음`;
  }

  v.foot.textContent = "";
  if (entry.closed) {
    appendAll(v.foot, [icon("lock", 15), "마감이 지나 체크를 바꿀 수 없어요."]);
  } else {
    appendAll(v.foot, [icon("info", 15), "모두 체크하면 담임 선생님께 확인 완료로 표시돼요."]);
  }
}

function renderSubmit(entry, v) {
  const on = entry.submitted;
  v.submitBtn.hidden = on || entry.closed;
  v.doneBox.hidden = !on;
  v.noneBox.hidden = on || !entry.closed;
  v.undoRow.hidden = !on || entry.closed; // 마감 뒤에는 바꾸는 버튼을 숨긴다
  paintPill(v.badge, on, entry.closed, "제출 전", "표시 안 함");
  renderMemo(entry);
  paintFoot(
    v.foot,
    entry.closed,
    "실제로 낸 뒤에 눌러 주세요. 마감 전까지 취소할 수 있어요.",
    "마감이 지나 제출 표시를 바꿀 수 없어요."
  );
}

function renderPoll(entry, v) {
  v.tiles.forEach((tile, i) => {
    const on = entry.choice === i;
    tile.input.checked = on;
    tile.input.disabled = entry.closed;
    tile.label.classList.toggle("is-on", on);
    tile.label.classList.toggle("is-locked", entry.closed);
  });
  v.heading.textContent = entry.closed ? "내 선택" : "하나를 고르세요";
  v.clearBtn.hidden = entry.choice === null || entry.closed; // 마감 뒤에는 바꾸는 버튼을 숨긴다
  v.noneBox.hidden = !(entry.closed && entry.choice === null);
  paintPill(v.badge, entry.choice !== null, entry.closed, "고르기 전", "고르지 않음");
  renderMemo(entry);
  paintFoot(
    v.foot,
    entry.closed,
    "마감 전까지 바꿀 수 있어요. 다른 친구의 선택과 결과는 보이지 않아요.",
    "마감이 지나 바꿀 수 없어요. 다른 친구의 선택과 결과는 보이지 않아요."
  );
}

// 저장 상태(작게, 오른쪽 위)와 저장 실패 안내
function renderSaveState(entry, v) {
  let saveText = "";
  let saveIcon = null;
  let saveBad = false;
  if (entry.phase === "saving") saveText = "저장 중…";
  else if (entry.phase === "retrying") saveText = "다시 저장하는 중…";
  else if (entry.phase === "failed" || entry.phase === "closed") {
    saveText = "저장 안 됨";
    saveBad = true;
  } else if (entry.phase === "saved" || (entry.phase === "idle" && entry.hadResponse)) {
    saveText = "저장됨";
    saveIcon = "check";
  } else if (entry.closed) {
    saveText = "읽기 전용";
    saveIcon = "lock";
  }
  v.save.textContent = "";
  if (saveText) appendAll(v.save, [saveIcon ? icon(saveIcon, 13) : null, saveText]);
  v.save.classList.toggle("is-bad", saveBad);

  let failText = "";
  if (entry.phase === "failed") failText = saveFailText(entry.error);
  else if (entry.phase === "closed") {
    failText =
      entry.kind === "CHECKLIST"
        ? "마감이 지나서 저장하지 못했어요. 이제 체크를 바꿀 수 없어요."
        : "마감이 지나서 저장하지 못했어요. 마지막으로 저장된 응답을 보여 드려요.";
  }
  v.fail.hidden = !failText;
  v.failText.textContent = failText;
  v.retry.hidden = !(entry.phase === "failed" && isRetryable(entry.error));
}

/* ================= 시작 ================= */

function start() {
  try {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
  } catch (e) {
    // 없어도 된다
  }
  if (!api.isConfigured()) {
    showSetupNeeded();
    return;
  }
  api.onAuthRequired((info) => {
    if (screen === "login") return;
    const message = (info && info.message) || "로그인이 풀렸어요. 다시 로그인해 주세요.";
    resetSession();
    // 선생님이 비밀번호를 초기화한 경우: 등록이 열려 있으면 [처음 등록] 탭을 바로 보여 준다.
    // 주소의 ?n=는 그대로 두어, 다시 로그인하면 보던 공지가 열린다.
    showLogin({ message, tone: "info", preferRegister: message.indexOf("초기화") !== -1 });
  });
  window.addEventListener("popstate", onPopState);
  if (api.hasSession()) enterApp(null);
  else showLogin(null);
}

start();
