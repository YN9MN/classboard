// 학생 화면 로직 (단계 0: 처음 등록 · 로그인 · 항목 체크)
// 서버와 주고받는 일은 전부 api.js가 맡고, 이 파일은 화면만 다룬다.

import * as api from "./api.js";

const app = document.getElementById("app");
const RETRY_DELAY_MS = 1500; // 저장 실패 후 자동으로 한 번 더 시도하기까지 기다리는 시간

let screen = ""; // 지금 보이는 화면: "setup" | "login" | "board"
// 화면을 바꿀 때마다 1씩 늘린다. 늦게 도착한 서버 답이 이미 사라진 화면을 건드리지 않게 하는 표시.
let screenGen = 0;
let regInfo = null; // 처음 등록 정보 { open, from, to }
let idSeq = 0;

/* ================= 작은 도우미 ================= */

// 화면 요소 만들기. 서버에서 온 글은 항상 글자(textContent)로만 넣는다.
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
  window.scrollTo(0, 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seconds(ms) {
  return (Math.max(0, ms) / 1000).toFixed(2) + "초";
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

// 한국은 서머타임이 없어 UTC+9로 바로 바꿀 수 있다.
function kst(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 9 * 60 * 60 * 1000);
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
      placeholder: "숫자만 입력",
      value: value || null,
    })
  );
}

function pinInput(id) {
  return digitsOnly(
    h("input", {
      id,
      type: "password",
      inputmode: "numeric",
      pattern: "[0-9]*",
      maxlength: "4",
      autocomplete: "off",
      placeholder: "숫자 4자리",
    })
  );
}

function field(labelText, input, hint) {
  return h(
    "div",
    { class: "field" },
    h("label", { for: input.id }, labelText),
    input,
    hint ? h("p", { class: "hint" }, hint) : null
  );
}

function msgBox() {
  return h("p", { class: "msg", role: "status", "aria-live": "polite" });
}

function say(box, text, tone) {
  box.className = "msg msg-" + (tone || "error");
  box.textContent = text;
}

function setBusy(button, busyText) {
  button.dataset.label = button.textContent;
  button.textContent = busyText;
  button.disabled = true;
}

function clearBusy(button) {
  button.textContent = button.dataset.label || button.textContent;
  button.disabled = false;
}

function topbar(right) {
  return h(
    "header",
    { class: "topbar" },
    h("h1", { class: "brand" }, "우리 반 공지판"),
    right ? h("div", { class: "topbar-right" }, right) : null
  );
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
      return "이 공지를 찾을 수 없어요. 화면을 새로고침해 주세요.";
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
  screen = "setup";
  screenGen++;
  mount(
    topbar(null),
    h(
      "section",
      { class: "card" },
      h("h2", { class: "card-title" }, "설정이 필요해요"),
      h("p", null, "서버 주소가 아직 들어 있지 않아요."),
      h(
        "p",
        { class: "muted" },
        "선생님: frontend/config.js 파일의 API_URL에 Apps Script 웹 앱 주소를 넣어 주세요."
      ),
      h("p", { class: "muted" }, "학생: 이 화면이 보이면 선생님께 알려 주세요.")
    )
  );
}

/* ================= 2. 로그인 · 처음 등록 ================= */

function showLogin(opts) {
  screen = "login";
  const gen = ++screenGen;
  const saved = api.getSavedNumber();

  // --- 로그인 ---
  const loginNumber = numberInput("login-number", saved);
  const loginPin = pinInput("login-pin");
  const loginBtn = h("button", { type: "submit", class: "btn" }, "로그인");
  const loginMsg = msgBox();
  const regHint = h(
    "p",
    { class: "hint hint-center", hidden: true },
    "처음이라면 위의 [처음 등록]을 눌러 비밀번호를 먼저 정하세요."
  );
  const loginPanel = h(
    "form",
    {
      id: "panel-login",
      role: "tabpanel",
      "aria-labelledby": "tab-login",
      class: "form",
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        submitLogin();
      },
    },
    field("번호", loginNumber),
    field("비밀번호", loginPin),
    loginBtn,
    loginMsg,
    regHint
  );

  // --- 처음 등록 ---
  const regRange = h("p", { class: "msg msg-info" }, "처음 등록을 받고 있어요.");
  const regNumber = numberInput("reg-number", null);
  const regPin = pinInput("reg-pin");
  const regPin2 = pinInput("reg-pin2");
  const regBtn = h("button", { type: "submit", class: "btn" }, "등록하기");
  const regMsg = msgBox();
  const regPanel = h(
    "form",
    {
      id: "panel-reg",
      role: "tabpanel",
      "aria-labelledby": "tab-reg",
      class: "form",
      novalidate: true,
      hidden: true,
      onsubmit: (e) => {
        e.preventDefault();
        submitRegister();
      },
    },
    regRange,
    field("번호", regNumber),
    field(
      "비밀번호 정하기",
      regPin,
      "숫자 4자리. 같은 숫자(1111)나 연속 숫자(1234)는 안 돼요. 친구에게 알려 주지 마세요."
    ),
    field("비밀번호 한 번 더", regPin2),
    regBtn,
    regMsg
  );

  // --- 탭: 처음 등록이 열려 있을 때만 보인다 ---
  const tabLogin = h(
    "button",
    {
      type: "button",
      role: "tab",
      id: "tab-login",
      class: "tab",
      "aria-controls": "panel-login",
      "aria-selected": "true",
      onclick: () => selectTab("login"),
    },
    "로그인"
  );
  const tabReg = h(
    "button",
    {
      type: "button",
      role: "tab",
      id: "tab-reg",
      class: "tab",
      "aria-controls": "panel-reg",
      "aria-selected": "false",
      onclick: () => selectTab("reg"),
    },
    "처음 등록"
  );
  const tabs = h("div", { class: "tabs", role: "tablist", hidden: true }, tabLogin, tabReg);

  function selectTab(name) {
    const isReg = name === "reg";
    tabLogin.setAttribute("aria-selected", String(!isReg));
    tabReg.setAttribute("aria-selected", String(isReg));
    loginPanel.hidden = isReg;
    regPanel.hidden = !isReg;
  }

  let preferApplied = false;
  function applyRegInfo() {
    const open = Boolean(regInfo && regInfo.open);
    tabs.hidden = !open;
    regHint.hidden = !open;
    if (!open) {
      selectTab("login");
      return;
    }
    if (regInfo.from != null && regInfo.to != null) {
      regRange.textContent = `지금 ${regInfo.from}~${regInfo.to}번 학생의 처음 등록을 받고 있어요.`;
      regNumber.placeholder = `예: ${regInfo.from}`;
    }
    // 비밀번호가 초기화돼 다시 등록해야 하는 경우, 처음 한 번만 [처음 등록] 탭으로 옮기고 번호를 채워 둔다.
    if (opts && opts.preferRegister && !preferApplied) {
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
      showBoard({ label: "로그인", elapsedMs: res.elapsedMs });
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
      showBoard({ label: "등록", elapsedMs: res.elapsedMs });
      return;
    }
    if (res.error === "WEAK_PIN" || res.error === "BAD_PIN") {
      regPin.value = "";
      regPin2.value = "";
    }
    if (res.error === "REG_CLOSED") {
      regInfo = { open: false, from: null, to: null };
      applyRegInfo();
      say(loginMsg, errorText(res));
      return;
    }
    say(regMsg, errorText(res));
  }

  mount(
    topbar(null),
    h(
      "section",
      { class: "card" },
      h("p", { class: "lead" }, "번호와 비밀번호(숫자 4자리)로 로그인하세요. 한 번 로그인하면 이 휴대폰에서는 계속 유지돼요."),
      tabs,
      loginPanel,
      regPanel
    ),
    h("p", { class: "footnote" }, "비밀번호를 잊었으면 선생님께 초기화를 부탁하세요.")
  );

  if (opts && opts.message) say(loginMsg, opts.message, opts.tone || "info");

  // 처음 등록이 열려 있는지 확인(기다리지 않고 로그인 칸은 바로 쓸 수 있다)
  if (regInfo) applyRegInfo();
  api.getRegInfo().then((res) => {
    if (gen !== screenGen) return;
    regInfo = res.ok ? { open: Boolean(res.open), from: res.from, to: res.to } : null;
    applyRegInfo();
  });
}

/* ================= 3. 공지판 ================= */

async function showBoard(intro) {
  screen = "board";
  const gen = ++screenGen;
  const saved = api.getSavedNumber();

  const who = h("span", { class: "who" }, saved ? `${saved}번` : "");
  const logoutBtn = h("button", { type: "button", class: "btn-small", onclick: logout }, "로그아웃");
  const timing = h("p", { class: "timing" });
  const list = h(
    "div",
    { class: "notices", "aria-busy": "true" },
    h("p", { class: "loading" }, "공지를 불러오는 중…")
  );
  const storageWarn = api.canRememberLogin()
    ? null
    : h(
        "p",
        { class: "msg msg-warn" },
        "이 브라우저는 로그인을 기억하지 못해요. 창을 닫으면 다시 로그인해야 해요."
      );

  if (intro) timing.textContent = `${intro.label} 서버 응답 ${seconds(intro.elapsedMs)}`;
  mount(topbar([who, logoutBtn]), storageWarn, timing, list);

  const res = await api.getBoard();
  if (gen !== screenGen) return; // 로그아웃했거나 로그인 화면으로 넘어감(AUTH_REQUIRED)
  list.removeAttribute("aria-busy");
  list.textContent = "";

  if (!res.ok) {
    list.appendChild(
      h(
        "div",
        { class: "card" },
        h("p", { class: "msg msg-error", role: "alert" }, "공지를 불러오지 못했어요. " + errorText(res)),
        h("button", { type: "button", class: "btn", onclick: () => showBoard(intro) }, "다시 불러오기")
      )
    );
    return;
  }

  if (res.number != null) who.textContent = `${res.number}번`;
  timing.textContent =
    (intro ? `${intro.label} 서버 응답 ${seconds(intro.elapsedMs)} · ` : "") +
    `공지판 불러오기 ${seconds(res.elapsedMs)}`;

  const notices = Array.isArray(res.notices) ? res.notices : [];
  if (!notices.length) {
    list.appendChild(h("p", { class: "empty" }, "지금 볼 공지가 없어요."));
    return;
  }
  notices.forEach((notice) => list.appendChild(buildNoticeCard(notice, gen)));
}

function logout() {
  api.clearSession();
  showLogin({ message: "로그아웃했어요.", tone: "info" });
}

function buildNoticeCard(notice, gen) {
  const items = Array.isArray(notice.items) ? notice.items.map(String) : [];
  const deadline = notice.deadline ? formatDeadline(notice.deadline) : null;

  const card = h(
    "article",
    { class: "card notice" },
    h(
      "div",
      { class: "notice-tags" },
      notice.category ? h("span", { class: "tag" }, notice.category) : null,
      notice.closed ? h("span", { class: "tag tag-closed" }, "마감") : null
    ),
    h("h2", { class: "notice-title" }, notice.title || "(제목 없음)"),
    deadline ? h("p", { class: notice.closed ? "deadline deadline-past" : "deadline" }, `마감 ${deadline}`) : null,
    notice.body ? h("p", { class: "notice-body" }, notice.body) : null
  );

  if (notice.type === "CHECKLIST" && items.length) {
    card.appendChild(buildChecklist(notice, items, gen));
  }
  return card;
}

/* ================= 항목 체크: 기다리지 않는 저장 =================
 * - 누르면 화면은 즉시 바뀌고, 저장은 뒤에서 한다.
 * - 공지 하나당 요청은 한 번에 하나만 보낸다.
 * - 요청이 끝났을 때 화면 상태가 마지막으로 보낸 것과 다르면, 최신 전체 목록을 다시 보낸다.
 *   (그래서 서버에 마지막으로 기록되는 것은 항상 화면의 최신 상태다)
 * - 실패하면 1.5초 뒤 한 번 더 시도하고, 그래도 실패하면 '저장 안 됨'으로 표시한다.
 */

function buildChecklist(notice, items, gen) {
  const mine = notice.myResponse && Array.isArray(notice.myResponse.checked) ? notice.myResponse.checked : [];
  const initial = sortedList(
    new Set(mine.filter((i) => Number.isInteger(i) && i >= 0 && i < items.length))
  );

  const entry = {
    id: notice.id,
    items,
    gen,
    checked: new Set(initial), // 화면에 보이는(학생이 원하는) 상태
    saved: initial, // 서버가 마지막으로 확인해 준 상태
    closed: Boolean(notice.closed),
    inFlight: false, // 저장 요청을 보내는 중인지(재시도 대기 포함)
    phase: "idle", // idle | saving | retrying | saved | failed | closed
    error: null,
    elapsedMs: null,
    rows: [],
  };

  const base = "chk" + ++idSeq;
  const list = h("ul", { class: "checklist" });
  items.forEach((text, i) => {
    const input = h("input", { type: "checkbox", id: `${base}-${i}`, class: "check-input" });
    input.addEventListener("change", () => toggleItem(entry, i, input.checked));
    const li = h(
      "li",
      { class: "check-row" },
      h("label", { class: "check-label", for: input.id }, input, h("span", { class: "check-text" }, text))
    );
    list.appendChild(li);
    entry.rows.push({ li, input });
  });

  entry.badge = h("span", { class: "badge" });
  entry.status = h("span", { class: "status", role: "status", "aria-live": "polite" });
  entry.retryBtn = h(
    "button",
    { type: "button", class: "btn-small", hidden: true, onclick: () => retrySave(entry) },
    "다시 시도"
  );

  entry.guide = h("p", { class: "response-guide" });
  const section = h(
    "section",
    { class: "response", "aria-label": "확인 체크" },
    entry.guide,
    list,
    h("div", { class: "check-footer" }, entry.badge, entry.status, entry.retryBtn)
  );
  renderEntry(entry);
  return section;
}

function toggleItem(entry, index, on) {
  if (entry.closed) {
    renderEntry(entry);
    return;
  }
  if (on) entry.checked.add(index);
  else entry.checked.delete(index);
  if (!entry.inFlight) {
    entry.phase = "idle";
    entry.error = null;
  }
  renderEntry(entry);
  requestSave(entry);
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
  const snapshot = sortedList(entry.checked);
  entry.inFlight = true;
  entry.phase = attempt === 1 ? "saving" : "retrying";
  renderEntry(entry);

  const res = await api.saveChecklist(entry.id, snapshot);
  if (entry.gen !== screenGen) return; // 그사이 로그아웃 등으로 화면이 바뀜

  if (res.ok) {
    entry.saved = snapshot;
    entry.elapsedMs = res.elapsedMs;
    entry.error = null;
    if (!sameList(snapshot, sortedList(entry.checked))) {
      // 보내는 동안 학생이 또 눌렀다 → 최신 전체 목록을 다시 보낸다.
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
    entry.checked = new Set(entry.saved);
    entry.phase = "closed";
    renderEntry(entry);
    return;
  }

  if (attempt === 1 && isRetryable(res)) {
    entry.phase = "retrying";
    renderEntry(entry);
    await sleep(RETRY_DELAY_MS);
    if (entry.gen !== screenGen) return;
    sendLatest(entry, 2); // 기다리는 동안 또 눌렀다면 그 최신 상태를 보낸다.
    return;
  }

  entry.inFlight = false;
  entry.phase = "failed";
  entry.error = res;
  renderEntry(entry);
}

function renderEntry(entry) {
  const current = sortedList(entry.checked);
  entry.guide.textContent = entry.closed
    ? "마감된 공지예요. 체크를 바꿀 수 없어요."
    : "읽고 확인한 항목을 하나씩 체크하세요.";
  entry.rows.forEach((row, i) => {
    const on = entry.checked.has(i);
    row.input.checked = on;
    row.input.disabled = entry.closed;
    row.li.classList.toggle("is-checked", on);
  });

  const total = entry.items.length;
  const allChecked = current.length === total;
  const synced = !entry.inFlight && sameList(entry.saved, current);

  let badgeText;
  let badgeKind;
  if (entry.phase === "failed") {
    badgeText = "저장 안 됨";
    badgeKind = "bad";
  } else if (allChecked && synced) {
    badgeText = "완료";
    badgeKind = "done";
  } else if (allChecked) {
    badgeText = "완료"; // 저장 확인 전: 옅은 초록
    badgeKind = "pending";
  } else {
    badgeText = `${current.length} / ${total}`;
    badgeKind = "neutral";
  }
  entry.badge.textContent = badgeText;
  entry.badge.className = "badge badge-" + badgeKind;

  let statusText = "";
  let statusKind = "";
  if (entry.phase === "saving") {
    statusText = "저장 중…";
  } else if (entry.phase === "retrying") {
    statusText = "저장이 안 돼서 다시 시도하는 중…";
  } else if (entry.phase === "saved") {
    statusText = `저장됨 · 서버 응답 ${seconds(entry.elapsedMs)}`;
  } else if (entry.phase === "failed") {
    statusText = saveFailText(entry.error);
    statusKind = "error";
  } else if (entry.phase === "closed") {
    statusText = "마감이 지나서 저장하지 못했어요. 이제 체크를 바꿀 수 없어요.";
    statusKind = "error";
  }
  entry.status.textContent = statusText;
  entry.status.className = "status" + (statusKind ? " status-" + statusKind : "");
  entry.retryBtn.hidden = !(entry.phase === "failed" && isRetryable(entry.error));
}

/* ================= 시작 ================= */

function start() {
  if (!api.isConfigured()) {
    showSetupNeeded();
    return;
  }
  api.onAuthRequired((info) => {
    if (screen === "login") return;
    const message = (info && info.message) || "로그인이 풀렸어요. 다시 로그인해 주세요.";
    // 선생님이 비밀번호를 초기화한 경우: 등록이 열려 있으면 [처음 등록] 탭을 바로 보여 준다.
    showLogin({ message, tone: "info", preferRegister: message.indexOf("초기화") !== -1 });
  });
  if (api.hasSession()) showBoard(null);
  else showLogin(null);
}

start();
