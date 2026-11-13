// 서버와 주고받는 일은 전부 이 파일 한 곳에서 한다.
// 나중에 저장소를 Supabase 등으로 바꾸면 이 파일만 고치고, 화면 코드(app.js)는 그대로 쓴다.
// 서버와의 약속은 docs/api.md를 따른다. (단계 3: 제출 표시·투표 저장 더함)
//
// 모든 함수는 서버 답을 그대로 돌려주되, 걸린 시간(elapsedMs, 밀리초)을 덧붙인다.
//   성공: { ok: true, ..., elapsedMs }
//   실패: { ok: false, error: "오류코드", ..., elapsedMs }
// 서버까지 가지 못한 실패는 이 파일이 만든 오류코드로 알려 준다.
//   NETWORK      인터넷이 끊겼거나 서버에 닿지 못함
//   TIMEOUT      30초 안에 답이 오지 않음
//   BAD_RESPONSE 서버 답이 JSON이 아님(주소가 틀렸거나 서버 설정 문제)

import { API_URL } from "./config.js";

const TOKEN_KEY = "classboard.token";
const NUMBER_KEY = "classboard.number";
const TIMEOUT_MS = 30000;

// 브라우저 저장소(localStorage)를 못 쓰는 환경에서는 창이 열려 있는 동안만 여기에 둔다.
const memory = { token: null, number: null };
let authRequiredHandler = null;

/* ---------- 브라우저 저장소: 모든 접근을 try/catch로 감싼다 ---------- */

function readStore(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function removeStore(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (e) {
    // 지울 수 없어도 화면은 계속 동작한다.
  }
}

function getToken() {
  const stored = readStore(TOKEN_KEY);
  return stored || memory.token;
}

function saveSession(token, number) {
  memory.token = writeStore(TOKEN_KEY, token) ? null : token;
  memory.number = writeStore(NUMBER_KEY, String(number)) ? null : String(number);
}

/** 서버 주소(config.js의 API_URL)가 들어 있는지 */
export function isConfigured() {
  return typeof API_URL === "string" && API_URL.trim() !== "";
}

/** 이 브라우저가 로그인을 기억할 수 있는지(창을 닫았다 열어도 유지되는지) */
export function canRememberLogin() {
  const key = "classboard.check";
  try {
    window.localStorage.setItem(key, "1");
    const ok = window.localStorage.getItem(key) === "1";
    window.localStorage.removeItem(key);
    return ok;
  } catch (e) {
    return false;
  }
}

/** 저장된 로그인 토큰이 있는지 */
export function hasSession() {
  return Boolean(getToken());
}

/** 마지막으로 로그인한 번호(없으면 null). 로그인 칸을 미리 채우는 데만 쓴다. */
export function getSavedNumber() {
  const raw = readStore(NUMBER_KEY) || memory.number;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** 로그아웃: 이 브라우저에 저장된 토큰만 지운다(서버에는 요청하지 않음). */
export function clearSession() {
  memory.token = null;
  removeStore(TOKEN_KEY);
}

/** 토큰이 만료되거나 틀려서 다시 로그인해야 할 때 부를 함수를 정한다. */
export function onAuthRequired(handler) {
  authRequiredHandler = handler;
}

/* ---------- 서버 호출 ---------- */

function now() {
  return window.performance && performance.now ? performance.now() : Date.now();
}

async function call(payload) {
  const started = now();
  if (!isConfigured()) {
    return { ok: false, error: "NOT_CONFIGURED", elapsedMs: 0 };
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      resolve({ ok: false, error: "TIMEOUT" });
    }, TIMEOUT_MS);
  });

  const request = (async () => {
    try {
      // text/plain으로 보내야 브라우저가 사전 요청(CORS preflight)을 보내지 않는다.
      // application/json으로 바꾸면 Apps Script에서 실패한다.
      // Apps Script의 302 이동은 fetch가 알아서 따라간다(redirect 기본값 "follow").
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return { ok: false, error: "BAD_RESPONSE" };
      }
      if (!data || typeof data !== "object" || typeof data.ok !== "boolean") {
        return { ok: false, error: "BAD_RESPONSE" };
      }
      return data;
    } catch (e) {
      return { ok: false, error: e && e.name === "AbortError" ? "TIMEOUT" : "NETWORK" };
    }
  })();

  const result = await Promise.race([request, timeout]);
  clearTimeout(timer);
  result.elapsedMs = now() - started;
  return result;
}

// 토큰이 필요한 요청. AUTH_REQUIRED를 받으면 토큰을 지우고 화면에 알린다.
async function callWithToken(payload) {
  const token = getToken();
  if (!token) {
    if (authRequiredHandler) authRequiredHandler();
    return { ok: false, error: "AUTH_REQUIRED", elapsedMs: 0 };
  }
  const res = await call(Object.assign({}, payload, { token }));
  // 그사이 다른 번호로 새로 로그인했다면 새 토큰은 지우지 않는다.
  if (!res.ok && res.error === "AUTH_REQUIRED" && getToken() === token) {
    clearSession();
    // 서버가 보낸 이유(예: "비밀번호가 초기화되어…")를 화면에 넘긴다.
    if (authRequiredHandler) authRequiredHandler({ message: res.message || null });
  }
  return res;
}

// 등록·로그인 성공 답에서 토큰을 꺼내 저장하고, 화면에는 토큰을 넘기지 않는다.
function keepSession(res) {
  if (!res.ok) return res;
  if (typeof res.token !== "string" || !res.token) {
    return { ok: false, error: "BAD_RESPONSE", elapsedMs: res.elapsedMs };
  }
  saveSession(res.token, res.number);
  const copy = Object.assign({}, res);
  delete copy.token;
  return copy;
}

/** 서버가 살아 있는지 */
export function ping() {
  return call({ action: "ping" });
}

/** 지금 처음 등록이 열려 있는지: { ok, open, from, to } */
export function getRegInfo() {
  return call({ action: "regInfo" });
}

/** 처음 등록. 성공하면 바로 로그인 상태가 된다. */
export async function register(number, pin) {
  return keepSession(await call({ action: "register", number, pin }));
}

/** 로그인 */
export async function login(number, pin) {
  return keepSession(await call({ action: "login", number, pin }));
}

/** 내 공지판 전체(한 번에): { ok, number, notices: [...] } */
export function getBoard() {
  return callWithToken({ action: "board" });
}

/** 항목 체크 저장. checked는 체크된 항목 번호(0부터) 전체 목록. */
export function saveChecklist(noticeId, checked) {
  return callWithToken({ action: "respond", noticeId, checked });
}

// 메모는 공지가 메모를 받을 때(memoAllowed)만 글자로 넘긴다. null이면 요청에 넣지 않는다.
function withMemo(payload, memo) {
  if (typeof memo === "string") payload.memo = memo;
  return payload;
}

/** 제출 표시 저장. submitted: true = [제출했어요], false = [제출 취소]. memo: 한 줄 메모(정리된 글자) 또는 null. */
export function saveSubmit(noticeId, submitted, memo) {
  return callWithToken(withMemo({ action: "respond", noticeId, submitted: submitted === true }, memo));
}

/** 투표 저장. choice: 고른 선택지 번호(0부터), 지우려면 null. memo: 의견 한 줄(정리된 글자) 또는 null. */
export function savePoll(noticeId, choice, memo) {
  return callWithToken(withMemo({ action: "respond", noticeId, choice: Number.isInteger(choice) ? choice : null }, memo));
}
