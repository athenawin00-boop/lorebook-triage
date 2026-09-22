/**
 * Jev Lorebook — 로어북 장기기억을 벡터 검색 + Jev 3축 판정으로 주입하는 확장 (v0.3, A안 배관)
 *
 * 흐름 (매 생성, generate_interceptor):
 *   최근 유저 메시지 → /api/vector/query (palm=Gemini) → 후보 topK
 *   → Jev(TypeSafe System One) 3축 병렬 판정 (모순위험 / 장면적합 / 최근중복)
 *   → 점수순 정렬 → 턴당 토큰 예산까지 채택
 *   → WORLDINFO_FORCE_ACTIVATE 로 주입
 *
 * v0.3 추가:
 *   - 요술봉(#extensionsMenu) 세부 패널: 변환 / 직전 판정 관측 / 색인 현황
 *   - 챗 → 로어북 변환 파이프라인 (메인 API generateRaw, 슬라이스 분할, 증분 변환)
 *
 * 폴백 없음: Jev 키 없음/호출 실패 = toastr 1회 + 이번 턴 주입 0.
 */

import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { world_names, loadWorldInfo, METADATA_KEY, createWorldInfoEntry, saveWorldInfo, newWorldInfoEntryTemplate, updateWorldInfoList, reloadEditor, selected_world_info, world_info } from '../../../world-info.js';
import { power_user } from '../../../power-user.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { getStringHash, timestampToMoment, getCharaFilename } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { secret_state, SECRET_KEYS } from '../../../secrets.js';
import { oai_settings } from '../../../openai.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { hideChatMessageRange } from '../../../chats.js';

const MODULE = 'jevLorebook';
const TEMPLATE_PATH = 'third-party/lorebook-triage';
const LOG = '[Jev Lorebook]';

// api.typesafe.ai는 브라우저 오리진을 CORS로 거부한다 → 서버 경유 필수. 전송 경로 2개를 자동 감지한다 (v0.4.1):
// 1순위 — jev-proxy 서버 플러그인: 키는 X-Jev-Key 헤더 (Authorization은 basicAuthMode가 선점 — 2026-09-20 실측)
// 2순위 — ST 내장 CORS 프록시(/proxy/*, server-main.js:258): Authorization: Bearer 그대로 전달됨
//   (corsProxy.js가 x-csrf-token/cookie/origin 등만 제거하고 Authorization은 통과시킨다)
//   ⚠ basicAuthMode 켠 인스턴스에선 Bearer가 basicAuth를 덮어 401 → 이 경로 사용 불가 (실측 지뢰)
const JEV_PLUGIN_API = '/api/plugins/jev-proxy/systemone';
const JEV_CORS_API = '/proxy/https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 20000;
const JEV_PROBE_TIMEOUT_MS = 8000;

const DEFAULT_TOP_K = 30;        // 벡터 회수 후보 수 기본값 — 20으론 Jev 상위권을 놓침(2026-09-20 실측). v0.7.0에서 설정(20~50)으로 개방
const TOP_K_MIN = 20;
const TOP_K_MAX = 50;
const SCORE_FLOOR = 0.5;         // 최종 점수 하한. 대조실험 눈금: 0.74=빼면 모순 / 0.52=장면만 맞음 / 0.37=무관
const QUERY_USER_MESSAGES = 3;   // 검색 쿼리로 쓸 최근 유저 메시지 수
const SCENE_MESSAGES = 6;        // Jev에 보여줄 최근 장면 메시지 수
const INSERT_CHUNK = 20;         // 색인 시 insert 배치 크기
const JUDGMENT_CACHE_MS = 60000; // 동일 쿼리 판정 캐시 (같은 턴의 연쇄 quiet 생성 대응)

// ── 변환 파이프라인 상수 ────────────────────────────────────────────────
const CONVERT_META_KEY = 'jevLorebookLastConverted'; // chat_metadata에 저장하는 마지막 변환 지점 (chat 배열 인덱스, exclusive)
// 작중 날짜 앵커 (v0.7.0) — 실제 send_date가 아니라 '이야기 속 날짜'의 기준점. 이 채팅에만 귀속.
// send_date는 "내가 언제 쳤나"라 작중 시간과 무관하다 — 하루에 작중 3개월을 쓸 수도 있다 (현이 지적, 2026-09-20)
const STORY_ANCHOR_META_KEY = 'jevLorebookStoryAnchor';
// 직전 변환 되돌리기 스냅샷 (v0.11.0) — chat_metadata에 두어 이 채팅에만 귀속시킨다.
// 변환은 다섯 가지를 한꺼번에 바꾼다(항목 추가 / 코어 덮어쓰기 / 변환 지점 / 작중 앵커 / 원본 숨김).
const UNDO_META_KEY = 'jevLorebookUndo';
const DEFAULT_SLICE_TOKENS = 18000; // 슬라이스당 대화 토큰 상한 기본값. v0.7.0에서 설정으로 개방
const REAL_GAP_HOURS = 6;           // 실제 시간이 이만큼 벌어지면 전사에 장면 경계 힌트를 남긴다 (약한 힌트일 뿐)
// v0.13.0 — 코어 2층화(규칙/일기). 기존 단일 '⭐ Core Memory'는 레거시 식별자로만 남긴다(마이그레이션 입력용).
const LEGACY_CORE_COMMENT = '⭐ Core Memory';        // 레거시 통짜 코어 — 마이그레이션 입력 + archived 표시 대상
const LEGACY_CORE_ARCHIVED_SUFFIX = ' (archived)';   // 마이그레이션 후 레거시 항목에 붙이는 표시 (disable=true와 함께)
const CORE_RULES_COMMENT = '⭐ Core Rules';           // 코어 규칙 항목 — 항상 1개, upsert 키(comment 완전일치)
const CORE_DIARY_COMMENT_PREFIX = '⭐ Core Diary';    // 코어 일기 항목 comment 접두사 — 뒤에 '(sealed)'?·시작~종료일이 붙는다
const DIARY_ARCHIVE_COMMENT_PREFIX = 'Diary Archive'; // 강등된(구) 일기 comment 접두사 — ⭐를 떼어 코어 계열 스캔에서 확실히 빠지게 한다

// ── 본문 날짜 헤더 (v0.12.0) ────────────────────────────────────────────
// ST는 주입 조립에 entry.content만 넣는다 (world-info.js:5095 `WIBeforeEntries.unshift(content)`).
// comment(제목)는 편집창·내보내기 전용이라 프롬프트에 절대 닿지 않는다 → v0.11.0까지 저장된 항목은
// 날짜가 comment에만 있어서 ① 모델이 사건 순서를 못 읽고 ② content만 임베딩하니 시기 쿼리 회수도 안 됐다.
// 변환 출력 헤더(`### YYYY-MM-DD — 제목`)와 같은 형식으로 본문 머리에 박아 왕복 구조를 일치시킨다.
const INCIDENT_HEADER_RE = /^#{2,4}\s*\d{4}-\d{2}-\d{2}/;
// comment 형식 `제목 · YYYY-MM-DD[ #N]` 역파싱 — 마이그레이션이 날짜·제목을 여기서 긁는다
const COMMENT_META_RE = /^(.*?)\s*·\s*(\d{4}-\d{2}-\d{2})(?:\s*#\s*\d+)?\s*$/;
// 날짜가 두 번 박힌 레거시 comment가 실재한다 — `ㅅㅃㄹ 1 · 2025-01-18 · 2025-01-18` (v0.4 스플릿 산물, 2026-09-20 실측 4건).
// 그대로 두면 헤더가 `### 2025-01-18 — ㅅㅃㄹ 1 · 2025-01-18`로 나온다 → 제목 꼬리의 날짜를 전부 벗긴다.
const COMMENT_DATE_TAIL_RE = /\s*·\s*\d{4}-\d{2}-\d{2}(?:\s*#\s*\d+)?\s*$/;

/** comment에서 제목만 — 말미에 붙은 날짜 꼬리를 남지 않을 때까지 벗긴다 */
function stripDateTail(title) {
    let out = String(title ?? '').trim();
    let prev;
    do { prev = out; out = out.replace(COMMENT_DATE_TAIL_RE, '').trim(); } while (out !== prev);
    return out;
}

/** 사건 항목 본문 = 날짜 헤더 + 본문. 저장·주입·임베딩이 전부 이 문자열 하나를 쓴다 */
function buildIncidentContent(date, title, body) {
    return `### ${date} — ${title}\n${body}`;
}

// ── 스플릿(v0.4) 상수 — st_lorebook_split.py 규칙의 JS 이식 ─────────────────
// 줄머리 20자 이내 날짜 = 경계. $ 앵커 금지 — 엄격 버전은 헤더 뒤 본문 붙은 항목을 통짜로 남겼다 (실측, §4-10)
const SPLIT_DATE_RE = /^[^\S\n]*(?:#{1,4}[^\S\n]*)?(?:\*\*)?[^\n]{0,20}?(\d{4}-\d{2}-\d{2})/gm;
const SPLIT_MIN_CHUNK = 200;             // 이보다 작은 조각은 앞 덩어리에 흡수
const SPLIT_EST_CHARS_PER_TOKEN = 3;     // 한글 혼용 보수 추정 (이식 원본과 동일)
const SPLIT_BIG_CONSTANT_CHARS = 3000;   // constant 항목이 이 크기를 넘으면 기본 체크 후보 (≈1,000토큰)
const CORE_RULES_TOKEN_LIMIT = 400;      // 규칙 섹션 상한 — 프롬프트 강제 (v0.13.0, 기존 CORE_TOKEN_LIMIT 800을 규칙/일기로 분리)
const CORE_DIARY_TOKEN_LIMIT = 600;      // 일기 섹션 상한 — 갱신 직후 이걸 넘으면 그 즉시 봉인(sealed)한다
const CORE_DIARY_MAX_COUNT = 3;          // 슬라이딩 일기 개수 상한 — 넘으면 가장 오래된 것을 검색층으로 강등
const CORE_RULES_ORDER = 1000;           // 코어 규칙 삽입 순서 — 최상단(일반 항목 기본값 100보다 위). 수동 승격(🔵)도 이 값을 쓴다
const CORE_DIARY_ORDER_BASE = 999;       // 코어 일기 삽입 순서 기준 — 규칙 바로 아래. 오래된 것일수록 값이 크다(recomputeDiaryOrders)
const NORMAL_ORDER = 100;                // 일반(검색층) 항목 순서 — 코어에서 강등할 때 되돌리는 값
// 문장 종결부호 — 응답 끝줄이 이걸로 안 끝나면 잘림 의심 (프로필·현재연결 양쪽 공통 휴리스틱)
const SENTENCE_END_RE = /[.!?"”'’)」』]$/;
const TRUNCATION_RATIO = 0.95;           // 응답 토큰이 상한의 이 비율을 넘으면 잘림 의심 (v0.7.0)

// ── 변환 프롬프트 (v0.7.0에서 2분할) ──────────────────────────────────
// 하나였던 CONVERT_PROMPT를 '스타일부(유저 편집 가능)'와 '계약부(잠금)'으로 갈랐다.
// 이유: 문체를 바꾸고 싶다는 요구는 잦은데, 출력 형식을 같이 건드리면 파서가 통째로 죽는다.
// 형식은 코드가 의존하는 계약이라 유저 손이 닿으면 안 된다.
const DEFAULT_CONVERT_STYLE = [
    'You are converting roleplay chat logs into lorebook entries.',
    'Summarize each incident in six or more sentences. Quote dialogue when necessary. Output in English.',
].join('\n');

/**
 * 사건 추출용 system prompt 조립 — 스타일부(유저) + 계약부(잠금).
 * 작중 날짜(in-story date)를 쓰게 한다: send_date는 "내가 언제 쳤나"라 작중 시간과 무관하다.
 * 번호는 여기서 금지하고 코드 후처리로 붙인다 — 모델은 슬라이스마다 1부터 다시 세서 중복 번호를 만든다.
 */
function buildIncidentsPrompt(style, incidentMaxTokens, anchor) {
    const anchorText = String(anchor || '').trim() || 'unknown';
    return [
        String(style || '').trim() || DEFAULT_CONVERT_STYLE,
        '',
        'Strict output format (locked — always follow this exactly):',
        '- Begin each incident with a header line exactly like: ### YYYY-MM-DD — <short title>',
        '- Do NOT number the incidents in any way. Numbering is assigned afterwards by the tool.',
        '- The date is the IN-STORY date, not the real-world time at which the log was written.',
        '  Decide it in this order:',
        '  1) If the transcript itself states an in-story date, use that date.',
        `  2) Otherwise, count the in-story time elapsed from [Anchor: ${anchorText}] ('the next day', 'three days later', ...) and compute the date.`,
        '  3) If neither is possible, reuse the anchor date as-is.',
        '- If one day contains clearly distinct scenes, split them into separate incidents.',
        '  The same date header may appear several times; that is expected.',
        `- Each incident is 6-12 sentences and stays under ${incidentMaxTokens} tokens.`,
        '- Optionally add one line per incident, exactly like: Keywords: a, b, c (at most 5).',
        '- Output nothing else: no preamble, no commentary.',
    ].join('\n');
}

/**
 * 코어 규칙/일기 갱신 전용 system prompt 2종 — 유저 편집 불가 (구조가 깨지면 upsert가 통째로 죽는다).
 * v0.13.0에서 단일 CORE_PROMPT를 둘로 쪼갰다 — 가상 실행 실측(tmp/core_sim_*.md)에서 한 프롬프트가
 * 규칙·일기를 동시에 쓰게 하면 (a) 미해결 질문이 규칙에 스며들고 (b) 일기가 "tonight" 장면 요약으로 미끄러졌다.
 * 각자 책임을 분리하고 EXCLUDE 조항으로 서로의 영역을 명시적으로 밀어낸다.
 */
const RULES_PROMPT = [
    'You maintain the CORE RULES of an ongoing roleplay: constraints that must hold even in scenes where they are never mentioned.',
    'You are given the [Previous rules] and the [New incidents] extracted from the latest logs.',
    'UPDATE the previous rules with what changed in the new incidents. If nothing changed, restate them as-is.',
    '',
    'Include ONLY:',
    '- Naming rules (how characters address each other)',
    '- Knowledge boundaries (who knows / does not know what)',
    '- Hard behavioral constraints (things a character always or never does)',
    '- Identity-level secrets',
    '',
    'EXCLUDE:',
    '- Relationship state, arcs, promises, plans (those belong to the diary, not here)',
    '- Retrievable trivia: addresses, jobs, possessions, side characters, appearance, food',
    '- Unanswered questions and pending answers are NOT rules; they belong to the diary\'s Ongoing. Never output them here.',
    '',
    'Strict output format:',
    '- Output exactly one section, starting with the exact header line: ### CORE RULES',
    '- Each rule is one line starting with "- ".',
    `- Keep the whole section under ${CORE_RULES_TOKEN_LIMIT} tokens.`,
    '- Output in English. Output nothing else: no preamble, no commentary, no explanations.',
].join('\n');

const DIARY_PROMPT = [
    'You maintain the current CORE DIARY segment of an ongoing roleplay: the present state of the relationship, never a running log of events.',
    'You are given the [Previous current diary] and the [New incidents] extracted from the latest logs.',
    'UPDATE the previous diary with what changed in the new incidents. Present state only. If nothing changed, restate it as-is.',
    '',
    'Do NOT output naming rules, knowledge boundaries, identity-level secrets, or immutable facts — those live in CORE RULES, not here.',
    'Never write "tonight", "today", "this evening", or recap the newest scene. Record only the standing state that remains true after the scene ends.',
    '',
    'Strict output format:',
    '- Output exactly one section, starting with a header line exactly like: ### CORE DIARY (date range)',
    '  (Whatever date range you write there is discarded — the tool stamps its own. Any placeholder is fine.)',
    '- Format as short labeled lines — NO flowing prose, NO paragraphs:',
    '  Relationship: <the current state in one line, as it stands NOW>',
    '  Dynamics: <how they treat each other now, 1-2 short lines>',
    '  Ongoing: <unresolved arcs, promises, plans — one per line, each starting with "- ">',
    `- Keep the whole section under ${CORE_DIARY_TOKEN_LIMIT} tokens.`,
    '- Output in English. Output nothing else: no preamble, no commentary.',
].join('\n');

/** 직전 판정 결과 — 채팅이 안 전진했으면 Jev 재호출 없이 재주입만 한다 */
let lastJudgment = { key: 0, items: [], ts: 0 };
/** 직전 턴 판정 리포트 — 세부 패널 관측용 (콘솔 안 열어도 보이게) */
let lastReport = null;
/** 직전 인터셉터 에러 — 패널 표시용 */
let lastError = null;
/**
 * 이번 턴 ST가 실제로 주입한 엔트리 (v0.9.0) — WORLD_INFO_ACTIVATED 구독 결과.
 * world-info.js:902에서 isDryRun이 아닐 때만 emit되고, 인자는 활성화된 **전체** 엔트리 배열이다
 * (우리 FORCE_ACTIVATE 채택분 + 키워드·sticky·데코레이터·constant 전부).
 * 패널의 나머지 표는 전부 "우리 판정"이라, 프롬프트에 실제로 뭐가 들어갔는지는 여기서만 보인다.
 * 최신 1턴만 보관. 엔트리 객체는 ST가 재사용할 수 있어 필요한 필드만 스냅샷으로 복사한다.
 */
let lastActivated = null; // { ts, entries: [{ world, uid, comment, content, constant }] }
/** 변환 진행 중 플래그 — generateRaw는 인터셉터를 안 타지만(검증: script.js:4063→generateRawData 직행) 이중 실행·오발동 보험 */
let conversionInProgress = false;
/** Jev 전송 경로 캐시 (세션당 1회 감지). 판정 실패 시 null로 리셋 → 다음 턴 재감지 */
let jevTransport = null; // { kind: 'plugin'|'cors', endpoint, label }
/** 마지막 경로 감지 실패 사유 — 패널 표시용 */
let lastTransportError = null;
/**
 * 직전 변환에서 모인 경고 — 패널 표시용 (v0.7.0).
 * 토스트는 몇 초 뒤면 사라지는데 "잘렸을지도 모른다"는 나중에 확인하고 싶은 정보라 남긴다.
 */
let lastConvertWarnings = [];
/**
 * 🎲 랜덤 주입 상태 (v0.15.0).
 * recentRandomUids = 로어북별 쿨다운 링버퍼 Map (world → [`${world}.${uid}`, …]). 최근 뽑힌 건 한동안 다시 안 뽑는다.
 *                    v0.17.0에서 통합 배열을 북별 Map으로 갈랐다 — 통합 풀이면 큰 북의 항목이 링버퍼를 채워
 *                    작은 북의 쿨다운을 밀어낸다. CHAT_CHANGED에서 비운다.
 * lastRandomItems  = 직전 턴에 뽑힌 항목. 판정 캐시 히트 턴에는 새로 뽑지 않고 이걸 그대로 재주입한다
 *                    (같은 턴의 연쇄 quiet 생성에서 주입물이 흔들리면 안 된다).
 * lastRandomKeys   = 패널 「직전 턴」 표의 🎲 분류용 키 집합.
 */
let recentRandomUids = new Map();
let lastRandomItems = [];
let lastRandomKeys = new Set();

// ── 임베딩 소스 (v0.5) — vectors 확장 지원 소스의 부분집합 ─────────────────
// 제외: ollama/llamacpp/vllm/koboldcpp(서버 URL 필요), webllm(브라우저 모듈), vertexai(인증 모드 복잡),
//       workers_ai(계정 설정 필요), extras(deprecated). 근거 → 보고서 v0.5 섹션.
// secretKey: secret_state 대조용 (vectors/index.js:1075 throwIfSourceInvalid 매핑 그대로)
// modelFromRequest: 서버 getSourceSettings가 req.body.model을 읽는 소스만 true (vectors.js:214~ 검증)
//
// v0.7.0 추가 — 키를 '어디에' 넣는지 (최초 설치자가 입력칸을 못 찾는 게 실사용 1번 장벽):
//   keyRoute 'chat'    = API 연결 → Chat Completion → 소스 선택 (index.html의 chat_completion_source 옵션에 존재)
//   keyRoute 'text'    = API 연결 → Text Completion → 소스 선택 (togetherai만 여기, index.html:2435 실측)
//   keyRoute 'vectors' = 확장의 Vector Storage 설정 안에서 관리 (nomicai는 API 연결 화면에 칸 자체가 없다,
//                        vectors/settings.html:181 실측)
//   stSource = ST 드롭다운에 실제로 찍혀 있는 문자열 그대로. 우리 label과 다를 수 있어 따로 둔다
//              (label엔 '(모델 고정: …)' 같은 우리 주석이 붙어 있어 그대로 안내하면 못 찾는다)
// palm(Google AI Studio) 전용 키 모드에서 쓰는 접속지 — endpoints/google.js:14 API_MAKERSUITE와 동일 주소 (접속지는 그대로, 키만 교체된다)
const GOOGLE_AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com';

const EMBEDDING_SOURCES = {
    palm:         { label: 'Google AI Studio (Gemini)', secretKey: SECRET_KEYS.MAKERSUITE, modelFromRequest: true, defaultModel: 'gemini-embedding-001', keyRoute: 'chat', stSource: 'Google AI Studio' }, // text-embedding-005는 404 — 실측
    vertexai:     { label: 'Google Vertex AI', secretKey: SECRET_KEYS.VERTEXAI, altSecretKey: SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, modelFromRequest: true, defaultModel: 'text-embedding-005', keyRoute: 'chat', stSource: 'Google Vertex AI' }, // Vertex에선 text-embedding-005가 정상 모델이다 (404는 AI Studio 한정)
    transformers: { label: 'Local (Transformers) — 키 불필요', secretKey: null, modelFromRequest: false, defaultModel: '', keyRoute: null, stSource: '' },
    openai:       { label: 'OpenAI', secretKey: SECRET_KEYS.OPENAI, modelFromRequest: true, defaultModel: 'text-embedding-3-small', keyRoute: 'chat', stSource: 'OpenAI' },
    cohere:       { label: 'Cohere', secretKey: SECRET_KEYS.COHERE, modelFromRequest: true, defaultModel: 'embed-english-v3.0', keyRoute: 'chat', stSource: 'Cohere' },
    mistral:      { label: 'MistralAI (모델 고정: mistral-embed)', secretKey: SECRET_KEYS.MISTRALAI, modelFromRequest: false, defaultModel: '', keyRoute: 'chat', stSource: 'MistralAI' },
    togetherai:   { label: 'TogetherAI', secretKey: SECRET_KEYS.TOGETHERAI, modelFromRequest: true, defaultModel: 'togethercomputer/m2-bert-80M-32k-retrieval', keyRoute: 'text', stSource: 'TogetherAI' },
    nomicai:      { label: 'NomicAI (모델 고정: nomic-embed-text-v1.5)', secretKey: SECRET_KEYS.NOMICAI, modelFromRequest: false, defaultModel: '', keyRoute: 'vectors', stSource: 'NomicAI' },
    openrouter:   { label: 'OpenRouter', secretKey: SECRET_KEYS.OPENROUTER, modelFromRequest: true, defaultModel: 'openai/text-embedding-3-large', keyRoute: 'chat', stSource: 'OpenRouter' },
    electronhub:  { label: 'Electron Hub', secretKey: SECRET_KEYS.ELECTRONHUB, modelFromRequest: true, defaultModel: 'text-embedding-3-small', keyRoute: 'chat', stSource: 'Electron Hub' },
    nanogpt:      { label: 'NanoGPT', secretKey: SECRET_KEYS.NANOGPT, modelFromRequest: true, defaultModel: 'text-embedding-3-small', keyRoute: 'chat', stSource: 'NanoGPT' },
    siliconflow:  { label: 'SiliconFlow', secretKey: SECRET_KEYS.SILICONFLOW, modelFromRequest: true, defaultModel: 'Qwen/Qwen3-Embedding-0.6B', keyRoute: 'chat', stSource: 'SiliconFlow' },
    chutes:       { label: 'Chutes', secretKey: SECRET_KEYS.CHUTES, modelFromRequest: true, defaultModel: 'chutes-qwen-qwen3-embedding-8b', keyRoute: 'chat', stSource: 'Chutes' },
};

/**
 * 이 소스의 키가 ST에 저장돼 있는지. Vertex만 시크릿이 두 갈래다
 * (Express Mode = api_key_vertexai / Service Account = vertexai_service_account_json) —
 * 내장 vectors도 둘 중 하나만 있으면 통과시킨다 (extensions/vectors/index.js:1081).
 */
function hasEmbeddingKey(meta) {
    if (!meta || meta.secretKey === null) return true;
    return Boolean(secret_state[meta.secretKey] || (meta.altSecretKey && secret_state[meta.altSecretKey]));
}

// 설정 숫자칸 범위 — UI(min/max)와 읽기 쪽 클램프가 같은 값을 써야 한다 (UI만 막으면 수동 설정 파일 편집을 못 막는다)
const SLICE_TOKENS_MIN = 2000;
const SLICE_TOKENS_MAX = 60000;
const CONVERT_MAX_TOKENS_MIN = 1024;
const CONVERT_MAX_TOKENS_MAX = 65536;
const DEFAULT_CONVERT_MAX_TOKENS = 16384; // 구 v0.6.4는 4096 고정 — 18,000토큰 슬라이스의 사건 다발을 담기엔 터무니없이 짧았다
const INCIDENT_TOKENS_MIN = 100;
const INCIDENT_TOKENS_MAX = 4000;
const DEFAULT_INCIDENT_MAX_TOKENS = 500;
// 🎲 랜덤 주입 예산 (v0.15.0) — 주입 예산(budgetTokens)과 별개 통이다. 0이면 랜덤은 돌지 않는다.
const RANDOM_BUDGET_MIN = 0;
const RANDOM_BUDGET_MAX = 20000;
const DEFAULT_RANDOM_BUDGET = 500;
// 주입 예산 범위 (v0.17.0) — settings.html의 min/max와 같은 값을 쓴다.
// 로어북별 오버라이드도 전역과 같은 범위로 클램프한다 — 창구가 둘인데 허용 범위가 다르면 설명할 수 없다.
const BUDGET_TOKENS_MIN = 500;
const BUDGET_TOKENS_MAX = 20000;

const defaultSettings = Object.freeze({
    enabled: false,
    // 감지 대상 층 on/off (v0.8.0) — ST 본체 4계층. 전부 기본 켜짐.
    layerChat: true,
    layerChar: true,
    layerGlobal: true,
    layerPersona: true,
    jevApiKey: '',
    budgetTokens: 4000,
    world: '',
    keepRecent: 20,
    embeddingSource: 'palm',   // 기존 하드코딩(palm)과 동일한 기본값 — 동작 불변
    embeddingModel: '',        // 빈 값 = 소스별 기본 모델
    embeddingDirty: false,     // 임베딩 설정 변경 후 재색인 전 = true (경고 표시)
    embeddingKeyMode: 'shared', // 'shared' = ST 저장 키(기존, 기본값) / 'dedicated' = 이 확장 설정에 따로 저장한 키 — palm 소스만 적용
    embeddingDedicatedKey: '', // 전용 키 원문 — ⚠ ST 금고가 아니라 이 확장 설정에 평문 저장된다
    convertProfileId: '',      // 빈 값 = 현재 연결된 메인 API // 변환·숨김에서 제외할 최근 메시지 수 — 직전 장면은 원문으로 남아야 한다
    // ── v0.7.0 신규 ──
    sliceTokens: DEFAULT_SLICE_TOKENS,          // 슬라이스당 전사 토큰 상한
    convertMaxTokens: DEFAULT_CONVERT_MAX_TOKENS, // 변환 응답 최대 토큰 (프로필 경로에만 직접 먹임)
    incidentMaxTokens: DEFAULT_INCIDENT_MAX_TOKENS, // 사건 1건당 토큰 상한 (프롬프트에 주입)
    queryTopK: DEFAULT_TOP_K,                   // 벡터 회수 후보 수
    convertStyle: '',                           // 빈 값 = DEFAULT_CONVERT_STYLE 사용
    // ── v0.12.0 신규 ──
    // ── v0.15.0 신규 ──
    randomEnabled: false,                       // 🎲 랜덤 주입 (기본 꺼짐)
    randomBudgetTokens: DEFAULT_RANDOM_BUDGET,  // 랜덤 전용 예산 — budgetTokens와 합산하지 않는다
    headerMigratedWorlds: [],                   // 본문 날짜 헤더 마이그레이션이 끝난 로어북 이름 (로어북당 1회용 마커)
    // ── v0.17.0 신규 ──
    // 로어북별 파라미터 오버라이드: `{ "<로어북 이름>": { budgetTokens?, randomEnabled?, randomBudgetTokens?, queryTopK? } }`
    // 키가 없거나 빈 문자열이면 전역값을 상속한다(전부 강제 지정하게 만들지 않는다).
    // ⚠ 저장 키가 로어북 '이름'이라 ST에서 이름을 바꾸면 이 레코드는 고아가 된다. 정리 로직은 두지 않기로 확정했다
    //   (발주자 결정: 방치). 고아 레코드는 어느 북에도 매칭되지 않아 동작에 영향이 없다.
    perWorld: {},
});

/** 설정 숫자 방어 — 설정 파일이 손으로 망가졌어도 파이프라인은 돌아가야 한다 */
function clampSetting(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

function getSliceTokens() {
    return clampSetting(getSettings().sliceTokens, SLICE_TOKENS_MIN, SLICE_TOKENS_MAX, DEFAULT_SLICE_TOKENS);
}

function getConvertMaxTokens() {
    return clampSetting(getSettings().convertMaxTokens, CONVERT_MAX_TOKENS_MIN, CONVERT_MAX_TOKENS_MAX, DEFAULT_CONVERT_MAX_TOKENS);
}

function getIncidentMaxTokens() {
    return clampSetting(getSettings().incidentMaxTokens, INCIDENT_TOKENS_MIN, INCIDENT_TOKENS_MAX, DEFAULT_INCIDENT_MAX_TOKENS);
}

// ── 로어북별 파라미터 오버라이드 (v0.17.0) ─────────────────────────────
// 전역 1벌이던 네 값(주입 예산 / 랜덤 켜기 / 랜덤 예산 / topK)을 로어북 단위로 덮어쓸 수 있게 한다.
// 네 게터는 전부 world 인자를 '선택'으로 받는다 — 인자가 없으면 전역값을 돌려주므로 기존 호출부가 그대로 동작한다.
const PER_WORLD_KEYS = Object.freeze(['budgetTokens', 'randomEnabled', 'randomBudgetTokens', 'queryTopK']);

/**
 * 오버라이드 저장소. 없으면 만든다.
 * ⚠ getSettings()의 결손 키 보충은 `defaultSettings[key]`를 **참조로** 물려준다(Object.freeze는 얕다).
 *   기존 설치가 업그레이드될 때 defaultSettings.perWorld 객체를 그대로 쓰게 되므로 여기서 자기 소유 객체로 갈아둔다.
 */
function getPerWorldStore() {
    const settings = getSettings();
    const store = settings.perWorld;
    const usable = store && typeof store === 'object' && !Array.isArray(store);
    if (!usable || store === defaultSettings.perWorld) {
        settings.perWorld = usable ? { ...store } : {};
    }
    return settings.perWorld;
}

/**
 * 오버라이드 값 해석 — '미설정'은 undefined·null·빈 문자열 셋뿐이다.
 * `0`과 `false`는 사용자가 고른 정당한 값이라 falsy로 뭉개 전역값으로 새게 두면 안 된다
 * (랜덤 켜기를 그 북만 끄는 것과 '미설정'은 다른 상태다).
 */
function resolveOverride(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value;
}

/** 이 로어북의 오버라이드 레코드 — 없거나 형식이 깨졌으면 null */
function getWorldOverride(world) {
    if (!world) return null;
    const rec = getPerWorldStore()[world];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    return rec;
}

/** 지정된 값이 하나라도 있나 — 감지 목록의 '설정 있음' 배지 판정 */
function hasWorldOverride(world) {
    const rec = getWorldOverride(world);
    return !!rec && PER_WORLD_KEYS.some(key => resolveOverride(rec[key]) !== undefined);
}

/** 주입 예산 — 북별 오버라이드 우선, 없으면 전역값 */
function getBudgetTokens(world) {
    const override = resolveOverride(getWorldOverride(world)?.budgetTokens);
    const raw = override !== undefined ? override : getSettings().budgetTokens;
    return clampSetting(raw, BUDGET_TOKENS_MIN, BUDGET_TOKENS_MAX, defaultSettings.budgetTokens);
}

/** 랜덤 주입 예산 — 북별 오버라이드 우선, 없으면 전역값 */
function getRandomBudget(world) {
    const override = resolveOverride(getWorldOverride(world)?.randomBudgetTokens);
    const raw = override !== undefined ? override : getSettings().randomBudgetTokens;
    return clampSetting(raw, RANDOM_BUDGET_MIN, RANDOM_BUDGET_MAX, DEFAULT_RANDOM_BUDGET);
}

/** 랜덤 주입 켜짐 여부 — 북별 오버라이드 우선. 체크박스라 '미설정'과 false를 반드시 갈라야 한다 */
function isRandomEnabled(world) {
    const override = resolveOverride(getWorldOverride(world)?.randomEnabled);
    if (override !== undefined) return override === true;
    return getSettings().randomEnabled === true;
}

/** 변환·숨김에서 제외할 최근 메시지 수. 설정탭과 요술봉 패널 두 창구가 같은 값을 쓴다 (v0.15.0) */
function getKeepRecent() {
    const value = Number(getSettings().keepRecent);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : defaultSettings.keepRecent;
}

/** 회수 후보 수(topK) — 북별 오버라이드 우선, 없으면 전역값. 회수는 원래부터 북별 쿼리라 그대로 먹는다 */
function getQueryTopK(world) {
    const override = resolveOverride(getWorldOverride(world)?.queryTopK);
    const raw = override !== undefined ? override : getSettings().queryTopK;
    return clampSetting(raw, TOP_K_MIN, TOP_K_MAX, DEFAULT_TOP_K);
}

/** 비어 두면 기본 스타일 — "비우면 기본값"이 복원 버튼과 같은 의미가 되게 한다 */
function getConvertStyle() {
    return String(getSettings().convertStyle || '').trim() || DEFAULT_CONVERT_STYLE;
}

function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE][key] === undefined) {
            extension_settings[MODULE][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE];
}

/**
 * 감지 대상 로어북 (v0.8.0): ST 본체 4계층을 그대로 미러링한다.
 * v0.2~v0.7은 채팅 바인딩 + 캐릭터 카드 2계층만 봤다 — 빠진 2층(전역·페르소나)은 확장의 선별·예산 밖에서
 * ST가 매 턴 통짜로 native 주입해 버린다 = 선별 우회.
 * 귀속 순서는 world-info.js의 skip 로직과 동일: 채팅 > 페르소나 > 캐릭터 > 전역
 * (getChatLore:4432 / getPersonaLore:4452 / getCharacterLore:4363 — 상위 층에 이미 있으면 건너뛴다).
 * ⚠ 여기는 **읽기 대상**이다. 쓰기(챗 → 로어북 변환) 저장처는 getConversionTargetWorld() 단독.
 */
const LAYER_LABELS = Object.freeze({
    fixed: '고정',
    chat: '채팅',
    persona: '페르소나',
    character: '캐릭터',
    global: '전역',
});

/**
 * 감지 대상 층 체크박스 ↔ 설정 키 (v0.8.0).
 * v0.17.0에서 이 마크업이 팝업 A로 옮겨가면서 jQuery 초기화 블록 안에 있던 상수를 모듈 스코프로 끌어올렸다
 * — 팝업은 열 때마다 새로 바인딩하므로 매핑이 초기화 함수 지역변수로 있으면 안 된다.
 */
const LAYER_INPUTS = Object.freeze({
    layerChat: '#jev_lorebook_layer_chat',
    layerChar: '#jev_lorebook_layer_char',
    layerGlobal: '#jev_lorebook_layer_global',
    layerPersona: '#jev_lorebook_layer_persona',
});

/**
 * 캐릭터 카드에 물린 로어북 — ST getCharacterLore(world-info.js:4363) 미러.
 * 카드의 data.extensions.world 말고도 world_info.charLore(추가 로어북, 파일명 키) 경로가 있다.
 */
function getCharacterCardWorlds(ctx) {
    const out = [];
    const base = ctx?.characters?.[ctx?.characterId]?.data?.extensions?.world;
    if (base && typeof base === 'string') out.push(base);
    try {
        const fileName = getCharaFilename(ctx?.characterId);
        const extra = fileName ? (world_info?.charLore ?? []).find(e => e?.name === fileName) : null;
        for (const name of (extra?.extraBooks ?? [])) {
            if (name && typeof name === 'string') out.push(name);
        }
    } catch (error) {
        console.log(`${LOG} charLore 조회 실패 — 카드 기본 북만 사용: ${error?.message ?? error}`);
    }
    return out;
}

/** 감지 대상 로어북 상세 — [{name, layer}]. UI는 이쪽을 쓴다 */
function getTargetWorldsDetailed() {
    const settings = getSettings();
    const known = new Set(world_names ?? []);
    if (settings.world) {
        return known.has(settings.world) ? [{ name: settings.world, layer: 'fixed' }] : [];
    }
    const ctx = SillyTavern.getContext();
    const found = [];
    const seen = new Set();
    // 실존 북만 채택(world_names 방어) + 같은 북은 먼저 걸린 층에 한 번만 귀속
    const push = (name, layer) => {
        if (!name || typeof name !== 'string') return;
        if (seen.has(name) || !known.has(name)) return;
        seen.add(name);
        found.push({ name, layer });
    };
    if (settings.layerChat !== false) push(ctx.chatMetadata?.[METADATA_KEY], 'chat');
    if (settings.layerPersona !== false) push(power_user?.persona_description_lorebook, 'persona');
    if (settings.layerChar !== false) {
        for (const name of getCharacterCardWorlds(ctx)) push(name, 'character');
    }
    if (settings.layerGlobal !== false) {
        for (const name of (selected_world_info ?? [])) push(name, 'global');
    }
    return found;
}

/** 감지 대상 로어북 이름만 — 기존 호출부가 문자열 배열을 기대한다 (시그니처 불변) */
function getTargetWorlds() {
    return getTargetWorldsDetailed().map(d => d.name);
}

/**
 * 변환(챗 → 로어북) 저장처 1개. getTargetWorlds()와 **독립 구현**이다.
 * 우선순위: 설정 고정 > 채팅 바인딩 북 > 캐릭터 카드 북.
 * v0.7.0까지의 동작 순서를 그대로 유지한다 — 기존 채팅의 저장처가 바뀌면 안 된다.
 * 발주자는 실사용에서 채팅 바인딩 북을 주로 쓴다(캐릭터 183장 중 카드에 북이 박힌 건 44장).
 * ⚠ 전역·페르소나는 어떤 경우에도 반환하지 않는다 — 전역 북에 사건이 쌓이면 모든 채팅으로 샌다.
 * ⚠ 카드 북은 data.extensions.world 단독이다. getCharacterCardWorlds()를 쓰면
 *   charLore.extraBooks(추가 로어북)까지 저장처 후보가 되는데, v0.7.0엔 없던 쓰기 대상이다.
 *   그 층은 읽기 전용으로 둔다 — 쓰기 대상을 말없이 늘리면 사건이 엉뚱한 북으로 간다.
 */
function getConversionTargetWorld() {
    const settings = getSettings();
    const known = new Set(world_names ?? []);
    if (settings.world) return known.has(settings.world) ? settings.world : '';
    const ctx = SillyTavern.getContext();
    const chatWorld = ctx.chatMetadata?.[METADATA_KEY];
    if (chatWorld && typeof chatWorld === 'string' && known.has(chatWorld)) return chatWorld;
    const cardWorld = ctx.characters?.[ctx.characterId]?.data?.extensions?.world;
    if (cardWorld && typeof cardWorld === 'string' && known.has(cardWorld)) return cardWorld;
    return '';
}

// ── ST 벡터 API (서버 경유, 임베딩 = Gemini/MakerSuite 키) ──────────────

function getCollectionId(worldName) {
    return `jev_lorebook_${getStringHash(worldName)}`;
}

function getEmbeddingBody() {
    const settings = getSettings();
    const source = EMBEDDING_SOURCES[settings.embeddingSource] ? settings.embeddingSource : 'palm';
    const meta = EMBEDDING_SOURCES[source];
    const body = { source };
    if (meta.modelFromRequest) {
        body.model = String(settings.embeddingModel || '').trim() || meta.defaultModel;
    }
    if (source === 'palm') {
        body.api = 'makersuite'; // vectors 클라 관례 (extensions/vectors/index.js:968~970)
        // 전용 키 모드 (v0.14.0) — ST 금고(MAKERSUITE)를 안 타고 이 확장 설정의 키를 직접 실어 보낸다.
        // 배선(실측): endpoints/google.js:221 getGoogleApiConfig — request.body.reverse_proxy가 있으면
        // 접속지는 그 값(여기선 GOOGLE_AI_STUDIO_BASE로 API_MAKERSUITE와 동일하게 고정)를 쓰고,
        // 키는 금고 대신 request.body.proxy_password를 쓴다. 임베딩도 같은 함수를 타고 간다(vectors/google-vectors.js → getGoogleApiConfig).
        if (settings.embeddingKeyMode === 'dedicated' && String(settings.embeddingDedicatedKey || '').trim()) {
            body.reverse_proxy = GOOGLE_AI_STUDIO_BASE;
            body.proxy_password = String(settings.embeddingDedicatedKey).trim();
        }
    }
    // Vertex는 인증모드·리전·프로젝트를 ST 메인 API 설정에서 가져다 실어야 한다 (extensions/vectors/index.js:972~977).
    // 안 실으면 getGoogleApiConfig(endpoints/google.js:165)가 api !== 'vertexai'로 보고 AI Studio 경로로 새어나간다.
    if (source === 'vertexai') {
        body.api = 'vertexai';
        body.vertexai_auth_mode = oai_settings?.vertexai_auth_mode;
        body.vertexai_region = oai_settings?.vertexai_region;
        body.vertexai_express_project_id = oai_settings?.vertexai_express_project_id;
    }
    return body;
}

/**
 * 벡터 API 실패를 '다음에 뭘 할지'가 보이는 문장으로 바꾼다 (v0.10.0).
 * ST는 임베딩 제공자 오류를 전부 sendStatus(500)으로 뭉갠다(endpoints/vectors.js:466).
 * 진짜 사유(키 무효·모델 이름·항목 길이·쿼터)는 서버 콘솔에만 찍히므로, 그 위치를 알려주는 게 유일한 단서다.
 */
async function vectorError(response, what) {
    let detail = '';
    try {
        detail = String((await response.text()) ?? '').trim().slice(0, 300);
    } catch { /* 본문 없음은 흔하다 — sendStatus는 상태 문자열만 준다 */ }
    const hint = response.status >= 500
        ? ' — SillyTavern 서버 콘솔(터미널)에 실제 사유가 찍혀 있어요: 임베딩 키·모델 이름·항목 길이·요청 한도를 확인해 주세요'
        : '';
    return new Error(`벡터 ${what} 실패 (HTTP ${response.status})${detail ? `: ${detail}` : ''}${hint}`);
}

async function vectorQuery(worldName, searchText, topK) {
    const response = await fetch('/api/vector/query', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getEmbeddingBody(),
            collectionId: getCollectionId(worldName),
            searchText: searchText,
            topK: topK,
            threshold: 0,
        }),
    });
    if (!response.ok) {
        throw await vectorError(response, 'query');
    }
    return await response.json(); // { hashes: number[], metadata: {hash,text,index}[] }
}

async function vectorInsert(worldName, items) {
    const response = await fetch('/api/vector/insert', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getEmbeddingBody(),
            collectionId: getCollectionId(worldName),
            items: items,
        }),
    });
    if (!response.ok) {
        throw await vectorError(response, 'insert');
    }
}

async function vectorPurge(worldName) {
    const response = await fetch('/api/vector/purge', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ collectionId: getCollectionId(worldName) }),
    });
    if (!response.ok) {
        throw await vectorError(response, 'purge');
    }
}

/**
 * 항목 3상태 (v0.17.0) — 🔵 상시(코어) / 🟢 검색층 / ⚫ 꺼짐.
 *
 * `disable`과 `constant`는 ST 엔트리의 **독립 필드**다. 그래서 끌 때 `disable`만 세우고 `constant`를 보존하면
 * "원래 무슨 색이었나"가 항목 안에 그대로 남는다 → 별도 백업 저장소를 만들 필요가 없다.
 */
const ENTRY_STATE_CORE = 'core';
const ENTRY_STATE_SEARCH = 'search';
const ENTRY_STATE_OFF = 'off';

/** 엔트리의 현재 상태. 꺼짐이 constant보다 우선한다 — 꺼진 파랑도 화면에선 회색이다 */
function getEntryState(entry) {
    if (entry?.disable) return ENTRY_STATE_OFF;
    return entry?.constant ? ENTRY_STATE_CORE : ENTRY_STATE_SEARCH;
}

/**
 * 클릭 1회의 다음 상태와 패치 — 순수 함수(단위검증 대상).
 * 🔵 → 🟢 → ⚫ → (원래 색). 회색에서 복귀할 때 `constant`/`order`를 **건드리지 않는 것**이 이 설계의 핵심이다.
 * needsIndex = 그 항목만 단건 벡터 삽입이 필요한가. 검색층으로 들어오는 경로에서만 true다
 * (코어는 회수 후보 필터가 constant를 이미 거르므로 색인 대상이 아니다).
 */
function planEntryStateCycle(entry) {
    const state = getEntryState(entry);
    if (state === ENTRY_STATE_CORE) {
        // 강등 — order를 같이 되돌린다. 안 되돌리면 검색층인데 프롬프트 최상단 자리를 계속 차지한다.
        return { from: state, to: ENTRY_STATE_SEARCH, patch: { constant: false, order: NORMAL_ORDER }, needsIndex: true };
    }
    if (state === ENTRY_STATE_SEARCH) {
        // 끄기 — 벡터는 지우지 않는다. 회수 후보 필터가 disable을 이미 거르고, 남은 벡터는 다음 재색인에서 정리된다.
        return { from: state, to: ENTRY_STATE_OFF, patch: { disable: true }, needsIndex: false };
    }
    // 복귀 — disable만 해제한다. constant가 살아 있으면 파랑, 없으면 초록으로 저절로 돌아간다.
    const restored = entry?.constant ? ENTRY_STATE_CORE : ENTRY_STATE_SEARCH;
    return { from: state, to: restored, patch: { disable: false }, needsIndex: restored === ENTRY_STATE_SEARCH };
}

/**
 * 항목 상태를 한 칸 돌린다 (v0.17.0 — v0.6.4의 2상태 전환 함수를 대체).
 * 검색층으로 들어오는 경로(강등·회색에서 복귀)에서만 그 항목 하나를 벡터에 삽입한다 → 임베딩 1회.
 * 코어로 가는 경로는 임베딩 0회다.
 */
async function cycleEntryState(world, uid) {
    const worldData = await loadWorldInfo(world);
    const entry = worldData?.entries?.[uid];
    if (!entry) throw new Error(`uid ${uid} 항목을 찾지 못했어요`);

    const plan = planEntryStateCycle(entry);
    Object.assign(entry, plan.patch);
    await saveWorldInfo(world, worldData, true);

    if (plan.needsIndex) {
        const content = String(entry.content ?? '');
        await vectorInsert(world, [{ hash: getStringHash(content), text: content, index: Number(uid) }]);
    }
    console.log(`${LOG} '${world}' uid ${uid} — ${plan.from} → ${plan.to} (patch=${JSON.stringify(plan.patch)}, 벡터 삽입 ${plan.needsIndex ? '1건' : '없음'})`);
    return plan;
}

/** 대략 토큰수 (chars/4) — 패널 표시용 근사치 */
function approxTokens(text) {
    return Math.max(1, Math.round(String(text ?? '').length / 4));
}

// ── 로어북 매니저(simple-lorebook) 번역본 읽기 (v0.16.0) ─────────────────────
// 타 확장 'Lorebook Manager'가 저장한 번역을 **읽기만** 한다.
//   저장 위치: extension_settings['simple-lorebook'].translations
//   키       : `${book}\u241f${uid}`  (U+241F UNIT SEPARATOR)
//   레코드   : { book, uid, sourceLanguage, language, sourceHash, text, updatedAt }
// 규칙(현이 결정):
//   1) 저쪽 저장소에 쓰기 금지 — saveSettingsDebounced도 저쪽 데이터에 대해선 호출하지 않는다.
//      (매니저 본체는 폴백 히트 시 정확키를 채워넣지만, 우리는 남의 집 가구를 옮기지 않는다.)
//   2) sourceHash 불일치라도 경고·배지 없음. 매니저가 다음 열람 때 스스로 갱신한다.
//   3) 매니저 미설치/자료구조 파손이어도 기존 기능 무손상 — 전부 try/catch + 타입 가드, 실패 시 null.
const MANAGER_EXT = 'simple-lorebook';
const MANAGER_KEY_SEP = '\u241f';
const MANAGER_LANGUAGE_LABELS = { Korean: '한국어', English: '영어' };

/**
 * 매니저의 hashText() 재구현 (FNV-1a 32bit + `_길이`).
 * 저쪽 파일을 import하지 않는다 — 로드 순서 의존이 생기고, 미설치 시 확장 전체가 죽는다.
 */
function managerHashText(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${hash.toString(36)}_${text.length}`;
}

/** 번역 레코드 → 표시용 형태. 본문이 비면 없는 것으로 친다. */
function normalizeManagerRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const text = typeof record.text === 'string' ? record.text : '';
    if (!text.trim()) return null;
    return {
        text,
        language: typeof record.language === 'string' ? record.language : '',
        updatedAt: record.updatedAt ?? null,
    };
}

/**
 * @returns {{text: string, language: string, updatedAt: *}|null}
 * 1차 = 정확키(world+uid만 필요 — 판정표의 박제 본문처럼 원문이 달라져도 맞는다).
 * 2차 = 전체 스캔 폴백(uid + sourceHash 일치). 구분자가 바뀐 옛 데이터 대비, 매니저 자체 폴백과 같은 방식.
 */
function getManagerTranslation(world, uid, sourceText) {
    try {
        const store = extension_settings?.[MANAGER_EXT];
        if (!store || typeof store !== 'object' || Array.isArray(store)) return null;
        const translations = store.translations;
        if (!translations || typeof translations !== 'object' || Array.isArray(translations)) return null;

        const exact = normalizeManagerRecord(translations[`${world}${MANAGER_KEY_SEP}${uid}`]);
        if (exact) return exact;

        const source = String(sourceText ?? '');
        if (!source) return null;
        const sourceHash = managerHashText(source);
        for (const record of Object.values(translations)) {
            if (!record || typeof record !== 'object') continue;
            if (String(record.uid) !== String(uid)) continue;
            if (record.sourceHash !== sourceHash) continue;
            const hit = normalizeManagerRecord(record);
            if (hit) return hit;
        }
        return null;
    } catch (err) {
        return null;
    }
}

/**
 * 전문 펼침 셀 + 상세 행 (v0.6.4).
 * PC·폰 동일하게 클릭 하나. hover는 폰에 없어서 쓰지 않는다.
 * 여러 행을 동시에 펼칠 수 있고(항목끼리 비교용), 높이 제한은 두지 않는다(현이 결정).
 * v0.16.0: meta({world, uid})를 주면 로어북 매니저 번역본을 원문 아래에 자동으로 함께 보여준다.
 */
function buildDetailToggle(content, colSpan, meta = null) {
    const $toggle = $('<span class="jev-detail-toggle" role="button" tabindex="0">')
        .attr('title', '이 항목의 본문 전문을 펼쳐서 봐요')
        .append($('<i class="fa-solid fa-chevron-down">'))
        .append($('<span>').text('전문'));

    const $detailCell = $('<td>').attr('colspan', colSpan)
        .append($('<div class="jev-detail-body">').text(String(content ?? '')));

    // 번역 레코드가 없으면 아무것도 그리지 않는다(빈 상태 UI 없음 — 현이 결정).
    const translation = meta ? getManagerTranslation(meta.world, meta.uid, String(content ?? '')) : null;
    if (translation) {
        const label = MANAGER_LANGUAGE_LABELS[translation.language] || '';
        $detailCell.append($('<div class="jev-detail-translation">')
            .append($('<div class="jev-detail-translation-caption">')
                .text(label ? `로어북 매니저 번역 · ${label}` : '로어북 매니저 번역'))
            .append($('<div class="jev-detail-translation-body">').text(translation.text)));
    }

    const $detail = $('<tr class="jev-detail-row" style="display: none;">').append($detailCell);

    const toggleDetail = () => {
        const opening = $detail.css('display') === 'none';
        $detail.toggle(opening);
        $toggle.toggleClass('jev-open', opening)
            .find('i').toggleClass('fa-chevron-down', !opening).toggleClass('fa-chevron-up', opening);
    };
    $toggle.on('click', toggleDetail);
    $toggle.on('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleDetail(); }
    });

    return { $cell: $('<td class="jev-cell-toggle">').append($toggle), $detail };
}

/**
 * 항목 상태 전환 셀 (v0.17.0 — v0.6.4의 2상태 토글을 3상태로 확장).
 * 🔵 상시(코어) → 🟢 검색층 → ⚫ 꺼짐 → 원래 색. 확인 팝업 없음(기존 전환 버튼과 같은 정책).
 * ⚫ 회색 행에서도 이 버튼이 동작해야 한다 — 확장 안에서 꺼진 항목을 되살릴 수 있는 유일한 경로다.
 */
const ENTRY_STATE_CLASS = Object.freeze({
    [ENTRY_STATE_CORE]: 'jev-is-core',
    [ENTRY_STATE_SEARCH]: 'jev-is-search',
    [ENTRY_STATE_OFF]: 'jev-is-off',
});
const ENTRY_STATE_TITLE = Object.freeze({
    [ENTRY_STATE_CORE]: '상시 메모리(코어) — 누르면 검색층으로 내려요',
    [ENTRY_STATE_SEARCH]: '검색층 메모리 — 누르면 이 항목을 꺼요',
    [ENTRY_STATE_OFF]: '꺼진 항목 — 누르면 원래 상태(상시 또는 검색층)로 되돌려요',
});
const ENTRY_STATE_DONE_TOAST = Object.freeze({
    [ENTRY_STATE_CORE]: '상시 메모리(코어)로 되돌렸어요 — 매 턴 다시 주입돼요',
    [ENTRY_STATE_SEARCH]: '검색층으로 내렸어요 (이 항목만 벡터에 넣었어요)',
    [ENTRY_STATE_OFF]: '이 항목을 껐어요 — 표에 회색으로 남으니 한 번 더 누르면 되돌아와요',
});

function buildStateToggle(world, uid, state, $panel) {
    const $btn = $('<span class="jev-core-toggle" role="button" tabindex="0">')
        .addClass(ENTRY_STATE_CLASS[state] ?? 'jev-is-search')
        .attr('title', ENTRY_STATE_TITLE[state] ?? '')
        .append($('<i class="fa-solid fa-circle">'));

    const run = async () => {
        if ($btn.hasClass('disabled')) return;
        $btn.addClass('disabled');
        try {
            const plan = await cycleEntryState(world, uid);
            toastr.success(ENTRY_STATE_DONE_TOAST[plan.to] ?? '상태를 바꿨어요', 'Jev Lorebook');
            await renderPanelChunks($panel);
            renderPanelSummary($panel);
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Jev Lorebook');
            $btn.removeClass('disabled');
        }
    };
    $btn.on('click', run);
    $btn.on('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); run(); }
    });

    return $('<td class="jev-cell-core">').append($btn);
}

/** 색인된 hash 목록 — 관측 뷰어의 색인 여부 대조용 (src/endpoints/vectors.js:530 POST /list → number[]) */
async function vectorList(worldName) {
    const response = await fetch('/api/vector/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...getEmbeddingBody(),
            collectionId: getCollectionId(worldName),
        }),
    });
    if (!response.ok) {
        throw await vectorError(response, 'list');
    }
    const hashes = await response.json();
    return new Set(Array.isArray(hashes) ? hashes.map(Number) : []);
}

// ── Jev 3축 판정 ────────────────────────────────────────────────────────

/** 경로별 Jev 요청 헤더 — 플러그인은 X-Jev-Key(패스스루), 내장 CORS 프록시는 Bearer 직접 전달 */
function buildJevHeaders(kind, apiKey) {
    if (kind === 'plugin') {
        // 플러그인 라우트에도 CSRF가 걸린다 (server-main.js:202 전역 csrfSync)
        return { ...getRequestHeaders(), 'X-Jev-Key': apiKey };
    }
    // 내장 CORS 프록시: CSRF 검사는 ST가 받고(getRequestHeaders의 토큰 필요, /proxy 마운트가 csrfSync 뒤라 검사 대상),
    // corsProxy.js가 업스트림 직전에 x-csrf-token/cookie/origin을 제거하고 Authorization은 통과시킨다.
    return { ...getRequestHeaders(), 'Authorization': `Bearer ${apiKey}` };
}

/**
 * 전송 경로 감지 — 세션당 1회, 판정 실패 턴 이후 재감지. 빈 바디 프로브 1회(업스트림 4xx는 "경로 살아있음" 증거로 충분).
 * - 플러그인 부재 → 404 (라우트 미등록) / 내장 프록시 꺼짐 → 404 + 안내문 (server-main.js:260~263)
 * - basicAuth 충돌 → 401 (Bearer가 Basic을 덮음 — 2026-09-20 실측 지뢰) → CORS 경로 사용 불가
 */
async function detectJevTransport(apiKey) {
    // 1순위: jev-proxy 서버 플러그인 — 404가 아니면 이 경로 고정
    let pluginFailReason = '';
    try {
        const r = await fetch(JEV_PLUGIN_API, {
            method: 'POST',
            headers: buildJevHeaders('plugin', apiKey),
            body: '{}',
            signal: AbortSignal.timeout(JEV_PROBE_TIMEOUT_MS),
        });
        if (r.status !== 404) {
            return { kind: 'plugin', endpoint: JEV_PLUGIN_API, label: '서버 플러그인 (jev-proxy)' };
        }
        pluginFailReason = '라우트 미등록(HTTP 404) — 서버 플러그인이 설치 안 됨';
    } catch (error) {
        pluginFailReason = String(error?.message ?? error);
        console.log(`${LOG} 플러그인 경로 프로브 실패 — 다음 경로 시도: ${pluginFailReason}`);
    }
    // 2순위: ST 내장 CORS 프록시 (config.yaml enableCorsProxy, server-main.js:258 마운트)
    let corsFailReason = '';
    try {
        const r = await fetch(JEV_CORS_API, {
            method: 'POST',
            headers: buildJevHeaders('cors', apiKey),
            body: '{}',
            signal: AbortSignal.timeout(JEV_PROBE_TIMEOUT_MS),
        });
        // 브라우저가 basicAuth 401을 가로채 로그인 팝업을 띄우므로 fetch 코드까지 401이 오는 일은 거의 없다(2026-09-20 실측) —
        // 대신 타임아웃으로 나타난다(아래 catch 참조). 만에 하나 도달하는 환경 대비로 분기는 그대로 유지.
        if (r.status === 401) {
            corsFailReason = 'basicAuth 충돌(401) — Authorization을 Bearer가 덮어서 이 서버엔 플러그인만 가능';
        } else if (r.status === 404) {
            corsFailReason = '내장 CORS 프록시 꺼짐(404)';
        } else {
            return { kind: 'cors', endpoint: JEV_CORS_API, label: 'ST 내장 CORS 프록시 (/proxy)' };
        }
    } catch (error) {
        const msg = String(error?.message ?? error);
        // basicAuth가 켜진 서버는 브라우저가 인증창을 띄우며 요청을 붙잡아 타임아웃으로만 나타난다 (2026-09-20 실측)
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timed out|timeout/i.test(msg);
        corsFailReason = isTimeout
            ? `타임아웃(${msg}) — 로그인(basicAuth) 서버에서 브라우저가 인증 창을 띄우며 요청을 붙잡았을 가능성 — 이 서버에선 CORS 경로 대신 플러그인 경로를 쓰세요`
            : msg;
    }
    const fixGuide = '해결: 확장 폴더 안 server-plugin 폴더를 SillyTavern/plugins/jev-proxy로 복사(최종 SillyTavern/plugins/jev-proxy/index.js) → config.yaml에 enableServerPlugins: true → 서버 재시작.';
    console.error(`${LOG} 연결 경로 감지 실패 — 플러그인: ${pluginFailReason} / CORS: ${corsFailReason} / ${fixGuide}`);
    throw new Error(`Jev 연결 경로가 없어요 (플러그인 경로: ${pluginFailReason}, CORS 경로: ${corsFailReason}). ${fixGuide}`);
}

/** 감지 결과 보장 — 캐시 있으면 재사용, 없으면 감지 후 캐시 */
async function ensureJevTransport(apiKey) {
    if (jevTransport) return jevTransport;
    try {
        jevTransport = await detectJevTransport(apiKey);
        lastTransportError = null;
        console.log(`${LOG} Jev 전송 경로 감지: ${jevTransport.label}`);
        return jevTransport;
    } catch (error) {
        lastTransportError = String(error?.message ?? error);
        throw error;
    }
}

/**
 * 후보 1건 판정. 실패 시 throw — 폴백 없음. 전송은 감지된 경로(jevTransport) 사용 — ensureJevTransport 선행 필수.
 * @returns {Promise<{contradiction:number, sceneFit:number, duplicate:number}>}
 */
async function judgeCandidate(apiKey, sceneExcerpt, candidate) {
    const transport = jevTransport;
    if (!transport) {
        throw new Error('Jev 전송 경로 미감지 — ensureJevTransport가 선행되지 않았다');
    }
    const body = {
        model: JEV_MODEL,
        state: {
            recent_chat_excerpt: sceneExcerpt,
            candidate_memory: {
                title: candidate.title,
                content: String(candidate.text || '').slice(0, 6000),
            },
        },
        questions: {
            contradiction_risk: {
                type: 'noul',
                instructions: 'If this memory is NOT injected, is the next reply likely to contradict established facts referenced in the recent chat?',
                criteria: {
                    true: 'The memory contains facts (events, relationships, states) that the recent chat touches on; omitting it risks a factual contradiction in the next reply.',
                    false: 'The memory is unrelated to what is currently being discussed; omitting it carries no contradiction risk.',
                },
            },
            scene_fit: {
                type: 'noul',
                instructions: 'Does this memory overlap with the current scene in characters, place, or time?',
                criteria: {
                    true: 'Same characters, location, or timeframe as the current scene.',
                    false: 'Different characters, place, and time from the current scene.',
                },
            },
            recent_duplicate: {
                type: 'noul',
                instructions: 'Is the substantive content of this memory already present in the recent chat excerpt?',
                criteria: {
                    true: 'The recent chat already states this information; injecting it adds nothing.',
                    false: 'This information is not present in the recent chat.',
                },
            },
        },
    };

    const response = await fetch(transport.endpoint, {
        method: 'POST',
        headers: buildJevHeaders(transport.kind, apiKey),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });

    if (response.status === 404) {
        throw new Error(`Jev 경로 404 — 감지됐던 경로(${transport.label})가 사라졌어요. 다음 턴에 다시 감지할게요`);
    }
    if (!response.ok) {
        throw new Error(`Jev HTTP ${response.status} (경로: ${transport.label})`);
    }

    const payload = await response.json();
    const answers = payload?.answers;
    if (!answers) {
        throw new Error('Jev 응답에 answers가 없어요');
    }

    return {
        contradiction: Number(answers.contradiction_risk?.noul ?? 0),
        sceneFit: Number(answers.scene_fit?.noul ?? 0),
        duplicate: Number(answers.recent_duplicate?.noul ?? 0),
    };
}

/** 3축 → 최종 점수. 모순위험·장면적합으로 올리고, 최근중복으로 깎는다. */
function finalScore(scores) {
    return (0.6 * scores.contradiction + 0.4 * scores.sceneFit) * (1 - scores.duplicate);
}

// ── 컨텍스트 발췌 ───────────────────────────────────────────────────────

/**
 * 검색 쿼리: 최근 유저 메시지들 + 직전 캐릭터 응답 1개.
 * 유저 발화만 쓰면 장면의 인물·장소 이름이 쿼리에서 빠진다 — 그건 대부분 캐릭 응답 쪽에 있다.
 * 실측(2026-09-20): 직전 응답을 붙이면 Jev 상위 항목의 검색순위가 20위→20위 밖 → 2~7위로 올라온다.
 */
function buildQueryText(chat) {
    const userMessages = chat
        .filter(x => x.is_user && String(x.mes || '').trim())
        .slice(-QUERY_USER_MESSAGES)
        .map(x => String(x.mes));
    const base = userMessages.join('\n').slice(-2000);
    const lastChar = [...chat].reverse().find(x => !x.is_user && String(x.mes || '').trim());
    const tail = lastChar ? String(lastChar.mes) : '';
    return (tail ? `${base}\n${tail}` : base).slice(-2000);
}

/** Jev에 보여줄 최근 장면 발췌 */
function buildSceneExcerpt(chat) {
    const lines = chat
        .filter(x => String(x.mes || '').trim())
        .slice(-SCENE_MESSAGES)
        .map(x => `${x.name || (x.is_user ? 'User' : 'Char')}: ${String(x.mes)}`);
    return lines.join('\n').slice(-5000);
}

/**
 * FORCE_ACTIVATE로 보낼 엔트리 (v0.9.3).
 *
 * ⚠ ST는 이 이벤트로 받은 객체 그자체를 활성 엔트리로 쓴다:
 *   world-info.js:1025  externalActivations.set(key, entry)  <- 우리 객체 원본을 그대로 저장
 *   world-info.js:4776  activatedNow.add(buffer.getExternallyActivated(entry))
 *   world-info.js:5086  getRegexedString(entry.content, ...)
 *   world-info.js:5088  content가 비면 'skipped adding to prompt due to empty content' 로 버려짐
 *
 * 즉 {world, uid}만 보내면 발동 로그는 찍히는데 프롬프트엔 아무것도 안 들어간다.
 * v0.1~v0.9.2 내내 그 상태였다 - 판정만 돌고 주입은 0이었다.
 * 패널의 Jev 행이 제목 'uid N' · 0tok으로 뜨던 게 그 증거다 (2026-09-20 스샷 제보).
 */
function buildForceEntry(a) {
    return a.raw ? { ...a.raw, world: a.world, uid: a.uid } : { world: a.world, uid: a.uid };
}

/**
 * 🎲 쿨다운 링버퍼 크기 — 순수 함수(단위검증 대상). v0.17.0에서 하한을 완화했다.
 *
 * 구 공식 `max(5, floor(n/3))`은 항목이 적은 북에서 하한 5가 풀 거의 전체를 덮어
 * "방금 뽑힌 것 빼면 남는 게 없음" 상태를 만들었다(풀 6 → 쿨다운 5 → 가용 1).
 * 하한을 '풀의 절반까지'로 조인다 → 풀 6 = 3 · 풀 20 = 6 · 풀 50 = 16.
 * 풀 0·1에서는 0이 나온다 — 호출부는 `slice(-0)`이 배열 전체를 돌려주는 함정을 따로 막아야 한다.
 */
function randomCooldownSize(poolSize) {
    const n = Math.max(0, Math.floor(Number(poolSize) || 0));
    return Math.max(Math.min(5, Math.floor(n / 2)), Math.floor(n / 3));
}

/**
 * 🎲 랜덤 주입 후보 뽑기 (v0.15.0 · v0.17.0에서 북별 루프로 전환).
 *
 * 발주 의도: 장면 유사성이 있는 부분에서만 나와서 의외의 내용이 영영 안 나오는 걸 막는 장치.
 * 그래서 **벡터 검색도 Jev 판정도 거치지 않는다** — 색인이 안 된 로어북도 후보에 들어간다.
 *
 * v0.17.0 — 통합 풀 하나를 북별 루프로 갈랐다. 북마다 따로 쓰는 것 셋:
 *   ① 랜덤 켜기(북별 유효값) ② 예산(북별 유효값) ③ 쿨다운 링버퍼(recentRandomUids의 world 키)
 *
 * 제외: constant(코어 — ST가 매턴 네이티브 주입) / disable / 본문 빈 것 /
 *       이번 턴 Jev 채택분(excludeKeys — 중복 주입 방지) / 그 북에서 쿨다운 중인 uid.
 * 한 항목이 남은 예산을 넘으면 건너뛰고 다음 후보를 본다(자투리 활용 — Jev 컷과 같은 규칙).
 * 담을 게 없으면 0개로 조용히 끝낸다. 토스트는 띄우지 않는다.
 *
 * @param {string[]} worlds 대상 로어북 이름 (getTargetWorlds — 4계층 전부)
 * @param {Set<string>} excludeKeys 제외할 `${world}.${uid}`
 * @returns {Promise<Array>} 북별 결과를 합친 것
 */
async function pickRandomEntries(worlds, excludeKeys) {
    const picked = [];
    for (const world of worlds) {
        if (!isRandomEnabled(world)) continue; // 북별 켜기 — 전역이 켜져 있어도 이 북만 끌 수 있다
        const budget = getRandomBudget(world);
        if (budget <= 0) continue;

        let worldData;
        try {
            worldData = await loadWorldInfo(world);
        } catch (error) {
            console.log(`${LOG} 🎲 '${world}' 읽기 실패 — 이 로어북만 건너뜀: ${error?.message ?? error}`);
            continue;
        }

        const pool = [];
        for (const entry of Object.values(worldData?.entries ?? {})) {
            if (!entry || entry.disable || entry.constant) continue;
            const text = String(entry.content ?? '').trim();
            if (!text) continue;
            const key = `${world}.${entry.uid}`;
            if (excludeKeys.has(key)) continue;
            pool.push({ world, uid: entry.uid, key, text, title: String(entry.comment || `uid ${entry.uid}`), raw: entry });
        }
        if (!pool.length) continue;

        // 쿨다운 때문에 후보가 0이 되면 무시하고 다시 뽑는다(항목 적은 로어북 보호)
        const cooldownSize = randomCooldownSize(pool.length);
        const ring = recentRandomUids.get(world) ?? [];
        const cooled = new Set(ring);
        let avail = pool.filter(p => !cooled.has(p.key));
        const cooledOut = pool.length - avail.length;
        let cooldownIgnored = false;
        if (!avail.length) {
            avail = pool.slice();
            cooldownIgnored = true;
        }

        // Fisher-Yates 셔플
        for (let i = avail.length - 1; i > 0; i--) {
            const k = Math.floor(Math.random() * (i + 1));
            [avail[i], avail[k]] = [avail[k], avail[i]];
        }

        const worldPicked = [];
        let used = 0;
        for (const cand of avail) {
            if (used >= budget) break;
            const tokens = await getTokenCountAsync(cand.text);
            if (used + tokens > budget) continue; // 남은 예산에 드는 다음 후보 탐색
            used += tokens;
            worldPicked.push({ ...cand, tokens });
        }
        if (!worldPicked.length) {
            console.log(`${LOG} 🎲 '${world}' 0건 — 풀 ${pool.length}개 / 쿨다운 제외 ${cooledOut}개 / 예산 ${budget}토큰에 드는 항목 없음`);
            continue;
        }

        // ⚠ cooldownSize가 0이면 slice(-0)이 배열 '전체'를 돌려준다 — 링버퍼가 무한히 자란다. 0은 따로 막는다.
        const nextRing = [...ring, ...worldPicked.map(p => p.key)];
        recentRandomUids.set(world, cooldownSize > 0 ? nextRing.slice(-cooldownSize) : []);
        console.log(`${LOG} 🎲 '${world}' ${worldPicked.length}건 · ${used}/${budget}토큰 · 풀 ${pool.length}개 · 쿨다운 제외 ${cooledOut}개${cooldownIgnored ? '(무시함)' : ''} · 링버퍼 ${(recentRandomUids.get(world) ?? []).length}/${cooldownSize} · [${worldPicked.map(p => `#${p.uid}`).join(', ')}]`);
        picked.push(...worldPicked);
    }
    return picked;
}

/** 이번 턴 랜덤 선택을 기억한다 — 캐시 히트 재주입과 패널 🎲 분류가 같은 출처를 봐야 한다 */
function rememberRandomPicks(picks) {
    lastRandomItems = picks.map(p => ({ world: p.world, uid: p.uid, raw: p.raw }));
    lastRandomKeys = new Set(picks.map(p => `${p.world}.${p.uid}`));
}

/** 채팅이 바뀌면 쿨다운·직전 선택을 비운다 — 다른 채팅의 이력이 남으면 새 채팅 첫 턴이 편향된다 */
function resetRandomCooldown() {
    recentRandomUids = new Map();
    lastRandomItems = [];
    lastRandomKeys = new Set();
}

// ── generate_interceptor ────────────────────────────────────────────────

async function jevLorebookInterceptor(chat, _contextSize, _abort, type) {
    const settings = getSettings();
    console.log(`${LOG} interceptor 진입 — type=${type} enabled=${settings.enabled} 대상=${settings.world ? `고정:${settings.world}` : '자동'} key=${settings.jevApiKey ? 'set' : 'MISSING'}`);
    if (!settings.enabled) { console.log(`${LOG} enabled=false — 건너뜀`); return; }
    if (conversionInProgress) { console.log(`${LOG} 변환 파이프라인 진행 중 — 이 생성은 건너뜀`); return; }
    // quiet도 판정한다: QR/스크립트 경유 RP는 실턴이 전부 type=quiet로 들어온다 (2026-09-20 실측).
    // 같은 턴의 연쇄 quiet 생성은 아래 판정 캐시가 Jev 중복 호출을 막는다.
    if (!settings.jevApiKey) {
        toastr.error('Jev API 키가 필요해요. 이번 턴은 주입 없이 넘어갈게요. (폴백은 없어요)', 'Jev Lorebook');
        return;
    }

    const t0 = performance.now();
    try {
        const queryText = buildQueryText(chat);
        if (!queryText) {
            console.log(`${LOG} 유저 메시지 없음 — 건너뜀`);
            return;
        }

        // 대상 로어북: 켜진 층에서 감지된 것 전부 (v0.8.0 — ST 본체와 같은 4계층)
        const worlds = getTargetWorlds();
        if (!worlds.length) {
            console.log(`${LOG} 켜진 층에서 감지된 로어북 없음 — 건너뜀 (특정 로어북을 강제하려면 설정의 고정 대상)`);
            return;
        }

        // 판정 캐시: 동일 쿼리 60초 이내면 Jev를 다시 부르지 않는다.
        // 단 FORCE_ACTIVATE는 스캔 1회용이라 주입은 매번 다시 쏜다.
        const cacheKey = getStringHash(worlds.join('|') + '\u0000' + queryText);
        if (cacheKey === lastJudgment.key && (Date.now() - lastJudgment.ts) < JUDGMENT_CACHE_MS) {
            // 🎲 캐시 히트 턴에는 새로 뽑지 않는다 — 같은 턴의 연쇄 quiet 생성에서 주입물이 흔들리면 안 된다 (v0.15.0)
            const cachedItems = [...lastJudgment.items, ...lastRandomItems];
            if (cachedItems.length) {
                await eventSource.emit(
                    event_types.WORLDINFO_FORCE_ACTIVATE,
                    cachedItems.map(buildForceEntry),
                );
            }
            if (lastRandomItems.length) {
                console.log(`${LOG} 🎲 랜덤 ${lastRandomItems.length}건 재주입 (캐시 히트 — 새로 뽑지 않음)`);
            }
            if (lastReport) {
                lastReport.cacheHits = (lastReport.cacheHits || 0) + 1;
            }
            console.log(`${LOG} 판정 캐시 재사용 — ${lastJudgment.items.length}건 재주입 (Jev 호출 없음)`);
            return;
        }

        // 1. 후보 회수 — 대상 로어북별로 회수해 합친다
        const candidates = [];
        for (const world of worlds) {
            let metadata;
            try {
                ({ metadata } = await vectorQuery(world, queryText, getQueryTopK(world)));
            } catch (error) {
                console.log(`${LOG} '${world}' 회수 실패(색인 안 됨?) — 이 로어북만 건너뜀: ${error?.message ?? error}`);
                continue;
            }
            const worldData = await loadWorldInfo(world);
            const entries = worldData?.entries ?? {};
            for (const m of (metadata ?? [])) {
                // constant 항목(코어 메모리)은 ST가 매턴 네이티브 주입 — 우리가 또 넣으면 이중이라 후보에서 제외
                if (!entries[m.index] || entries[m.index].disable || entries[m.index].constant) continue;
                candidates.push({
                    world,
                    uid: Number(m.index),
                    text: String(m.text ?? entries[m.index].content ?? ''),
                    title: String(entries[m.index].comment || `uid ${m.index}`),
                    raw: entries[m.index],   // v0.9.3 - FORCE_ACTIVATE에 원본 엔트리를 실어야 한다 (buildForceEntry 주석)
                });
            }
        }

        if (!candidates.length) {
            // 🎲 랜덤은 검색·판정과 무관하다 — 색인이 없어 회수가 통째로 실패해도 여기서 발사한다 (v0.15.0)
            const randomOnly = await pickRandomEntries(worlds, new Set());
            rememberRandomPicks(randomOnly);
            if (randomOnly.length) {
                await eventSource.emit(
                    event_types.WORLDINFO_FORCE_ACTIVATE,
                    randomOnly.map(buildForceEntry),
                );
            }
            console.log(`${LOG} 후보 0건 — 대상(${worlds.join(', ')})이 색인돼 있는지 확인해라 ([색인] 버튼)`);
            return;
        }

        // 2. 전송 경로 확보(세션당 1회 감지, 병렬 판정 전 단일 실행) → Jev 3축 병렬 판정 — 하나라도 실패하면 이번 턴 주입 0
        await ensureJevTransport(settings.jevApiKey);
        const sceneExcerpt = buildSceneExcerpt(chat);
        const judged = await Promise.all(candidates.map(async c => {
            const scores = await judgeCandidate(settings.jevApiKey, sceneExcerpt, c);
            return { ...c, ...scores, final: finalScore(scores) };
        }));

        // 3. 북별 점수순 정렬 → 북별 예산 컷 (v0.17.0)
        // v0.16.0까지는 전역 예산 1벌로 전 북을 한 줄에 세워 잘랐다. 그러면 큰 북이 예산을 먼저 다 먹고
        // 작은 북은 점수가 높아도 한 건도 못 들어간다 — 예산·topK를 북별로 덮어쓰려면 컷도 북별이어야 한다.
        // 회수(vectorQuery)는 v0.8.0부터 이미 북별 루프였다(위 1단계) — 이번에 바뀐 건 예산 컷 쪽뿐이다.
        // ⚠ 실효 총예산 = 북별 유효 예산의 '합'이다. 북이 3개면 전역 기본 4,000에서 최대 12,000까지 쓴다.
        //   팝업 A의 「주입 예산 합계」 한 줄이 그 합을 그대로 보여준다.
        const adopted = [];
        const ranked = [];
        const budgetByWorld = new Map();
        let usedTokens = 0;
        for (const world of worlds) {
            const budget = getBudgetTokens(world);
            budgetByWorld.set(world, budget);
            const worldRanked = judged.filter(j => j.world === world).sort((a, b) => b.final - a.final);
            let used = 0;
            let worldAdopted = 0;
            for (const item of worldRanked) {
                if (item.final < SCORE_FLOOR) break; // 정렬됐으니 이후는 전부 하한 미만
                // v0.9.4 — 개수 상한은 없다. 컷은 SCORE_FLOOR와 예산 둘뿐이다.
                // 발주자 확정(2026-09-20): 키워드 발동과 별개로 Jev는 설정 상한 토큰까지 다 채운다.
                const tokens = await getTokenCountAsync(item.text);
                if (used + tokens > budget) continue; // 남은 예산에 드는 다음 후보 탐색
                used += tokens;
                worldAdopted++;
                adopted.push({ ...item, tokens });
            }
            usedTokens += used;
            ranked.push(...worldRanked);
            console.log(`${LOG} '${world}' 예산 컷 — 후보 ${worldRanked.length} → 채택 ${worldAdopted} / ${used}/${budget}토큰`);
        }

        lastJudgment = { key: cacheKey, items: adopted.map(a => ({ world: a.world, uid: a.uid, raw: a.raw })), ts: Date.now() };

        // 4. 주입
        // 🎲 랜덤은 별도 예산이라 위 컷 결과를 바꾸지 않는다. 이번 턴 채택분은 후보에서 빼고(중복 주입 방지)
        //    같은 배열에 합쳐 한 번에 emit한다 — 주입 경로는 buildForceEntry 하나로 통일 (v0.15.0)
        const randomPicks = await pickRandomEntries(worlds, new Set(adopted.map(a => `${a.world}.${a.uid}`)));
        rememberRandomPicks(randomPicks);
        const forceEntries = [...adopted, ...randomPicks].map(buildForceEntry);
        if (forceEntries.length) {
            await eventSource.emit(
                event_types.WORLDINFO_FORCE_ACTIVATE,
                forceEntries,
            );
        }

        // 5. 관측
        const ms = Math.round(performance.now() - t0);
        const adoptedKeys = new Set(adopted.map(a => `${a.world}.${a.uid}`));
        const adoptedTokens = new Map(adopted.map(a => [`${a.world}.${a.uid}`, a.tokens]));
        // 세부 패널용 리포트 — 콘솔 없이도 직전 판정을 볼 수 있게 모듈 상태에 저장
        lastReport = {
            ts: Date.now(),
            type: String(type),
            worlds: worlds.slice(),
            candidateCount: candidates.length,
            adoptedCount: adopted.length,
            usedTokens,
            ms,
            cacheHits: 0,
            rows: ranked.map(r => ({
                world: String(r.world),
                uid: r.uid,
                title: r.title,
                // 판정 시점의 본문을 그대로 보관한다(v0.6.4) — 나중에 항목이 수정돼도
                // "그때 Jev가 무엇을 보고 판단했는지"가 흐려지면 안 된다.
                text: String(r.text ?? ''),
                contradiction: r.contradiction,
                sceneFit: r.sceneFit,
                duplicate: r.duplicate,
                final: r.final,
                adopted: adoptedKeys.has(`${r.world}.${r.uid}`),
                tokens: adoptedTokens.get(`${r.world}.${r.uid}`) ?? null,
            })),
        };
        lastError = null;
        console.log(`${LOG} 후보 ${candidates.length} → 채택 ${adopted.length} / ${usedTokens}토큰 / ${ms}ms — 대상: ${worlds.join(', ')}`);
        console.table(ranked.map(r => ({
            채택: adoptedKeys.has(`${r.world}.${r.uid}`) ? '✓' : '',
            월드: String(r.world).slice(0, 14),
            uid: r.uid,
            제목: r.title.slice(0, 40),
            모순위험: r.contradiction.toFixed(2),
            장면적합: r.sceneFit.toFixed(2),
            최근중복: r.duplicate.toFixed(2),
            최종: r.final.toFixed(3),
        })));
    } catch (error) {
        lastError = { ts: Date.now(), message: String(error?.message ?? error) };
        jevTransport = null; // 판정 실패 → 다음 턴 전송 경로 재감지 (플러그인/프록시가 중간에 꺼진 경우 대응)
        console.error(`${LOG} 실패 — 이번 턴 주입 0 (폴백 없음)`, error);
        toastr.error(`Jev 판정에 실패했어요: ${error?.message ?? error}. 이번 턴은 주입 없이 넘어갈게요.`, 'Jev Lorebook');
    }
}

globalThis.jevLorebookInterceptor = jevLorebookInterceptor;
console.log(`${LOG} 모듈 로드 v0.5.1 — interceptor 등록: ${typeof globalThis.jevLorebookInterceptor}`);

// ── 색인 ────────────────────────────────────────────────────────────────

/**
 * 로어북 1개 색인 (purge 후 재삽입). content만 임베딩 — key(날짜·키워드)는 구분자일 뿐 유사도 대상이 아니다.
 * @param {string} world 로어북 이름
 * @param {(text:string)=>void} [onProgress] 진행 콜백
 * @returns {Promise<number>} 색인된 항목 수
 */
async function indexWorld(world, onProgress) {
    const worldData = await loadWorldInfo(world);
    // constant 항목(코어 메모리)은 색인 제외 — ST 네이티브 매턴 주입이라 검색층에 있으면 이중 주입된다
    const entries = Object.values(worldData?.entries ?? {})
        .filter(e => !e.disable && !e.constant && String(e.content ?? '').trim());

    if (!entries.length) {
        console.log(`${LOG} '${world}' — 색인할 항목 0, 건너뜀`);
        return 0;
    }

    const items = entries.map(e => ({
        hash: getStringHash(String(e.content)),
        text: String(e.content),
        index: Number(e.uid),
    }));

    await vectorPurge(world);
    for (let i = 0; i < items.length; i += INSERT_CHUNK) {
        await vectorInsert(world, items.slice(i, i + INSERT_CHUNK));
        onProgress?.(`색인 중… ${world}: ${Math.min(i + INSERT_CHUNK, items.length)}/${items.length}`);
    }
    console.log(`${LOG} 색인 완료: ${world} → ${items.length}개 항목, collectionId=${getCollectionId(world)}`);
    return items.length;
}

async function indexLorebook() {
    const settings = getSettings();
    const worlds = getTargetWorlds();
    if (!worlds.length) {
        toastr.warning('색인할 대상이 없어요. 채팅·캐릭터·전역·페르소나 중 한 곳에 로어북을 연결하거나, 설정에서 고정 대상을 선택해 주세요.', 'Jev Lorebook');
        return;
    }

    const $button = $('#jev_lorebook_index');
    const $status = $('#jev_lorebook_status');
    $button.addClass('disabled');
    $status.text('색인 중…');

    try {
        let totalItems = 0;
        for (const world of worlds) {
            totalItems += await indexWorld(world, text => $status.text(text));
        }

        if (!totalItems) {
            toastr.warning('색인할 항목이 없어요 (활성 상태이면서 본문이 있는 항목이 없어요).', 'Jev Lorebook');
            $status.text('');
            return;
        }

        $status.text(`색인 완료: ${worlds.length}개 로어북 / ${totalItems}개 항목 (${new Date().toLocaleTimeString()})`);
        toastr.success(`${totalItems}개 항목 색인을 마쳤어요 — ${worlds.join(', ')}`, 'Jev Lorebook');
        settings.embeddingDirty = false; // 새 임베딩 설정으로 재색인 완료 — 경고 해제
        saveSettingsDebounced();
        $('#jev_lorebook_reindex_warning').hide();
    } catch (error) {
        console.error(`${LOG} 색인 실패`, error);
        toastr.error(`색인에 실패했어요: ${error?.message ?? error}`, 'Jev Lorebook');
        $status.text('색인에 실패했어요');
    } finally {
        $button.removeClass('disabled');
    }
}

// ── 챗 → 로어북 변환 파이프라인 (v0.3) ─────────────────────────────────

/**
 * 메시지의 raw moment. ST send_date 포맷이 제각각이라 timestampToMoment(utils.js:1079) 사용.
 * v0.7.0에서 messageDay(문자열 날짜)를 걷어냈다 — 장면 경계는 날짜가 바뀌었나가 아니라
 * 실제 시간이 얼마나 벌어졌나로 판정하고, 실제 날짜 자체는 전사에 넣지 않기 때문이다.
 */
function messageMoment(message) {
    try {
        const m = timestampToMoment(message?.send_date);
        return m?.isValid?.() ? m : null;
    } catch {
        return null;
    }
}

/** 변환 대상 메시지 수집: is_system(숨김)·빈 본문 제외. [startIndex, endIndex) — 끕은 보존 버퍼 경계 */
function collectFreshMessages(chat, startIndex, endIndex) {
    const fresh = [];
    for (let i = startIndex; i < endIndex; i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const mes = String(m.mes || '').trim();
        if (!mes) continue;
        const mom = messageMoment(m);
        fresh.push({
            name: String(m.name || (m.is_user ? 'User' : 'Char')),
            mes,
            day: mom?.format('YYYY-MM-DD') ?? '',
            // raw 타임스탬프(ms)도 같이 든다 (v0.7.0) — 전사의 장면 경계는
            // '날짜가 바뀜나'가 아니라 '몇 시간 비었나'로 가른다
            ts: mom ? mom.valueOf() : null,
        });
    }
    return fresh;
}

/** 메시지들을 토큰 예산 단위 슬라이스로 분할 (메시지 경계 유지) */
async function buildSlices(messages, sliceTokens) {
    const budget = clampSetting(sliceTokens, SLICE_TOKENS_MIN, SLICE_TOKENS_MAX, DEFAULT_SLICE_TOKENS);
    const slices = [];
    let current = [];
    let currentTokens = 0;
    for (const m of messages) {
        const line = `${m.name}: ${m.mes}`;
        const tokens = await getTokenCountAsync(line);
        if (current.length && currentTokens + tokens > budget) {
            slices.push(current);
            current = [];
            currentTokens = 0;
        }
        current.push({ ...m, line });
        currentTokens += tokens;
    }
    if (current.length) slices.push(current);
    return slices;
}

/** 슬라이스 → 전사 텍스트. 날짜가 바뀌는 지점에 [Date: …] 마커 삽입 */
function sliceToTranscript(slice) {
    const gapMs = REAL_GAP_HOURS * 60 * 60 * 1000;
    const lines = [];
    let prevTs = null;
    for (const m of slice) {
        if (prevTs !== null && m.ts !== null && (m.ts - prevTs) >= gapMs) {
            lines.push('');
            lines.push('[--- scene break ---]');
        }
        if (m.ts !== null) prevTs = m.ts;
        lines.push(m.line);
    }
    return lines.join('\n').trim();
}

/**
 * 응답 끝줄이 문장으로 닫혔는지 — 잘림 휴리스틱(양쪽 경로 공통).
 * 토큰 수 비교는 프로필 경로에서만 쓸 수 있다(현재 연결은 상한을 모른다) — 그래서 글자 모양으로도 한 번 더 본다.
 */
const STRUCTURAL_TAIL_RE = /^(?:[-*_=]{3,}$|#{1,6}\s|>\s|\||\**\s*Keywords?\s*:|[-*•+]\s+|\d+[.)]\s+)/i;
function looksTruncated(text) {
    const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return false;
    // 우리 프롬프트가 시키는 구조적 줄(구분선·헤더·Keywords·불릿)은 문장부호로 안 끝나는 게 정상이다.
    // 이걸 안 걸러서 정상 출력마다 오탐이 났다 (v0.10.0 수정).
    if (STRUCTURAL_TAIL_RE.test(last)) return false;
    return !SENTENCE_END_RE.test(last);
}

/**
 * 변환 출력 파싱: `### YYYY-MM-DD — <title>` 헤더로 쪼개고 `Keywords: …` 줄을 분리.
 * `### CORE STATE` 이후는 코어 스냅샷으로 별도 수집 (사건 헤더가 다시 나오면 코어 종료).
 * @returns {{incidents: {date:string, title:string, keywords:string[], body:string}[], core: string}}
 */
function parseConversionOutput(text) {
    const incidents = [];
    const coreLines = [];
    // 날짜 뒤의 `#3` 같은 번호를 선택적으로 허용한다 (v0.7.0) — 프롬프트로 금지했지만
    // 모델이 붙이면 헤더 자체가 매칭 실패해 사건이 통째로 날아간다. 번호는 읽고 버리고 코드가 다시 부여한다.
    const headerRe = /^#{2,4}\s*(\d{4}-\d{2}-\d{2})(?:\s*#\s*\d+)?\s*[—–:\-]?\s*(.*)$/;
    const coreRe = /^#{2,4}\s*\**\s*CORE\s+STATE\b/i;
    const keywordRe = /^\s*\**\s*Keywords?\s*:\s*(.+?)\**\s*$/i;
    let current = null;
    let inCore = false;
    const flush = () => {
        if (!current) return;
        current.body = current.bodyLines.join('\n').trim();
        delete current.bodyLines;
        if (current.body) incidents.push(current);
        current = null;
    };
    for (const line of String(text || '').split('\n')) {
        if (coreRe.test(line)) {
            flush();
            inCore = true;
            continue;
        }
        const header = line.match(headerRe);
        if (header) {
            flush();
            inCore = false;
            current = {
                date: header[1],
                title: (header[2] || '').replace(/[#*]/g, '').trim() || '(무제)',
                keywords: [],
                bodyLines: [],
            };
            continue;
        }
        if (inCore) {
            if (keywordRe.test(line)) continue; // 코어 섹션엔 키워드 줄이 없다 — 모델이 붙여도 버린다
            coreLines.push(line);
            continue;
        }
        if (!current) continue; // 첫 헤더 이전의 서두는 버린다
        const keyword = line.match(keywordRe);
        if (keyword) {
            current.keywords = keyword[1].split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
            continue;
        }
        current.bodyLines.push(line);
    }
    flush();
    return { incidents, core: coreLines.join('\n').trim() };
}

/**
 * 코어 규칙/일기 탐색 (v0.13.0 · v0.17.0 수정). 조건은 `constant === true` + comment 형식, 둘뿐이다.
 *
 * v0.16.0까지는 `!e.disable`도 조건이었다 — 그래서 ⭐ Core Rules를 끄면 다음 변환이 '규칙 없음'으로 판단해
 * **새 규칙 항목을 또 만들었다.** 나중에 되살리면 코어가 2개가 되고 둘 다 constant라 매 턴 둘 다 주입된다.
 * v0.17.0부터 꺼진 코어도 찾아서 갱신 대상으로 **재사용**한다. 단 `disable`은 어느 경로에서도 건드리지 않는다 —
 * 사용자가 끈 의도를 존중해 '갱신은 되고 꺼진 채 남는다'가 계약이다.
 * (constant를 조건에 남기는 이유는 그대로다: 🔵🟢으로 검색층에 내린 옛 일기를 다음 변환이 '열린 일기'로 오인하면 안 된다.)
 */
function findCoreRulesEntry(worldData) {
    return Object.values(worldData?.entries ?? {}).find(e => e.constant && e.comment === CORE_RULES_COMMENT) ?? null;
}

const CORE_DIARY_COMMENT_RE = /^⭐ Core Diary(?:\s*\(sealed\))?\s*·\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})\s*$/;
/** 일기 comment 파싱 — `⭐ Core Diary[ (sealed)] · <시작> ~ <종료>`. 못 읽으면 null(일기가 아님) */
function parseDiaryComment(comment) {
    const m = String(comment ?? '').match(CORE_DIARY_COMMENT_RE);
    if (!m) return null;
    return { start: m[1], end: m[2], sealed: /\(sealed\)/.test(comment) };
}
function isDiarySealed(entry) {
    return !!parseDiaryComment(entry?.comment)?.sealed;
}
function buildDiaryComment(start, end, sealed) {
    return `${CORE_DIARY_COMMENT_PREFIX}${sealed ? ' (sealed)' : ''} · ${start} ~ ${end}`;
}
/** 일기 항목 본문 헤더 — 모델은 날짜를 찍지만 코드가 항상 다시 찍는다(모델은 새 사건 날짜만 알지 범위는 모른다) */
const DIARY_HEADER_RE = /^#{1,4}\s*\**\s*CORE\s+DIARY\b/i;
function buildDiaryContent(start, end, body) {
    return `### CORE DIARY (${start} ~ ${end})\n${body}`;
}
/** 저장된 일기 본문에서 코드가 찍은 헤더 줄을 떼고 라벨줄만 돌려준다 — 다음 프롬프트의 [Previous current diary] 입력용 */
function stripDiaryHeader(content) {
    const lines = String(content ?? '').split('\n');
    if (lines.length && DIARY_HEADER_RE.test(lines[0])) {
        return lines.slice(1).join('\n').trim();
    }
    return String(content ?? '').trim();
}
/**
 * 로어북의 코어 일기 전부 — 오래된→최신 정렬. constant===true인 것만(강등된 건 안 잡힘).
 * v0.17.0: `!e.disable`을 뗐다 — 꺼진 일기를 못 찾으면 다음 변환이 새 일기를 또 열어 코어가 중복된다.
 * 꺼진 일기도 갱신·슬라이딩(봉인/강등) 대상에 들어가되, `disable` 자체는 건드리지 않는다.
 */
function findCoreDiaryEntries(worldData) {
    return Object.values(worldData?.entries ?? {})
        .filter(e => e.constant && parseDiaryComment(e.comment))
        .sort((a, b) => parseDiaryComment(a.comment).start.localeCompare(parseDiaryComment(b.comment).start));
}
/** 레거시 통짜 코어(마이그레이션 입력용) — archived 표시된 것은 comment가 달라져 자동으로 제외된다 */
function findLegacyCoreEntry(worldData) {
    return Object.values(worldData?.entries ?? {}).find(e => e.comment === LEGACY_CORE_COMMENT) ?? null;
}
/** 코어 계열(규칙/일기/강등된 일기/레거시) comment 판별 — 사건 날짜 스캔(countExistingForDate·latestDateInWorld)이 오염되지 않게 */
function isCoreFamilyComment(comment) {
    const c = String(comment ?? '');
    return c === CORE_RULES_COMMENT
        || c.startsWith(CORE_DIARY_COMMENT_PREFIX)
        || c.startsWith(DIARY_ARCHIVE_COMMENT_PREFIX)
        || c === LEGACY_CORE_COMMENT
        || c.startsWith(`${LEGACY_CORE_COMMENT}${LEGACY_CORE_ARCHIVED_SUFFIX}`);
}
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidIsoDate(d) { return ISO_DATE_RE.test(String(d ?? '')); }

/**
 * 일기 날짜 범위 산출 (v0.13.1 버그 수정) — 사건 배열의 나열 순서가 항상 시간순은 아니라서
 * '첫 사건=시작 / 마지막 사건=종료'로 집으면 역전될 수 있었다(실측: 시작 2026-09-14 > 종료 2026-05-12).
 * 기존 일기 범위(있으면)와 이번 사건들의 날짜를 전부 모아 min~max로 계산한다 — 범위가 줄어들 일은 없다.
 * 파싱 실패(YYYY-MM-DD 형식이 아닌) 날짜는 후보에서 제외하고, 후보가 하나도 없으면 앵커로 대체한다.
 */
function computeDiaryRange(existingRange, incidentDates, anchor) {
    const candidates = [
        ...(existingRange ? [existingRange.start, existingRange.end] : []),
        ...incidentDates,
    ].filter(isValidIsoDate);
    if (!candidates.length) {
        const fallback = isValidIsoDate(anchor) ? anchor : '';
        return { start: fallback, end: fallback };
    }
    candidates.sort(); // YYYY-MM-DD 문자열 정렬 = 시간순
    return { start: candidates[0], end: candidates[candidates.length - 1] };
}

/** 코어 일기 order 재계산 — 규칙 바로 아래, 오래된 것일수록 규칙에 가깝게(값이 크게) 배치한다. 매 변환마다 전체 재배치 */
function recomputeDiaryOrders(worldData) {
    findCoreDiaryEntries(worldData).forEach((entry, idx) => {
        entry.order = CORE_DIARY_ORDER_BASE - idx;
    });
}

/** 모델 출력에서 지정 헤더 다음의 본문만 뽑는다 (RULES_PROMPT/DIARY_PROMPT 공용 파서) */
function parseSingleSectionOutput(text, headerRe) {
    const lines = String(text ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (headerRe.test(lines[i])) {
            return lines.slice(i + 1).join('\n').trim();
        }
    }
    return '';
}
const RULES_HEADER_RE = /^#{1,4}\s*\**\s*CORE\s+RULES\b/i;

/**
 * 코어 규칙/일기 갱신 공용 — 프롬프트만 다르고 재시도(최대 2회)·잘림 검증·섹션 파싱은 같다 (v0.13.0).
 * 코어는 라벨·불릿 포맷이라 문장으로 안 끝나는 게 정상 → 끝줄 검사(checkTail)는 끈다.
 * @returns {Promise<{ok:boolean, body:string, warnings:string[], failReason:string}>}
 */
async function updateCoreSection(ctx, { systemPrompt, previousLabel, previousBody, digest, maxTokens, headerRe, retryLabel }) {
    const warnings = [];
    const userPrompt = `[${previousLabel}]\n${previousBody || '(none)'}\n\n[New incidents]\n${digest}`;
    let body = '';
    let ok = false;
    let failReason = '';
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        const label = attempt === 1 ? retryLabel : `${retryLabel}(재시도)`;
        try {
            const { text: raw } = await generateConversion(ctx, systemPrompt, userPrompt);
            const sectionWarnings = await detectTruncation(raw, maxTokens, label, { checkTail: false });
            const parsed = parseSingleSectionOutput(raw, headerRe);
            if (parsed) {
                body = parsed;
                ok = true;
                warnings.push(...sectionWarnings); // 채택한 응답의 경고만 남긴다 — 버린 시도의 경고는 소음이다
            } else {
                failReason = `${label}: 응답에 섹션 헤더가 없거나 본문이 비었어요`;
                console.warn(`${LOG} ${failReason}`);
            }
        } catch (error) {
            failReason = `${label}: ${error?.message ?? error}`;
            console.warn(`${LOG} ${failReason}`);
        }
    }
    return { ok, body, warnings, failReason };
}

// ── 이월 검산 (v0.13.0 핵심) ────────────────────────────────────────
// 가상 실행에서 실측된 실패: 이전 일기 Ongoing 한 줄("바론 생일 3월+반지 선물 계획")이 경고 없이 증발했다.
// 프롬프트 지시로는 못 막는다 — 코드가 이전 줄 하나하나를 새 출력과 대조해서 사라진 걸 잡아낸다.
/** Ongoing 줄 정규화 — 대소문자·구두점·머리 불릿을 지워 겹침 비교를 안정화한다 */
function normalizeOngoingLine(line) {
    return String(line ?? '')
        .replace(/^[-*]\s*/, '')
        .toLowerCase()
        .replace(/[^a-z0-9가-힣\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/** 일기 본문(헤더 제외)에서 Ongoing: 섹션의 줄만 뽑는다 */
function extractOngoingLines(diaryBody) {
    const lines = String(diaryBody ?? '').split('\n');
    const out = [];
    let inOngoing = false;
    for (const line of lines) {
        if (/^\s*Ongoing\s*:/i.test(line)) {
            inOngoing = true;
            const rest = line.replace(/^\s*Ongoing\s*:\s*/i, '').trim();
            if (rest) out.push(rest.replace(/^[-*]\s*/, ''));
            continue;
        }
        if (inOngoing) {
            if (/^\s*(Relationship|Dynamics|Ongoing)\s*:/i.test(line)) { inOngoing = false; continue; }
            const trimmed = line.trim();
            if (trimmed) out.push(trimmed.replace(/^[-*]\s*/, ''));
        }
    }
    return out.filter(Boolean);
}
/** 이전 Ongoing 한 줄이 새 일기에 (부분일치·토큰겹침 60% 이상으로) 살아남았는지 */
function ongoingLineSurvives(prevLine, newBody) {
    const prevNorm = normalizeOngoingLine(prevLine);
    if (!prevNorm) return true;
    for (const newLine of extractOngoingLines(newBody)) {
        const newNorm = normalizeOngoingLine(newLine);
        if (!newNorm) continue;
        if (newNorm.includes(prevNorm) || prevNorm.includes(newNorm)) return true;
        const prevTokens = new Set(prevNorm.split(' ').filter(w => w.length >= 3));
        if (!prevTokens.size) continue;
        const newTokens = new Set(newNorm.split(' ').filter(w => w.length >= 3));
        let overlap = 0;
        for (const t of prevTokens) if (newTokens.has(t)) overlap++;
        if (overlap / prevTokens.size >= 0.6) return true;
    }
    return false;
}
/** 이전 일기 Ongoing 각 줄이 새 일기에서 사라졌는지 대조 — 사라진 줄만 돌려준다. 자동 복구는 하지 않는다(호출부가 경고만 만든다) */
function checkOngoingCarryover(prevBody, newBody) {
    return extractOngoingLines(prevBody).filter(line => !ongoingLineSurvives(line, newBody));
}
/** 강등 시 미해결 Ongoing을 현재 일기에 기계적으로 합친다(모델에 맡기지 않는다) — 정규화 중복은 걸러낸다 */
function appendOngoingLines(diaryBody, newLines) {
    if (!newLines.length) return diaryBody;
    const lines = String(diaryBody ?? '').split('\n');
    const ongoingIdx = lines.findIndex(l => /^\s*Ongoing\s*:/i.test(l));
    const additions = newLines.map(l => `- ${String(l).replace(/^[-*]\s*/, '').trim()}`);
    if (ongoingIdx === -1) {
        return `${diaryBody}\nOngoing:\n${additions.join('\n')}`.trim();
    }
    let insertAt = lines.length;
    for (let i = ongoingIdx + 1; i < lines.length; i++) {
        if (/^\s*(Relationship|Dynamics|Ongoing)\s*:/i.test(lines[i])) { insertAt = i; break; }
    }
    lines.splice(insertAt, 0, ...additions);
    return lines.join('\n').trim();
}

/**
 * 해당 작중 날짜로 이미 저장된 항목 수 (v0.7.0 에피소드 번호용).
 * 코어 항목은 날짜 개념이 없으므로 제외. ⚠ 새 항목을 worldData에 넣기 **전**에 세야 한다.
 */
function countExistingForDate(worldData, date) {
    if (!date) return 0;
    let n = 0;
    for (const e of Object.values(worldData?.entries ?? {})) {
        if (e.constant || isCoreFamilyComment(e.comment)) continue; // 코어 계열(규칙/일기/레거시)은 사건이 아니다
        if (String(e.comment ?? '').includes(date)) n++;
    }
    return n;
}

/** 로어북 comment에 박힌 날짜 중 가장 늦은 것 — 앛커 폴백 2단계 */
function latestDateInWorld(worldData) {
    let latest = '';
    for (const e of Object.values(worldData?.entries ?? {})) {
        if (e.constant || isCoreFamilyComment(e.comment)) continue;
        for (const d of String(e.comment ?? '').match(/\d{4}-\d{2}-\d{2}/g) ?? []) {
            if (d > latest) latest = d; // YYYY-MM-DD는 사전순 = 시간순
        }
    }
    return latest;
}

/**
 * 작중 날짜 앛커 확보 (v0.7.0).
 * ① 이 채팅에 저장된 앛커 → ② 대상 로어북의 가장 늦은 날짜 → ③ 변환 대상 첫 메시지의 실제 날짜.
 * ③가 유일하게 실제 날짜를 쓰는 지점이다 — 첫 변환엔 기준점이 아무데에도 없으니까.
 */
function resolveStoryAnchor(ctx, worldData, fresh) {
    const saved = String(ctx?.chatMetadata?.[STORY_ANCHOR_META_KEY] ?? '').trim();
    if (saved) return saved;
    const fromWorld = latestDateInWorld(worldData);
    if (fromWorld) return fromWorld;
    return fresh.find(m => m.day)?.day ?? '';
}

/**
 * 변환용 생성 1회 — 프로필 지정 시 ConnectionManagerRequestService(shared.js:388), 아니면 현재 연결(generateRaw).
 * 프로필 실패 시 폴백하지 않는다 — 유저가 고른 프로필을 조용히 비싼 현재 연결로 바꾸는 건 배신이다.
 */
async function generateConversion(ctx, systemPrompt, userPrompt) {
    const settings = getSettings();
    if (!settings.convertProfileId) {
        // v0.10.0: 현재 연결 경로에도 같은 상한을 먹인다 (v0.7.0의 '안 넘긴다' 결정을 발주자 승인으로 뒤집음).
        // generateRaw는 responseLength를 받아 TempResponseLength로 임시 교체 후 복원한다 (script.js:3947, 4063).
        // 상한을 모르면 잘림 감지 (a)가 아예 못 돌아 끝줄 휴리스틱 하나에 매달리게 되고, 그게 오탐의 뿌리였다.
        const text = await ctx.generateRaw({ prompt: userPrompt, systemPrompt, responseLength: getConvertMaxTokens() });
        return { text: String(text ?? ''), viaProfile: false };
    }
    let profileName = settings.convertProfileId;
    try {
        profileName = ConnectionManagerRequestService.getProfile(settings.convertProfileId)?.name ?? profileName;
    } catch { /* 이름 조회 실패는 치명 아님 — id로 표기 */ }
    // 메시지 배열은 텍스트 컴플리션 프로필에서도 동작한다 (custom-request.js:293 Array.isArray 분기 → instruct 조립)
    const result = await ConnectionManagerRequestService.sendRequest(
        settings.convertProfileId,
        [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        getConvertMaxTokens(),
    );
    const text = typeof result === 'string' ? result : String(result?.content ?? '');
    if (!text.trim()) {
        throw new Error(`변환 프로필(${profileName})의 응답이 비어 있어요`);
    }
    return { text, viaProfile: true };
}

/**
 * 잘림 감지 2종을 돌려 경고 배열에 모은다 (v0.7.0).
 * (a) 프로필 경로: 응답 토큰이 상한의 TRUNCATION_RATIO 이상 → 상한에 박은 것으로 본다.
 * (b) 공통: 끝줄이 문장으로 안 닫혔 있다.
 * 경고만 하고 결과는 버리지 않는다 — API 호출 N번을 날리는 게 더 비싸다.
 */
async function detectTruncation(text, maxTokens, label, { checkTail = true } = {}) {
    const found = [];
    // (a) v0.10.0부터 현재 연결 경로도 같은 상한(responseLength)을 쓰므로 양쪽에서 돈다.
    try {
        const used = await getTokenCountAsync(String(text ?? ''));
        if (used >= Math.floor(maxTokens * TRUNCATION_RATIO)) {
            found.push(`${label}: 응답이 ${used.toLocaleString()}토큰으로 상한(${maxTokens.toLocaleString()})에 닿았어요 — 설정의 '변환 응답 최대 토큰'을 늘려 보세요`);
        }
    } catch (error) {
        console.warn(`${LOG} ${label} 응답 토큰 계산 실패 (잘림 감지 (a) 건너뜀): ${error?.message ?? error}`);
    }
    if (checkTail && looksTruncated(text)) {
        found.push(`${label}: 응답이 문장 중간에서 끊긴 것 같아요 — 설정의 '변환 응답 최대 토큰'을 늘려 보세요`);
    }
    return found;
}

/**
 * 로어북을 에디터에서 강제로 연다 — 쌍둥이·백업본 혼동 방지용.
 * reloadEditor(world, true) = loadIfNotSelected (world-info.js:1040) + WI 서랍이 닫혀 있으면 연다
 * (서랍 토글: #WIDrawerIcon 클릭 → #WorldInfo.closedDrawer 해제, index.html:4658~4662 구조)
 */
function openWorldEditor(world) {
    if (!world) return;
    reloadEditor(world, true);
    if ($('#WorldInfo').hasClass('closedDrawer')) {
        $('#WIDrawerIcon').trigger('click');
    }
}

/**
 * 변환 프로필 배지 — 아이콘 + 표시명 + 경고 여부.
 * v0.5에서 드롭다운을 붙였는데 panel.html은 "메인 API를 사용해요"로 고정돼 있었다(v0.6.4 수정).
 * 주의: getProfile()은 못 찾으면 예외가 아니라 undefined를 돌려준다 — catch가 아니라 falsy로 가른다.
 */
function getConvertProfileBadge() {
    const settings = getSettings();
    if (!settings.convertProfileId) {
        // 이 경로는 generateRaw라 응답 상한을 우리가 못 정한다(호출부를 건드리지 않기로 한 결정, v0.7.0).
        // 그래서 조용히 잘리는 대신 배지에서 먼저 경고한다.
        return {
            icon: 'fa-plug',
            text: '현재 연결된 메인 API',
            note: 'ST 응답 최대 토큰 설정을 따라요 — 낮으면 잘려요',
            warn: true,
        };
    }
    try {
        const profile = ConnectionManagerRequestService.getProfile(settings.convertProfileId);
        const name = profile?.name || profile?.id;
        if (name) return { icon: 'fa-plug-circle-check', text: String(name), warn: false };
    } catch {
        // connection-manager 비활성 — 아래 경고로 떨어진다
    }
    return { icon: 'fa-plug-circle-xmark', text: `${settings.convertProfileId} (프로필을 찾지 못했어요)`, warn: true };
}

/** 변환 프로필 배지를 패널에 그린다 (변환 버튼 바로 위) */
function renderConvertProfileBadge($panel) {
    const badge = getConvertProfileBadge();
    const $badge = $panel.find('#jev_panel_convert_profile').empty()
        .toggleClass('jev-badge-warn', badge.warn)
        .append($(`<i class="fa-solid ${badge.icon}">`))
        .append($('<span>').text(badge.text));
    if (badge.note) {
        $badge.append($('<span class="jev-badge-note">').text(badge.note));
    }
}

/**
 * 직전 변환 경고 렌더 (v0.7.0) — 토스트는 사라지지만 잘린 요약은 로어북에 남는다.
 * 경고가 없으면 영역 자체를 숨긴다 — 빈 박스가 상시 떠 있으면 경고가 경고로 안 보인다.
 */
function renderPanelWarnings($panel) {
    const $section = $panel.find('#jev_panel_warnings');
    const $list = $panel.find('#jev_panel_warnings_list').empty();
    if (!lastConvertWarnings.length) {
        $section.hide();
        return;
    }
    for (const w of lastConvertWarnings) {
        $list.append($('<div class="jev-warn-line">').text(`⚠ ${w}`));
    }
    $section.show();
}

/** 변환 프로필 표시명 — 패널·상태줄용 */
function getConvertProfileLabel() {
    const settings = getSettings();
    if (!settings.convertProfileId) return '현재 연결된 메인 API';
    try {
        return ConnectionManagerRequestService.getProfile(settings.convertProfileId)?.name ?? settings.convertProfileId;
    } catch {
        return `${settings.convertProfileId} (프로필을 찾지 못했어요)`;
    }
}

/**
 * 챗 → 로어북 변환 본체.
 * - 범위: chat_metadata[CONVERT_META_KEY] ~ (끝 - keepRecent). 최근 N개는 원문 맥락으로 보존 (첫 실행은 그 앞 전체)
 * - 생성: 메인 API generateRaw (Generate 파이프라인 밖 — 인터셉터·WI스캔 안 탐, script.js:4063 검증)
 * - 저장: createWorldInfoEntry(uid 자동 할당) → saveWorldInfo → 변환 지점 saveMetadata → 자동 색인 → 성공 후에만 원본 구간 숨김
 * - 실패 시: 항목·변환 지점 미저장·숨김 없음 (전량 성공 후에만 쓴다) → 재실행하면 같은 범위 재시도
 *
 * v0.7.0 개편:
 * - 코어 갱신을 슬라이스 루프에서 떼어내 맨 끝 1회로 몰았다. 중간 슬라이스의 코어는 어차피 다음 슬라이스가
 *   덮어써서 버려졌는데, 그동안 사건 출력 예산만 갉아먹고 있었다. 코어 입력은 전사 원문이 아니라 사건 요약본이다.
 * - 잘림 의심은 warnings[]에 모으고, 하나라도 있으면 초록불(success)을 띄우지 않는다.
 *   단 이미 뽑은 사건은 버리지 않는다 — API 호출 N번을 날리는 게 더 나쁘다.
 */
async function convertChatToLorebook(setStatus) {
    if (conversionInProgress) {
        toastr.warning('변환이 이미 진행 중이에요.', 'Jev Lorebook');
        return;
    }
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    const world = getConversionTargetWorld();
    if (!world) {
        toastr.error('대상 로어북이 없어요. 이 채팅 또는 캐릭터 카드에 로어북을 먼저 연결해 주세요. (자동으로 만들지는 않아요)', 'Jev Lorebook');
        return;
    }
    const chat = ctx.chat ?? [];
    if (!chat.length) {
        toastr.warning('채팅이 비어 있어요.', 'Jev Lorebook');
        return;
    }
    const keepRecent = Number.isFinite(Number(settings.keepRecent)) ? Math.max(0, Number(settings.keepRecent)) : defaultSettings.keepRecent;
    const startIndex = Math.max(0, Number(ctx.chatMetadata?.[CONVERT_META_KEY]) || 0);
    // 되돌리기 스냅샷용 — 덮어쓰기 전 값을 원본 그대로 잡아둔다 (없었으면 undefined)
    const prevMarker = ctx.chatMetadata?.[CONVERT_META_KEY];
    const prevAnchor = ctx.chatMetadata?.[STORY_ANCHOR_META_KEY];
    const endIndex = chat.length - keepRecent; // 보존 버퍼 경계 — 변환·숨김 모두 여기까지만
    const fresh = endIndex > startIndex ? collectFreshMessages(chat, startIndex, endIndex) : [];
    if (!fresh.length) {
        toastr.info(`변환할 새 메시지가 없어요 (변환 지점 ${startIndex}, 최근 ${keepRecent}개 보존, 전체 ${chat.length}).`, 'Jev Lorebook');
        return;
    }

    conversionInProgress = true;
    const t0 = performance.now();
    const warnings = [];   // 잘림 의심·형식 불일치·코어 실패 — 완료 토스트 색을 여기서 정한다
    let coreFailed = false;
    lastConvertWarnings = []; // 이번 실행 것으로 갈아끼운다 (지난번 경고가 남아 겁주면 안 된다)
    try {
        // 0. 로어북 선로드 — 이전 코어 상태와 작중 날짜 앵커를 여기서 확보한다
        const worldData = await loadWorldInfo(world);
        if (!worldData?.entries) {
            throw new Error(`로어북 '${world}' 로드 실패`);
        }
        // v0.13.0 — 코어 2층화: 이전 상태를 규칙/일기 두 갈래로 읽는다.
        // 레거시 마이그레이션: 신형 항목이 하나도 없고 구형 '⭐ Core Memory'만 있으면 그 내용을 양쪽 입력으로 공급한다.
        const rulesEntryBefore = findCoreRulesEntry(worldData);
        const diaryEntriesBefore = findCoreDiaryEntries(worldData); // 오래된→최신
        const openDiaryBefore = diaryEntriesBefore.find(e => !isDiarySealed(e)) ?? null;
        const legacyEntry = (!rulesEntryBefore && !diaryEntriesBefore.length) ? findLegacyCoreEntry(worldData) : null;
        let prevRulesBody = String(rulesEntryBefore?.content ?? '').trim();
        let prevDiaryBody = openDiaryBefore ? stripDiaryHeader(openDiaryBefore.content) : '';
        if (legacyEntry) {
            const legacyBody = String(legacyEntry.content ?? '').trim();
            prevRulesBody = legacyBody;
            prevDiaryBody = legacyBody;
            console.log(`${LOG} 레거시 '${LEGACY_CORE_COMMENT}' 감지 — 규칙/일기 양쪽 입력으로 공급해 마이그레이션한다`);
        }
        // 되돌리기 스냅샷용 — 이번 실행이 건드리기 전의 규칙/일기 전량을 그대로 잡아둔다 (덮어쓰거나 강등해도 전부 복원 가능하게)
        // v0.17.0 — 스냅샷에 disable을 추가했다. 3버튼(🔵🟢⚫) 도입 후 이 필드가 빠지면
        // 되돌리기가 사용자가 만든 '꺼짐' 상태를 말없이 뭉갠다(복원 대상 항목이 전부 켜진 채로 살아난다).
        const prevCoreRulesSnap = rulesEntryBefore
            ? { uid: rulesEntryBefore.uid, existed: true, content: String(rulesEntryBefore.content ?? ''), disable: rulesEntryBefore.disable === true }
            : { uid: null, existed: false, content: '', disable: false };
        const prevCoreDiariesSnap = diaryEntriesBefore.map(e => ({
            uid: e.uid, comment: e.comment, content: String(e.content ?? ''), constant: e.constant, order: e.order, disable: e.disable === true,
        }));
        const anchor = resolveStoryAnchor(ctx, worldData, fresh);

        setStatus('슬라이스 계산 중…');
        const sliceTokens = getSliceTokens();
        const maxTokens = getConvertMaxTokens();
        const slices = await buildSlices(fresh, sliceTokens);
        const incidentsPrompt = buildIncidentsPrompt(getConvertStyle(), getIncidentMaxTokens(), anchor);
        console.log(`${LOG} 변환 시작 — 대상='${world}' 메시지 ${fresh.length}건(인덱스 ${startIndex}~${endIndex}, 최근 ${keepRecent}개 보존) → 슬라이스 ${slices.length}개(${sliceTokens}토큰 단위) / 작중 앵커 '${anchor || '없음'}' / 이전 규칙 ${prevRulesBody ? '있음' : '없음'} / 이전 일기 ${prevDiaryBody ? '있음' : '없음'}`);

        // 1. 슬라이스별 사건 추출 — 이 호출들은 코어를 전혀 다루지 않는다 (출력 예산 전액을 사건에 쓴다)
        const incidents = [];
        for (let i = 0; i < slices.length; i++) {
            const label = `슬라이스 ${i + 1}/${slices.length}`;
            setStatus(`요약 생성 중… ${i + 1}/${slices.length} (${getConvertProfileLabel()})`);
            const transcript = sliceToTranscript(slices[i]);
            const prompt = `[Anchor: ${anchor || 'unknown'}]\n\n[Transcript]\n${transcript}`;
            // A(v0.11.0): 잘림이 잡힐 그 슬라이스만 1회 재생성한다.
            // 코어는 v0.7.0부터 2회 시도였는데 사건 쪽은 0회였다 — 잘린 요약이 그대로 박히는 유일한 경로였다.
            let raw = '';
            let sliceWarnings = [];
            for (let attempt = 1; attempt <= 2; attempt++) {
                const attemptLabel = attempt === 1 ? label : `${label}(재시도)`;
                if (attempt > 1) setStatus(`잘림 감지 — 재생성 중… ${i + 1}/${slices.length} (${getConvertProfileLabel()})`);
                const generated = await generateConversion(ctx, incidentsPrompt, prompt);
                raw = generated.text;
                sliceWarnings = await detectTruncation(raw, maxTokens, attemptLabel);
                if (!sliceWarnings.length) break;
                console.warn(`${LOG} ${attemptLabel} — 잘림 의심: ${sliceWarnings.join(' / ')}`);
            }
            warnings.push(...sliceWarnings);
            const parsed = parseConversionOutput(raw);
            if (!parsed.incidents.length) {
                warnings.push(`${label}: 출력 ${String(raw ?? '').length}자에서 사건 헤더를 하나도 못 찾았어요 (형식 불일치)`);
                console.warn(`${LOG} ${label} — 사건 헤더 0건 (형식 불일치)`);
            } else {
                console.log(`${LOG} ${label} — 사건 ${parsed.incidents.length}건 파싱`);
            }
            incidents.push(...parsed.incidents);
        }
        if (!incidents.length) {
            throw new Error('출력에서 사건 헤더(### YYYY-MM-DD — 제목)를 하나도 찾지 못했어요 — 항목과 변환 지점은 저장하지 않았어요');
        }
        // 코어 일기 종료일 + 다음 변환 앵커로 쓴다 (v0.13.0: 2b가 필요로 해서 여기로 끌어올림, 기존엔 3단계에서 계산했다)
        const lastDate = incidents[incidents.length - 1]?.date;

        // 1b. 코어 규칙·일기 갱신 — 각 1회 호출(형식 불일치 시 1회 재시도), 입력은 전사 원문이 아니라
        //     이번에 뽑은 사건 요약본 전체(v0.7.0 결정 유지). 실패한 쪽만 손대지 않고 진행한다(사건은 살린다).
        const digest = incidents.map(inc => `### ${inc.date} — ${inc.title}\n${inc.body}`).join('\n\n');

        setStatus(`코어 규칙 갱신 중… (${getConvertProfileLabel()})`);
        const rulesResult = await updateCoreSection(ctx, {
            systemPrompt: RULES_PROMPT,
            previousLabel: 'Previous rules',
            previousBody: prevRulesBody,
            digest,
            maxTokens,
            headerRe: RULES_HEADER_RE,
            retryLabel: '코어 규칙 갱신',
        });
        if (!rulesResult.ok) {
            warnings.push(`코어 규칙을 갱신하지 못했어요 (사건은 그대로 저장했어요) — ${rulesResult.failReason || '사유 미상'}`);
        } else {
            warnings.push(...rulesResult.warnings);
        }

        setStatus(`코어 일기 갱신 중… (${getConvertProfileLabel()})`);
        const diaryResult = await updateCoreSection(ctx, {
            systemPrompt: DIARY_PROMPT,
            previousLabel: 'Previous current diary',
            previousBody: prevDiaryBody,
            digest,
            maxTokens,
            headerRe: DIARY_HEADER_RE,
            retryLabel: '코어 일기 갱신',
        });
        if (!diaryResult.ok) {
            warnings.push(`코어 일기를 갱신하지 못했어요 (사건은 그대로 저장했어요) — ${diaryResult.failReason || '사유 미상'}`);
        } else {
            warnings.push(...diaryResult.warnings);
            // 이월 검산 (v0.13.0 핵심, 프롬프트로 못 막는다는 게 실측됨) — 사라진 줄은 경고만, 자동 복구는 안 한다.
            if (prevDiaryBody) {
                for (const line of checkOngoingCarryover(prevDiaryBody, diaryResult.body)) {
                    warnings.push(`이월 검산: 이전 일기의 Ongoing 항목이 새 일기에서 안 보여요 — "${line.slice(0, 80)}" (정당한 해소일 수도 있어요, 자동 복구는 하지 않았어요)`);
                }
            }
        }
        const coreUpdated = rulesResult.ok || diaryResult.ok; // 아래 완료 요약 문구용 — 최소 하나는 갱신됐나
        if (!rulesResult.ok && !diaryResult.ok) {
            coreFailed = true;
        }

        // 2. 로어북 항목 추가 — createWorldInfoEntry가 uid를 충돌 없이 할당 (world-info.js:4057)
        setStatus(`로어북 항목 생성 중… ${incidents.length}건`);
        // 에피소드 번호는 코드가 붙인다 — 모델은 분할만 한다.
        // 기존 개수는 반드시 새 항목을 넣기 '전'에 세어둔다 (넣으면서 세면 자기 자신을 세게 된다).
        const existingByDate = new Map();
        for (const inc of incidents) {
            if (!existingByDate.has(inc.date)) {
                existingByDate.set(inc.date, countExistingForDate(worldData, inc.date));
            }
        }
        const batchByDate = new Map();
        const addedUids = []; // 되돌리기용 — 이번 변환이 만든 항목만 정확히 지우기 위해 모은다
        for (const inc of incidents) {
            const entry = createWorldInfoEntry(world, worldData);
            if (!entry) {
                throw new Error('로어북 항목 uid 할당 실패');
            }
            addedUids.push(entry.uid);
            const seen = batchByDate.get(inc.date) ?? 0;
            batchByDate.set(inc.date, seen + 1);
            const n = (existingByDate.get(inc.date) ?? 0) + seen + 1;
            // 키워드 발동은 쓰지 않는다 — 발동 경로는 Jev(FORCE_ACTIVATE) 단일.
            // 키를 달면 ST 재귀 스캔이 본문의 이름·날짜를 물고 연쇄 발동하는데,
            // world_info_max_recursion_steps=0이면 제동이 아예 안 걸려 예산 상한까지 퍼붓는다. (2026-09-20)
            entry.key = [];
            // 1번째엔 번호를 안 붙인다 — 하루에 사건이 하나뿐인 날이 대부분이라 '#1'은 소음이다
            entry.comment = `${inc.title} · ${inc.date}${n > 1 ? ` #${n}` : ''}`;
            // 본문 머리에 날짜 헤더 (v0.12.0) — comment는 프롬프트에 안 들어간다
            entry.content = buildIncidentContent(inc.date, inc.title, inc.body);
            entry.constant = false;
            entry.disable = false;
        }

        // 2b. 코어 규칙/일기 upsert — constant:true = ST가 매턴 네이티브 주입 (Jev 판정·색인 밖, 설계 의도).
        //     각자 갱신에 실패했으면 그 항목은 건드리지 않는다 (덮어쓸 새 값이 없다).
        let rulesUpdatedNote = '미갱신';
        if (rulesResult.ok) {
            const rulesTokens = await getTokenCountAsync(rulesResult.body);
            if (rulesTokens > CORE_RULES_TOKEN_LIMIT) {
                console.warn(`${LOG} 코어 규칙 ${rulesTokens}토큰 — 상한 ${CORE_RULES_TOKEN_LIMIT} 초과 (자르지 않고 그대로 저장)`);
            }
            let rulesEntry = findCoreRulesEntry(worldData);
            const rulesIsNew = !rulesEntry;
            if (rulesIsNew) {
                rulesEntry = createWorldInfoEntry(world, worldData);
                if (!rulesEntry) throw new Error('코어 규칙 항목 uid 할당 실패');
                rulesEntry.comment = CORE_RULES_COMMENT;
                // v0.17.0 — disable 초기화는 '신규 생성'에서만 한다. 기존 항목이 꺼져 있으면 그건 사용자가 끈 것이다.
                rulesEntry.disable = false;
                addedUids.push(rulesEntry.uid); // 되돌리기 — 이번 실행이 새로 만든 것이면 통째로 지운다
            }
            rulesEntry.key = [];
            rulesEntry.order = CORE_RULES_ORDER;
            rulesEntry.content = rulesResult.body;
            rulesEntry.constant = true;
            rulesUpdatedNote = `갱신(${rulesTokens}토큰)${rulesEntry.disable ? ' · 꺼진 채 유지' : ''}`;
            console.log(`${LOG} 코어 규칙 upsert — ${rulesTokens}토큰 (constant, 매턴 네이티브 주입)`);
        } else {
            console.warn(`${LOG} 코어 규칙 미갱신 — 기존 항목을 그대로 둔다`);
        }

        let diaryUpdatedNote = '미갱신';
        if (diaryResult.ok) {
            // v0.13.1 — min~max로 계산(위 computeDiaryRange 주석의 실측 버그 참조). lastDate 단독 사용 금지.
            const existingRange = openDiaryBefore ? parseDiaryComment(openDiaryBefore.comment) : null;
            const { start: diaryStart, end: diaryEnd } = computeDiaryRange(existingRange, incidents.map(inc => inc.date), anchor);
            const diaryContent = buildDiaryContent(diaryStart, diaryEnd, diaryResult.body);
            const diaryTokens = await getTokenCountAsync(diaryContent);
            const sealNow = diaryTokens > CORE_DIARY_TOKEN_LIMIT;

            let diaryEntry = openDiaryBefore ? worldData.entries?.[String(openDiaryBefore.uid)] : null;
            if (!diaryEntry) {
                diaryEntry = createWorldInfoEntry(world, worldData);
                if (!diaryEntry) throw new Error('코어 일기 항목 uid 할당 실패');
                // v0.17.0 — disable 초기화는 '신규로 일기를 여는' 경로에서만. 기존 일기의 꺼짐은 사용자 의도다.
                diaryEntry.disable = false;
                addedUids.push(diaryEntry.uid); // 되돌리기 — 이번 실행이 새로 연 일기면 통째로 지운다
            }
            diaryEntry.key = [];
            diaryEntry.comment = buildDiaryComment(diaryStart, diaryEnd, sealNow);
            diaryEntry.content = diaryContent;
            diaryEntry.constant = true;
            diaryUpdatedNote = `갱신(${diaryTokens}토큰${sealNow ? ' · 봉인' : ''})${diaryEntry.disable ? ' · 꺼진 채 유지' : ''}`;
            console.log(`${LOG} 코어 일기 upsert — '${diaryEntry.comment}' ${diaryTokens}토큰${sealNow ? ' (600토큰 초과 — 봉인, 다음 변환부터 새 일기)' : ''}`);

            // 개수 상한(3개) 초과분 강등 — 봉인으로 새로 닫혔든, 이미 꽉 찬 상태에서 새로 열었든 매번 확인한다.
            // while: 정상 경로는 실행당 최대 +1이라 한 번이면 끝나지만, 방어적으로 반복한다.
            while (true) {
                const nowDiaries = findCoreDiaryEntries(worldData); // 오래된→최신, constant=true인 것만
                if (nowDiaries.length <= CORE_DIARY_MAX_COUNT) break;
                const oldest = nowDiaries[0];
                const oldestMeta = parseDiaryComment(oldest.comment);
                const target = nowDiaries[nowDiaries.length - 1]; // 강등 시점의 최신 일기 = Ongoing 인수자
                if (target && target.uid !== oldest.uid) {
                    const oldestOngoing = extractOngoingLines(stripDiaryHeader(oldest.content));
                    const targetBodyBefore = stripDiaryHeader(target.content);
                    const targetNorm = extractOngoingLines(targetBodyBefore).map(normalizeOngoingLine);
                    const toAppend = oldestOngoing.filter(line => {
                        const norm = normalizeOngoingLine(line);
                        return norm && !targetNorm.some(t => t === norm || t.includes(norm) || norm.includes(t));
                    });
                    if (toAppend.length) {
                        const targetMeta = parseDiaryComment(target.comment);
                        const mergedBody = appendOngoingLines(targetBodyBefore, toAppend);
                        target.content = buildDiaryContent(targetMeta.start, targetMeta.end, mergedBody);
                        console.log(`${LOG} 강등 이월 — '${oldest.comment}'의 미해결 Ongoing ${toAppend.length}줄을 '${target.comment}'에 기계적으로 append`);
                    }
                }
                oldest.constant = false;
                oldest.order = NORMAL_ORDER;
                oldest.comment = `${DIARY_ARCHIVE_COMMENT_PREFIX} · ${oldestMeta?.start ?? ''} ~ ${oldestMeta?.end ?? ''}`;
                console.log(`${LOG} 코어 일기 강등 — uid ${oldest.uid} → 검색층(order ${NORMAL_ORDER}, 다음 재색인에 포함됨)`);
            }
            recomputeDiaryOrders(worldData);
        } else {
            console.warn(`${LOG} 코어 일기 미갱신 — 기존 항목을 그대로 둔다`);
        }

        // 레거시 마이그레이션 완료 표시 — 규칙·일기 둘 다 갱신에 성공했을 때만 archived 처리한다.
        // 하나라도 실패하면 레거시 항목을 그대로 살려 둔다(constant 유지 = 계속 매턴 주입) — 다음 변환에서 재시도.
        if (legacyEntry && rulesResult.ok && diaryResult.ok) {
            legacyEntry.disable = true;
            legacyEntry.comment = `${LEGACY_CORE_COMMENT}${LEGACY_CORE_ARCHIVED_SUFFIX}`;
            console.log(`${LOG} 레거시 코어 항목(uid ${legacyEntry.uid}) → 규칙/일기 마이그레이션 완료, disable+archived 표시`);
        } else if (legacyEntry) {
            warnings.push('레거시 코어 메모리 마이그레이션이 완전히 끝나지 않았어요 — 다음 변환에서 다시 시도해요 (기존 항목은 그대로 매턴 주입돼요).');
        }

        await saveWorldInfo(world, worldData, true);
        reloadEditor(world); // 에디터에 이 로어북이 열려 있으면 실시간 갱신 (world-info.js:1040, 강제 오픈 없음)

        // 3. 변환 지점 + 작중 날짜 앵커 기록 (chat_metadata — 이 채팅에만 귀속)
        //    앵커 = 마지막 사건의 날짜(lastDate, 2b 이전에 계산해 둠). 다음 변환이 여기서부터 경과를 센다.
        ctx.chatMetadata[CONVERT_META_KEY] = endIndex;
        if (lastDate) ctx.chatMetadata[STORY_ANCHOR_META_KEY] = lastDate;
        // C(v0.11.0): 되돌리기 스냅샷. 항목 저장이 끝난 뒤에 남긴다 — 저장이 실패했으면 되돌릴 것도 없다.
        ctx.chatMetadata[UNDO_META_KEY] = {
            ts: Date.now(),
            world,
            addedUids,
            prevCoreRules: prevCoreRulesSnap,
            prevCoreDiaries: prevCoreDiariesSnap,
            prevMarker: prevMarker ?? null,
            prevAnchor: prevAnchor ?? null,
            hiddenFrom: startIndex,
            hiddenTo: endIndex - 1,
            incidentCount: incidents.length,
        };
        await ctx.saveMetadata();

        // 4. 자동 색인 (constant 제외)
        setStatus('색인 중…');
        const indexed = await indexWorld(world, setStatus);

        // 5. 변환된 원본 구간 숨김 — 항목 생성+색인 성공 후에만 (실패 시 절대 안 숨김)
        // hideChatMessageRange(chats.js:147): is_system 플래그 + DOM 갱신 + saveChatConditional. /hide 커맨드와 동일 경로
        setStatus('원본 메시지 숨김 중…');
        await hideChatMessageRange(startIndex, endIndex - 1, false);
        const hiddenCount = endIndex - startIndex;

        const ms = Math.round(performance.now() - t0);
        lastConvertWarnings = warnings.slice();
        const summary = `사건 ${incidents.length}건 추가 · 규칙 ${rulesUpdatedNote} · 일기 ${diaryUpdatedNote} · 앵커 ${lastDate || '유지'} · ${indexed}개 색인 · 메시지 ${hiddenCount}개 변환·숨김, 최근 ${keepRecent}개 유지 (${ms}ms)`;
        const toastBody = `변환을 마쳤어요: 사건 ${incidents.length}건 · 메시지 ${hiddenCount}개 숨김 · 최근 ${keepRecent}개는 원문 유지 — ${world}.`;
        const toastOptions = { onclick: () => openWorldEditor(world), timeOut: 10000 };

        // 이월 검산 경고는 화면 토스트에서 완전히 뺀다 (발주자 확정, 2026-09-20) — 검산 로직 자체는 안 건드림.
        // setStatus/콘솔/lastConvertWarnings에는 그대로 남겨 증거는 보존한다.
        const toastWarnings = warnings.filter(w => !w.startsWith('이월 검산:'));

        if (!toastWarnings.length) {
            setStatus(`완료: ${summary}`);
            toastr.success(`${toastBody} 여기를 누르면 에디터에서 바로 확인할 수 있어요.`, 'Jev Lorebook', toastOptions);
        } else {
            // 경고가 하나라도 있으면 초록불을 띄우지 않는다 — "다 잘 됐구나"로 읽히면 잘린 요약이 그대로 굳는다
            setStatus(`완료(경고 ${warnings.length}건): ${summary} — ${warnings.join(' / ')}`);
            const warnBody = `${toastBody}\n⚠ 확인할 게 ${toastWarnings.length}건 있어요: ${toastWarnings.join(' / ')}`;
            if (coreFailed) {
                toastr.error(warnBody, 'Jev Lorebook', { ...toastOptions, timeOut: 20000 });
            } else {
                toastr.warning(warnBody, 'Jev Lorebook', { ...toastOptions, timeOut: 20000 });
            }
        }
        console.log(`${LOG} 변환 완료 — 사건 ${incidents.length}건 / 변환 지점 ${startIndex}→${endIndex} / 숨김 ${hiddenCount}개 / 경고 ${warnings.length}건 (토스트 표시 ${toastWarnings.length}건) / ${ms}ms`);
    } catch (error) {
        console.error(`${LOG} 변환 실패`, error);
        warnings.push(`변환 실패: ${error?.message ?? error}`);
        lastConvertWarnings = warnings.slice();
        setStatus(`실패했어요: ${error?.message ?? error}`);
        toastr.error(`변환에 실패했어요: ${error?.message ?? error}`, 'Jev Lorebook');
    } finally {
        conversionInProgress = false;
    }
}

// ── 본문 날짜 헤더 마이그레이션 (v0.12.0) ──────────────────────────────

/**
 * 기존 항목 본문 머리에 날짜 헤더를 박는다 (로어북 1개 단위).
 * v0.11.0까지 저장된 항목은 날짜가 comment에만 있어 프롬프트·임베딩 어느 쪽에도 닿지 않았다.
 * 안전장치 3개: ① constant(코어)는 날짜 개념이 없어 제외 ② 이미 헤더가 있으면 건너뜀(재실행 안전)
 * ③ comment가 우리 형식(`제목 · YYYY-MM-DD`)이 아니면 손대지 않는다(사용자가 손으로 쓴 항목 보호).
 * @returns {Promise<number>} 헤더를 붙인 항목 수
 */
async function migrateContentHeaders(world) {
    const worldData = await loadWorldInfo(world);
    const entries = Object.values(worldData?.entries ?? {});
    if (!entries.length) return 0;

    let patched = 0;
    for (const entry of entries) {
        if (entry.constant) continue; // 코어 계열(규칙/일기/레거시)은 전부 constant=true라 이 조건 하나로 걸러진다
        const body = String(entry.content ?? '');
        if (!body.trim()) continue;
        if (INCIDENT_HEADER_RE.test(body)) continue;
        const meta = String(entry.comment ?? '').match(COMMENT_META_RE);
        if (!meta) continue;
        entry.content = buildIncidentContent(meta[2], stripDateTail(meta[1]) || '(무제)', body);
        patched++;
    }
    if (patched) await saveWorldInfo(world, worldData, true);
    return patched;
}

/**
 * 대상 로어북 자동 마이그레이션 — 채팅이 열릴 때 로어북당 1회.
 * 본문이 바뀜으니 임베딩도 같이 갱신해야 한다 — 재색인까지 돌려야 끝난 것이다.
 * 재색인만 실패하면 embeddingDirty로 수동 색인을 유도한다(본문은 이미 고쳐졌으니 재실행해도 둘째 번째는 건너뀜).
 */
async function runHeaderMigration() {
    const settings = getSettings();
    if (!Array.isArray(settings.headerMigratedWorlds)) settings.headerMigratedWorlds = [];
    const done = new Set(settings.headerMigratedWorlds);
    const targets = getTargetWorlds().filter(w => !done.has(w));
    if (!targets.length) return;

    let changed = false;
    for (const world of targets) {
        try {
            const patched = await migrateContentHeaders(world);
            done.add(world);
            changed = true;
            if (!patched) {
                console.log(`${LOG} 본문 날짜 헤더 마이그레이션: ${world} — 대상 없음`);
                continue;
            }
            console.log(`${LOG} 본문 날짜 헤더 마이그레이션: ${world} → ${patched}개 항목`);
            try {
                const indexed = await indexWorld(world);
                toastr.info(`'${world}' 항목 ${patched}개 본문에 날짜 헤더를 넣고 재색인했어요 (${indexed}개).`, 'Jev Lorebook');
            } catch (error) {
                settings.embeddingDirty = true;
                console.warn(`${LOG} '${world}' 마이그레이션 후 재색인 실패: ${error?.message ?? error}`);
                toastr.warning(`'${world}' 날짜 헤더는 넣었는데 재색인이 실패했어요. 설정에서 [색인]을 한 번 눌러주세요: ${error?.message ?? error}`, 'Jev Lorebook');
            }
        } catch (error) {
            // 마커를 안 찍고 넘어간다 — 다음 채팅 전환 때 다시 시도한다
            console.warn(`${LOG} '${world}' 헤더 마이그레이션 실패 — 다음 기회에 재시도: ${error?.message ?? error}`);
        }
    }
    if (changed) {
        settings.headerMigratedWorlds = [...done];
        saveSettingsDebounced();
    }
}

// ── 기존 항목 스플릿 (v0.4) ────────────────────────────────────────
// 레거시 통짜 로어북(constant 요약 덩어리)을 확장 안에서 날짜별 덩어리로 마이그레이션.
// 배포 유저는 스크립트를 못 쓰므로 st_lorebook_split.py 규칙을 그대로 이식했다.

/** 본문의 날짜 헤더 개수 (스플릿 후보 판정용) */
function countDateHeaders(text) {
    return [...String(text || '').matchAll(SPLIT_DATE_RE)].length;
}

/**
 * 날짜 헤더 기준 분할 — st_lorebook_split.py split_content()의 JS 이식.
 * 규칙: 선두 무날짜부는 200자 이상일 때만 독립 덩어리(날짜 null), 200자 미만 조각은 앞 덩어리에 흡수.
 * @returns {{date: string|null, chunk: string}[]}
 */
function splitEntryContent(text) {
    const source = String(text || '');
    const matches = [...source.matchAll(SPLIT_DATE_RE)];
    if (!matches.length) {
        return [{ date: null, chunk: source }];
    }
    const out = [];
    const positions = matches.map(m => m.index).concat([source.length]);
    if (positions[0] >= SPLIT_MIN_CHUNK) {
        out.push({ date: null, chunk: source.slice(0, positions[0]) });
    }
    for (let i = 0; i < matches.length; i++) {
        const chunk = source.slice(positions[i], positions[i + 1]);
        if (chunk.length < SPLIT_MIN_CHUNK && out.length) {
            out[out.length - 1] = { date: out[out.length - 1].date, chunk: out[out.length - 1].chunk + chunk };
        } else {
            out.push({ date: matches[i][1], chunk });
        }
    }
    return out;
}

/**
 * 선택된 항목 스플릿 실행 (로어북 1개 단위).
 * 순서: 백업 월드 생성(실패 시 중단) → 인메모리 분할+원본 삭제 → saveWorldInfo 1회 → 재색인.
 * 최종 save 이전에 던지면 원본 무변경 (백업 월드만 남을 수 있음 — 무해).
 * @returns {Promise<{entriesSplit: number, chunksCreated: number, backupName: string, indexed: number}>}
 */
async function runSplitForWorld(world, uids, setStatus) {
    const worldData = await loadWorldInfo(world);
    if (!worldData?.entries) {
        throw new Error(`로어북 '${world}' 로드 실패`);
    }

    // 1. 백업 — saveWorldInfo가 새 월드 파일 생성을 겸한다 (createNewWorldInfo가 빈 템플릿으로 쓰는 것이 증거, world-info.js:4336→4097).
    //    createNewWorldInfo 자체는 에디터 UI 전환 + 덮어쓰기 확인 팝업이 딸려 있어 백업용으로 부적합.
    // 로컬 시간 기준 — toISOString()은 UTC라 백업 이름이 어제 날짜로 보였다 (발주 보고 수정)
    const now = new Date();
    const p2 = n => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
    let backupName = `${world} (백업 ${stamp})`;
    for (let n = 2; (world_names ?? []).includes(backupName); n++) {
        backupName = `${world} (백업 ${stamp}-${n})`;
    }
    setStatus(`백업 생성 중… ${backupName}`);
    await saveWorldInfo(backupName, structuredClone(worldData), true);
    await updateWorldInfoList(); // world_names 갱신 (world-info.js:2061)
    if (!(world_names ?? []).includes(backupName)) {
        throw new Error(`백업 월드 '${backupName}' 생성을 확인하지 못했어요 — 스플릿을 중단했어요 (원본은 그대로예요)`);
    }

    // 2. 인메모리 분할 — uid는 기존 최대+1부터 순차 할당 (삭제로 빈 uid 재사용 안 함)
    let nextUid = Math.max(-1, ...Object.values(worldData.entries).map(e => Number(e.uid) || 0)) + 1;
    let entriesSplit = 0;
    let chunksCreated = 0;
    for (const uid of uids) {
        const entry = worldData.entries[uid];
        if (!entry) continue;
        if (String(entry.comment ?? '').includes('⭐')) continue; // 코어 메모리 절대 불가침 (이중 방어)
        const title = String(entry.comment || `uid ${uid}`).trim();
        const pieces = splitEntryContent(entry.content);
        for (const piece of pieces) {
            const chunk = piece.chunk.trim();
            if (!chunk) continue;
            const newEntry = { uid: nextUid, ...structuredClone(newWorldInfoEntryTemplate) };
            newEntry.uid = nextUid; // 템플릿에 uid 기본값이 있어 재지정
            newEntry.key = []; // 키워드 발동 미사용 — 발동은 Jev 단일 경로
            newEntry.comment = piece.date ? `${title} · ${piece.date}` : `${title} · (머리말)`;
            newEntry.content = chunk;
            newEntry.constant = false; // 핵심: 통째 주입 중단
            newEntry.disable = false;
            newEntry.displayIndex = nextUid;
            worldData.entries[nextUid] = newEntry;
            nextUid++;
            chunksCreated++;
        }
        delete worldData.entries[uid]; // 분할 성공분만 삭제 (전부 인메모리 — 아직 미저장)
        entriesSplit++;
    }
    if (!chunksCreated) {
        throw new Error('분할 결과가 0덩어리라 저장하지 않았어요 (원본은 그대로예요)');
    }

    // 3. 저장 + 재색인
    setStatus(`저장 중… ${entriesSplit}항목 → ${chunksCreated}덩어리`);
    await saveWorldInfo(world, worldData, true);
    reloadEditor(world); // 에디터 실시간 갱신 (열려 있을 때만)
    setStatus('재색인 중…');
    const indexed = await indexWorld(world, setStatus);

    console.log(`${LOG} 스플릿 완료 — '${world}' ${entriesSplit}항목 → ${chunksCreated}덩어리 / 색인 ${indexed} / 백업 '${backupName}'`);
    return { entriesSplit, chunksCreated, backupName, indexed };
}

/** 스플릿 선택 다이얼로그 — 대상 로어북 항목 체크박스 목록, 유저 확인 후 실행 */
async function openSplitDialog(setStatus, $panel) {
    const worlds = getTargetWorlds();
    if (!worlds.length) {
        toastr.error('대상 로어북이 없어요. 채팅·캐릭터·전역·페르소나 중 한 곳에 로어북을 연결하거나 고정 대상을 설정해 주세요.', 'Jev Lorebook');
        return;
    }

    const $dialog = $('<div class="jev-split-dialog">');
    $dialog.append($('<h3>').text('기존 항목 스플릿'));
    $dialog.append($('<div class="jev-panel-muted">').text(
        '체크된 항목을 날짜 헤더(YYYY-MM-DD) 기준으로 나눠서 검색 가능한 덩어리로 바꿔 드려요. '
        + '새 항목은 constant가 해제되고(통째 주입 중단), 원본은 분할이 성공한 뒤에 삭제돼요. '
        + '실행 전에 로어북 전체를 새 월드로 백업해 두니 안심하세요. ⭐ Core Memory는 대상에서 제외돼요.'));

    let candidateCount = 0;
    let listedCount = 0;
    for (const world of worlds) {
        const worldData = await loadWorldInfo(world);
        const entries = Object.values(worldData?.entries ?? {})
            .filter(e => String(e.content ?? '').trim() && !String(e.comment ?? '').includes('⭐'))
            .sort((a, b) => (Number(a.uid) || 0) - (Number(b.uid) || 0));
        if (!entries.length) continue;

        $dialog.append($('<div class="jev-panel-world-title">').text(world));
        for (const e of entries) {
            const content = String(e.content ?? '');
            const dateCount = countDateHeaders(content);
            const estTokens = Math.max(1, Math.round(content.length / SPLIT_EST_CHARS_PER_TOKEN));
            // 기본 체크 = 스플릿 후보: 날짜헤더 2개 이상 또는 constant 대형 항목
            const isCandidate = dateCount >= 2 || (e.constant && content.length > SPLIT_BIG_CONSTANT_CHARS);
            if (isCandidate) candidateCount++;
            listedCount++;
            const $label = $('<label class="jev-split-row checkbox_label">');
            const $checkbox = $('<input type="checkbox">')
                .attr('data-world', world)
                .attr('data-uid', String(e.uid))
                .prop('checked', isCandidate);
            $label.append($checkbox);
            $label.append($('<span class="jev-cell-title">').text(String(e.comment || `uid ${e.uid}`).slice(0, 48)));
            $label.append($('<small class="jev-panel-muted">').text(
                `≈${estTokens}토큰 · 날짜헤더 ${dateCount}개${e.constant ? ' · constant' : ''}${e.disable ? ' · 비활성' : ''}`));
            $dialog.append($label);
        }
    }

    if (!listedCount) {
        toastr.info('스플릿할 항목이 없어요 (본문이 있는 항목이 없어요).', 'Jev Lorebook');
        return;
    }
    $dialog.append($('<div class="jev-panel-muted">').text(`기본으로 ${candidateCount}개를 체크해 뒀어요 = 스플릿 후보 (날짜헤더 2개 이상 또는 대형 constant). 목록을 확인하고 체크를 자유롭게 바꾸셔도 돼요.`));

    const result = await callGenericPopup($dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: '스플릿 실행',
        cancelButton: '취소',
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return; // 유저 취소 — 무변경
    }

    // 체크된 항목 수집 (월드별)
    const selection = new Map();
    $dialog.find('input[type="checkbox"]:checked').each(function () {
        const world = String($(this).attr('data-world'));
        const uid = Number($(this).attr('data-uid'));
        if (!selection.has(world)) selection.set(world, []);
        selection.get(world).push(uid);
    });
    if (!selection.size) {
        toastr.info('선택된 항목이 없어서 아무것도 바꾸지 않았어요.', 'Jev Lorebook');
        return;
    }

    try {
        let totalSplit = 0;
        let totalChunks = 0;
        const backups = [];
        for (const [world, uids] of selection) {
            const r = await runSplitForWorld(world, uids, setStatus);
            totalSplit += r.entriesSplit;
            totalChunks += r.chunksCreated;
            backups.push(r.backupName);
        }
        setStatus(`스플릿 완료: ${totalSplit}항목 → ${totalChunks}덩어리 · 백업: ${backups.join(', ')}`);
        const firstWorld = selection.keys().next().value;
        toastr.success(`${totalSplit}개 항목을 ${totalChunks}개 덩어리로 나눴어요. 백업: ${backups.join(', ')}. 여기를 누르면 에디터에서 바로 확인할 수 있어요.`, 'Jev Lorebook', { onclick: () => openWorldEditor(firstWorld), timeOut: 10000 });
        if ($panel) {
            renderPanelSummary($panel);
            await renderPanelChunks($panel);
        }
    } catch (error) {
        console.error(`${LOG} 스플릿 실패`, error);
        setStatus(`스플릿에 실패했어요: ${error?.message ?? error}`);
        toastr.error(`스플릿에 실패했어요: ${error?.message ?? error}`, 'Jev Lorebook');
    }
}

// ── 세부 패널 (요술봉 메뉴) ─────────────────────────────────────────────

/**
 * 직전 변환 되돌리기 (v0.11.0).
 * 항목 삭제 → 코어 복원 → 변환 지점·작중 앵커 원복 → 숨김 해제 → 재색인.
 * 벡터는 재색인으로 청소한다(발주자 결정) — 삭제한 항목의 벡터가 남으면 '없는 항목'이 후보로 올라온다.
 */
async function undoLastConversion(setStatus) {
    const ctx = SillyTavern.getContext();
    const snap = ctx.chatMetadata?.[UNDO_META_KEY];
    if (!snap || !snap.world) throw new Error('되돌릴 변환 기록이 없어요');
    const worldData = await loadWorldInfo(snap.world);
    if (!worldData) throw new Error(`로어북 '${snap.world}'을 찾지 못했어요`);

    setStatus('추가된 항목 삭제 중…');
    let removed = 0;
    for (const uid of snap.addedUids ?? []) {
        if (worldData.entries?.[String(uid)]) {
            delete worldData.entries[String(uid)];
            removed++;
        }
    }

    // 코어 규칙 복원 (v0.13.0) — 이번 실행이 새로 만든 것이면 삭제, 있던 것이면 본문만 되돌린다.
    let rulesNote = '규칙 변경 없음';
    if (snap.prevCoreRules) {
        if (snap.prevCoreRules.existed) {
            const entry = worldData.entries?.[String(snap.prevCoreRules.uid)];
            if (entry) {
                entry.content = snap.prevCoreRules.content;
                // v0.17.0 — 꺼짐 상태까지 되돌린다. v0.16.0 이전 스냅샷엔 이 필드가 없으니 있을 때만 건드린다.
                if (snap.prevCoreRules.disable !== undefined) entry.disable = snap.prevCoreRules.disable === true;
                rulesNote = '규칙 본문 복원';
            } else {
                rulesNote = '규칙 항목을 찾지 못해 복원 안 됨';
            }
        } else {
            const cur = findCoreRulesEntry(worldData);
            if (cur) {
                delete worldData.entries[String(cur.uid)];
                removed++;
                rulesNote = '규칙 항목 삭제 (이번 변환에서 새로 만든 것)';
            }
        }
    }

    // 코어 일기 복원 (v0.13.0) — 갱신·봉인·강등을 전부 스냅샷 통째 비교로 되돌린다.
    // 이번 실행 전에 없던 일기(새로 연 것)는 삭제, 있던 것은 comment/content/constant/order를 그대로 되돌린다.
    let diaryNote = '일기 변경 없음';
    if (Array.isArray(snap.prevCoreDiaries)) {
        const prevUids = new Set(snap.prevCoreDiaries.map(d => String(d.uid)));
        const nowDiaryLike = Object.values(worldData.entries ?? {})
            .filter(e => parseDiaryComment(e.comment) || String(e.comment ?? '').startsWith(DIARY_ARCHIVE_COMMENT_PREFIX));
        let deletedNew = 0;
        for (const e of nowDiaryLike) {
            if (!prevUids.has(String(e.uid))) {
                delete worldData.entries[String(e.uid)];
                removed++;
                deletedNew++;
            }
        }
        let restored = 0;
        for (const d of snap.prevCoreDiaries) {
            const entry = worldData.entries?.[String(d.uid)];
            if (!entry) continue;
            entry.comment = d.comment;
            entry.content = d.content;
            entry.constant = d.constant;
            entry.order = d.order;
            // v0.17.0 — 꺼짐 상태까지 되돌린다. v0.16.0 이전 스냅샷엔 이 필드가 없으니 있을 때만 건드린다.
            if (d.disable !== undefined) entry.disable = d.disable === true;
            restored++;
        }
        if (deletedNew || restored) {
            diaryNote = `일기 ${restored}개 복원${deletedNew ? ` · 신규 ${deletedNew}개 삭제` : ''}`;
        }
    }
    await saveWorldInfo(snap.world, worldData, true);
    reloadEditor(snap.world);

    // 값이 없었으면 키 자체를 지운다 — 0으로 덮으면 '첫 변환 전' 상태와 달라진다
    if (snap.prevMarker === null || snap.prevMarker === undefined) delete ctx.chatMetadata[CONVERT_META_KEY];
    else ctx.chatMetadata[CONVERT_META_KEY] = snap.prevMarker;
    if (snap.prevAnchor === null || snap.prevAnchor === undefined) delete ctx.chatMetadata[STORY_ANCHOR_META_KEY];
    else ctx.chatMetadata[STORY_ANCHOR_META_KEY] = snap.prevAnchor;
    delete ctx.chatMetadata[UNDO_META_KEY];
    await ctx.saveMetadata();

    // 숨김 해제 — hideChatMessageRange(chats.js:147) 세 번째 인자 true = unhide
    let unhidden = 0;
    if (Number.isFinite(snap.hiddenFrom) && Number.isFinite(snap.hiddenTo) && snap.hiddenTo >= snap.hiddenFrom) {
        setStatus('숨긴 메시지 복구 중…');
        await hideChatMessageRange(snap.hiddenFrom, snap.hiddenTo, true);
        unhidden = snap.hiddenTo - snap.hiddenFrom + 1;
    }

    setStatus('재색인 중…');
    const indexed = await indexWorld(snap.world, setStatus);
    lastConvertWarnings = [];
    console.log(`${LOG} 되돌리기 완료 — 항목 ${removed}개 삭제 / ${rulesNote} / ${diaryNote} / 메시지 ${unhidden}개 복구 / ${indexed}개 재색인`);
    return { removed, rulesNote, diaryNote, unhidden, indexed };
}

/** 되돌리기 버튼 노출 — 스냅샷이 있을 때만 (v0.11.0) */
function renderUndoButton($panel) {
    const ctx = SillyTavern.getContext();
    const snap = ctx.chatMetadata?.[UNDO_META_KEY];
    const $btn = $panel.find('#jev_panel_undo');
    if (!snap || !snap.world) {
        $btn.hide();
        return;
    }
    const when = new Date(Number(snap.ts) || Date.now());
    const hh = String(when.getHours()).padStart(2, '0');
    const mm = String(when.getMinutes()).padStart(2, '0');
    $btn.find('span').text(`직전 변환 되돌리기 (${hh}:${mm} · ${Number(snap.incidentCount) || 0}건)`);
    $btn.show();
}

/** 상태 요약 렌더 */
function renderPanelSummary($panel) {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    const detailed = getTargetWorldsDetailed();
    const worlds = detailed.map(d => d.name);
    const convertWorld = getConversionTargetWorld();
    const chatLength = (ctx.chat ?? []).length;
    const converted = Math.max(0, Number(ctx.chatMetadata?.[CONVERT_META_KEY]) || 0);

    const $summary = $panel.find('#jev_panel_summary').empty();
    const row = (label, value) => $('<div class="jev-panel-row">')
        .append($('<span class="jev-panel-label">').text(label))
        .append($('<span>').text(value));
    $summary.append(row('상태', settings.enabled ? '켜짐' : '꺼짐'));
    $summary.append(row('대상 로어북', detailed.length
        ? `${detailed.length}개 — ` + detailed.map(d => `${d.name} (${LAYER_LABELS[d.layer] ?? d.layer})`).join(', ')
        : '없음 (채팅·캐릭터·전역·페르소나 어디에도 연결된 로어북이 없어요)'));
    // 북별 오버라이드가 있으면 실효 총예산은 '북별 유효값의 합'이다 — 전역값만 띄우면 이 줄이 거짓말한다 (v0.17.0)
    const budgetSum = worlds.reduce((sum, name) => sum + getBudgetTokens(name), 0);
    $summary.append(row('턴당 예산', worlds.length
        ? `북별 합계 ${budgetSum.toLocaleString()}토큰 (전역 기본 ${getBudgetTokens().toLocaleString()})`
        : `${getBudgetTokens().toLocaleString()}토큰 (전역 기본)`));
    $summary.append(row('전송', jevTransport ? jevTransport.label : (lastTransportError ? `없음 — ${lastTransportError}` : '미감지 (첫 생성 때 자동으로 감지해요)')));
    const embedMeta = EMBEDDING_SOURCES[settings.embeddingSource] ?? EMBEDDING_SOURCES.palm;
    const embedModel = embedMeta.modelFromRequest ? (String(settings.embeddingModel || '').trim() || embedMeta.defaultModel) : '(서버 고정)';
    const embedDedicated = settings.embeddingSource === 'palm' && settings.embeddingKeyMode === 'dedicated';
    const embedKey = embedDedicated
        ? (String(settings.embeddingDedicatedKey || '').trim() ? '전용 키 사용 중 ✓' : '전용 키 미입력 ✗')
        : (embedMeta.secretKey === null ? '키 불필요' : (hasEmbeddingKey(embedMeta) ? 'ST 저장 키 사용 중 ✓' : '키 미등록 ✗'));
    $summary.append(row('임베딩', `${embedMeta.label} · ${embedModel} · ${embedKey}${settings.embeddingDirty ? ' · ⚠ 재색인 필요' : ''}`));
    $summary.append(row('변환 프로필', getConvertProfileLabel()));
    const keepRecent = Number.isFinite(Number(settings.keepRecent)) ? Math.max(0, Number(settings.keepRecent)) : defaultSettings.keepRecent;
    $summary.append(row('변환 대상', convertWorld || '없음'));
    $summary.append(renderChatStack(ctx.chat ?? [], converted, keepRecent, chatLength));
    renderConvertProfileBadge($panel);
    renderUndoButton($panel);
}

/**
 * 챗 적치 현황 — 세 구간을 가로 막대로 보여준다.
 *   정리됨(이미 로어북으로 감) / 대기(지금 누르면 처리됨) / 보존(최근 N개, 손 안 댈)
 * 숫자만 나열하면 "지금 변환해야 하나"를 한눈에 못 읽는다 — 비율로 보여야 읽힌다.
 */
function renderChatStack(chat, converted, keepRecent, chatLength) {
    const pendingEnd = Math.max(converted, chatLength - keepRecent);
    const pendingCount = Math.max(0, pendingEnd - converted);
    const bufferCount = Math.max(0, chatLength - pendingEnd);
    const pct = (n) => (chatLength > 0 ? `${(n / chatLength) * 100}%` : '0%');

    const $box = $('<div class="jev-stack-box">');
    $box.append($('<div class="jev-stack-head">')
        .append($('<span class="jev-panel-label">').text('챗 적치'))
        .append($('<span class="jev-panel-muted">').text(`전체 ${chatLength}개`)));

    const $bar = $('<div class="jev-stack-bar">');
    const seg = (cls, n, title) => $('<div>').addClass(`jev-stack-seg ${cls}`).css('width', pct(n)).attr('title', title);
    $bar.append(seg('jev-seg-done', converted, `정리됨 ${converted}개`));
    $bar.append(seg('jev-seg-pending', pendingCount, `변환 대기 ${pendingCount}개`));
    $bar.append(seg('jev-seg-buffer', bufferCount, `보존 ${bufferCount}개`));
    $box.append($bar);

    const $legend = $('<div class="jev-stack-legend">');
    const leg = (cls, icon, label, text) => $('<span class="jev-leg">')
        .append($('<i>').addClass(`jev-dot ${cls}`))
        .append($('<b>').text(`${icon} ${label}`))
        .append($('<span>').text(` ${text}`));
    const $legPending = leg('jev-seg-pending', '⏳', '대기', `${pendingCount}건`);
    const $legBuffer = leg('jev-seg-buffer', '🔒', '보존', `${bufferCount}건`);
    $legend.append(leg('jev-seg-done', '✅', '정리됨', `${converted}건`));
    $legend.append($legPending);
    $legend.append($legBuffer);
    $box.append($legend);

    const $verdict = $('<div class="jev-stack-verdict">')
        .text(pendingCount ? '⏳ 토큰을 세는 중이에요…' : '✔️ 쌓인 게 없어요 — 새 메시지가 보존 구간 안에만 있어요');
    $box.append($verdict);

    if (pendingCount) {
        void fillStackTokens({ $legPending, $legBuffer, $verdict }, chat, converted, pendingEnd, keepRecent, chatLength);
    }
    return $box;
}

/**
 * 막대 범례·판정문에 토큰을 채운다. 패널 렌더를 막지 않게 비동기로 분리.
 * 보존 버퍼는 변환 대상이 아니라 합산하지 않고 따로 보여준다.
 */
async function fillStackTokens($slots, chat, from, to, keepRecent, chatLength) {
    const join = (arr) => arr.map(m => String(m?.mes || '')).filter(Boolean).join('\n');
    try {
        const pendingBody = join(chat.slice(from, to));
        const pendingTokens = pendingBody ? await getTokenCountAsync(pendingBody) : 0;
        const bufBody = keepRecent ? join(chat.slice(Math.max(0, chatLength - keepRecent))) : '';
        const bufTokens = bufBody ? await getTokenCountAsync(bufBody) : 0;
        const count = Math.max(0, to - from);

        $slots.$legPending.find('span').last().text(` ${count}건 · ${pendingTokens.toLocaleString()}tok`);
        $slots.$legBuffer.find('span').last().text(` ${Math.max(0, chatLength - to)}건 · ${bufTokens.toLocaleString()}tok`);

        // 판정문 — 숫자를 보고도 "그래서 눌러야 되나"를 못 정하는 걸 막는다
        let mark = '✔️';
        let verdict = '아직 여유 있어요';
        if (pendingTokens >= 20000) { mark = '🔴'; verdict = '꽤 많이 쌓였어요 — 지금 변환하는 걸 추천해요'; }
        else if (pendingTokens >= 8000) { mark = '🟡'; verdict = '변환할 만해요'; }
        $slots.$verdict
            .toggleClass('jev-verdict-hot', pendingTokens >= 20000)
            .toggleClass('jev-verdict-warm', pendingTokens >= 8000 && pendingTokens < 20000)
            .text(`${mark} 지금 [챗→로어북 변환]을 누르면 ${count}건 · ${pendingTokens.toLocaleString()}토큰이 로어북으로 넘어가요 — ${verdict}`);
    } catch (error) {
        $slots.$verdict.addClass('jev-panel-error').text(`토큰 집계에 실패했어요: ${error?.message ?? error}`);
    }
}

/**
 * Jev 탈락 후보 표 (v0.9.1) — 접힘 블록 안에서만 그린다.
 * v0.9.0까지 '직전 턴 판정' 섹션의 본체였던 렌더를 그대로 옮겨 왔다(3축 점수 세부 = 모순위험/장면적합/최근중복).
 * 채택분은 위 주입 표에 🧠로 이미 있으니 여기서는 탈락분만 나열한다 — 같은 사건이 두 번 나오던 게 소음의 주범이었다.
 * 북별 그룹 헤더는 v0.8.0 패턴 그대로(4계층이라 여러 북이 섞인다).
 */
function renderPanelJudgment($box, rejected) {
    const meta = `${new Date(lastReport.ts).toLocaleTimeString()} · type=${lastReport.type} · 후보 ${lastReport.candidateCount} → 채택 ${lastReport.adoptedCount} · ${lastReport.usedTokens}토큰 · ${lastReport.ms}ms`
        + (lastReport.cacheHits ? ` · 캐시 재사용 ${lastReport.cacheHits}회` : '')
        + ` — 대상 ${lastReport.worlds.length}개: ${lastReport.worlds.join(', ')}`;
    $box.append($('<div class="jev-panel-muted">').text(meta));

    // '월드' 칸을 없애고 그룹 헤더로 올렸다 — 16자로 잘린 칸으로는 북이 여럿일 때 분간이 안 된다.
    // '채택' 칸은 v0.9.1에서 없앴다 — 여기 오는 행은 전부 탈락분이라 빈 칸만 남는다.
    const headers = ['uid', '제목', '모순위험', '장면적합', '최근중복', '최종', '토큰', ''];
    const $table = $('<table class="jev-panel-table">');
    const $thead = $('<tr>');
    for (const h of headers) {
        $thead.append($('<th>').text(h));
    }
    $table.append($('<thead>').append($thead));
    const $tbody = $('<tbody>');

    const layerOf = new Map(getTargetWorldsDetailed().map(d => [d.name, d.layer]));
    const groups = new Map();
    for (const r of rejected) {
        const key = String(r.world);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }

    for (const [world, rows] of groups) {
        const $groupCell = $('<td>').attr('colspan', headers.length);
        const layer = layerOf.get(world);
        if (layer) $groupCell.append($('<span class="jev-layer-badge">').text(LAYER_LABELS[layer] ?? layer));
        $groupCell.append($('<span class="jev-group-name">').text(world));
        $groupCell.append($('<span class="jev-group-meta">').text(`탈락 ${rows.length}개`));
        $tbody.append($('<tr class="jev-panel-group-row">').append($groupCell));

        for (const r of rows) {
            const $tr = $('<tr>');
            $tr.append($('<td>').text(r.uid));
            $tr.append($('<td class="jev-cell-title">').text(String(r.title).slice(0, 48)));
            $tr.append($('<td>').text(r.contradiction.toFixed(2)));
            $tr.append($('<td>').text(r.sceneFit.toFixed(2)));
            $tr.append($('<td>').text(r.duplicate.toFixed(2)));
            $tr.append($('<td>').text(r.final.toFixed(3)));
            $tr.append($('<td>').text(r.tokens ?? '—'));

            // 전문 펼치기(v0.6.4) — 점수만 보고는 왜 빠졌는지 몰라서 여기가 제일 많이 쓰인다.
            const { $cell, $detail } = buildDetailToggle(r.text, headers.length, { world, uid: r.uid });
            $tr.append($cell);
            $tbody.append($tr).append($detail);
        }
    }
    $table.append($tbody);
    $box.append($table);
}

/** 색인 현황 렌더 — 로어북 항목 hash를 /api/vector/list 결과와 대조 */
async function renderPanelChunks($panel) {
    const $box = $panel.find('#jev_panel_chunks').empty();
    const detailed = getTargetWorldsDetailed();
    const layerOf = new Map(detailed.map(d => [d.name, d.layer]));
    const worlds = detailed.map(d => d.name);
    if (!worlds.length) {
        $box.append($('<div class="jev-panel-muted">').text('대상 로어북이 없어요.'));
        return;
    }
    $box.append($('<div class="jev-panel-muted">').text('색인 대조 중…'));

    for (const world of worlds) {
        const $section = $('<div class="jev-panel-world">');
        let indexedHashes = null;
        let listError = '';
        try {
            indexedHashes = await vectorList(world);
        } catch (error) {
            listError = String(error?.message ?? error);
        }

        let worldData;
        try {
            worldData = await loadWorldInfo(world);
        } catch {
            worldData = null;
        }
        const allEntries = Object.values(worldData?.entries ?? {});
        // 코어(constant) 항목은 색인·판정 밖 — 별도 섹션으로 표시. v0.13.0: 규칙/일기/기타(수동 승격)로 다시 나눈다.
        // v0.17.0 — 꺼진 항목(disable)을 **두 표 모두에 회색 행으로 남긴다.** 안 남기면 어느 표에도 안 나와서
        // 확장 안에서 되살릴 방법이 없다(동그라미 버튼이 유일한 복귀 경로다).
        // 대신 색인 대조·합계 토큰에서는 반드시 뺀다 — 매 턴 주입되지 않는 것을 세면 그 줄이 거짓말한다.
        const coreEntries = allEntries.filter(e => e.constant && String(e.content ?? '').trim());
        const coreRules = coreEntries.filter(e => e.comment === CORE_RULES_COMMENT);
        const coreDiaries = coreEntries.filter(e => parseDiaryComment(e.comment))
            .sort((a, b) => parseDiaryComment(a.comment).start.localeCompare(parseDiaryComment(b.comment).start));
        const coreOther = coreEntries.filter(e => e.comment !== CORE_RULES_COMMENT && !parseDiaryComment(e.comment));
        const entries = allEntries.filter(e => !e.constant && String(e.content ?? '').trim());
        const liveEntries = entries.filter(e => !e.disable);           // 집계·색인 대조 기준 = 켜진 것만
        const offEntries = entries.length - liveEntries.length;        // 회색 행으로 표에 남는다
        const emptyCount = allEntries.length - entries.length - coreEntries.length; // 본문이 비어 표에서 빠진 것

        let indexedCount = 0;
        const $table = $('<table class="jev-panel-table">');
        const $thead = $('<tr>');
        // '날짜키' 칸 제거(v0.6.4) — keys[0]을 찍던 자리였고, v0.6.0에서 날짜 키 생성을 없앤 뒤로는
        // 사용자가 직접 넣은 키워드가 올라와 칸 이름이 거짓말을 하고 있었다. 본문은 [전문] 버튼으로 본다.
        for (const h of ['색인', 'uid', '제목', '≈토큰', '', '']) {
            $thead.append($('<th>').text(h));
        }
        $table.append($('<thead>').append($thead));
        const $tbody = $('<tbody>');
        for (const e of entries) {
            const content = String(e.content ?? '');
            const isOff = getEntryState(e) === ENTRY_STATE_OFF;
            const hash = getStringHash(content);
            const isIndexed = indexedHashes ? indexedHashes.has(Number(hash)) : false;
            if (isIndexed && !isOff) indexedCount++;
            // 꺼진 항목의 색인 칸은 '—'다. 벡터엔 남아 있어도 주입 대상이 아니라 ✓를 찍으면 거짓말이 된다.
            const $tr = $('<tr>')
                .toggleClass('jev-row-off', isOff)
                .toggleClass('jev-missing', (!isOff && indexedHashes) ? !isIndexed : false);
            $tr.append($('<td>').text(isOff ? '—' : (indexedHashes ? (isIndexed ? '✓' : '✗') : '?')));
            $tr.append($('<td>').text(e.uid));
            $tr.append($('<td class="jev-cell-title">').text(String(e.comment || `uid ${e.uid}`).slice(0, 48)));
            $tr.append($('<td>').text(approxTokens(content)));
            $tr.append(buildStateToggle(world, e.uid, getEntryState(e), $panel));

            const { $cell, $detail } = buildDetailToggle(content, 6, { world, uid: e.uid });
            $tr.append($cell);
            $tbody.append($tr).append($detail);
        }
        $table.append($tbody);

        const headline = listError
            ? `${world} — 항목 ${liveEntries.length}개 / 색인 대조에 실패했어요: ${listError}`
            : `${world} — 항목 ${liveEntries.length}개 / 색인 ${indexedCount}개 / 미색인 ${liveEntries.length - indexedCount}개`
              + (indexedHashes ? ` (벡터 저장소 ${indexedHashes.size}건)` : '')
              + (offEntries ? ` · 꺼진 항목 ${offEntries}개 (회색 행)` : '')
              + (emptyCount ? ` · 본문 빈 항목 ${emptyCount}개 제외` : '');
        const $worldTitle = $('<div class="jev-panel-world-title">');
        const layer = layerOf.get(world);
        if (layer) $worldTitle.append($('<span class="jev-layer-badge">').text(LAYER_LABELS[layer] ?? layer));
        $worldTitle.append($('<span>').text(headline));
        $section.append($worldTitle);
        $section.append($('<div class="jev-panel-muted">').text(
            '동그라미를 누르면 🔵 상시 메모리(매 턴 주입) → 🟢 검색층 → ⚫ 꺼짐 순서로 바뀌어요. '
            + '⚫에서 한 번 더 누르면 원래 색으로 돌아와요.'));

        // 코어 섹션 — constant라 ST가 매턴 네이티브 주입, Jev 판정·벡터 색인 제외.
        // v0.13.0: 규칙(최대 1) · 일기(최대 3, 오래된→최신, 봉인/열림 배지) · 기타(수동 승격분)를 구분 표시한다.
        if (coreEntries.length) {
            // ⚠ 합계 토큰에서 꺼진 파랑은 뺀다 (v0.17.0) — 매 턴 주입되지 않는 걸 합계에 넣으면 이 줄이 거짓말한다.
            const coreLive = coreEntries.filter(e => !e.disable);
            const coreOffCount = coreEntries.length - coreLive.length;
            const coreTokens = coreLive.reduce((sum, e) => sum + approxTokens(e.content), 0);
            const liveOtherCount = coreOther.filter(e => !e.disable).length;
            const budget = getBudgetTokens(world); // 북별 유효 예산 (오버라이드 반영)
            const $core = $('<div class="jev-panel-core">');
            $core.append($('<div class="jev-panel-core-title">').text(
                `⭐ 코어 ${coreLive.length}개 (규칙 ${coreRules.filter(e => !e.disable).length} · 일기 ${coreDiaries.filter(e => !e.disable).length}${liveOtherCount ? ` · 기타 ${liveOtherCount}` : ''})`
                + `${coreOffCount ? ` · 꺼짐 ${coreOffCount}개(합계 제외)` : ''} `
                + `· 합계 ≈${coreTokens.toLocaleString()}토큰 · 주입 예산 ${budget.toLocaleString()} → 매 턴 ≈${(coreTokens + budget).toLocaleString()}토큰`));
            $core.append($('<div class="jev-panel-muted">').text('매 턴 항상 주입돼요 (constant, Jev 판정을 거치지 않아요). 회색 행은 꺼진 항목이라 주입되지 않아요.'));

            const $coreTable = $('<table class="jev-panel-table">');
            const $coreHead = $('<tr>');
            for (const h of ['구분', 'uid', '제목', '≈토큰', '', '']) {
                $coreHead.append($('<th>').text(h));
            }
            $coreTable.append($('<thead>').append($coreHead));
            const $coreBody = $('<tbody>');
            // 표시 순서: 규칙(최상단) → 일기(오래된→최신) → 기타(수동 승격분, 옛 단일 코어 등)
            const coreRows = [
                ...coreRules.map(e => ({ e, kind: '📏 규칙' })),
                ...coreDiaries.map(e => ({ e, kind: isDiarySealed(e) ? '📔 일기 · 봉인' : '📖 일기 · 열림' })),
                ...coreOther.map(e => ({ e, kind: '' })),
            ];
            for (const { e, kind } of coreRows) {
                const content = String(e.content ?? '');
                const isOff = getEntryState(e) === ENTRY_STATE_OFF;
                const $tr = $('<tr>').toggleClass('jev-row-off', isOff);
                $tr.append($('<td>').text(isOff ? (kind ? `${kind} · 꺼짐` : '꺼짐') : kind));
                $tr.append($('<td>').text(e.uid));
                $tr.append($('<td class="jev-cell-title">').text(String(e.comment || `uid ${e.uid}`).slice(0, 48)));
                $tr.append($('<td>').text(approxTokens(content)));
                $tr.append(buildStateToggle(world, e.uid, getEntryState(e), $panel));

                const { $cell, $detail } = buildDetailToggle(content, 6, { world, uid: e.uid });
                $tr.append($cell);
                $coreBody.append($tr).append($detail);
            }
            $coreTable.append($coreBody);
            $core.append($coreTable);
            $section.append($core);
        }

        $section.append($table);
        $box.find('.jev-panel-muted').remove();
        $box.append($section);
    }
}

/** 합친 섹션 제목 (v0.9.1) — 한 군데서만 쓴다. 패널은 언제나 지나간 턴을 본다. */
const INJECTED_TITLE = '직전 턴 — 프롬프트에 들어간 것';

/**
 * 직전 턴 — 프롬프트에 들어간 것 (v0.9.1).
 * v0.9.0까지는 '직전 턴 판정'(인터셉터, WI 스캔 전)과 '이번 턴 실제 주입'(WORLD_INFO_ACTIVATED, 스캔 후)을
 * 따로 그렸다. 둘은 같은 턴의 같은 사건을 두 각도에서 본 것이라 Jev 채택분이 양쪽에 중복으로 나왔다.
 * → 기준을 '프롬프트에 들어갔나' 하나로 합치고, 탈락 후보는 접힘 블록으로 내렸다.
 * 분류 3종:
 *   ⭐ 코어    entry.constant === true (ST 네이티브 매턴 주입)
 *   🧠 Jev     lastReport의 채택 집합에 있는 것 = FORCE_ACTIVATE로 넣은 것
 *   🔑 키워드  나머지 전부 (키워드·sticky·데코레이터·min_activations — 확장 예산 밖에서 걸린 것들)
 * 키워드와 Jev는 OR로 병존한다. 이중 주입은 ST가 allActivatedEntries를
 * `${world}.${uid}` 키 Map으로 들고 있어 자연 방지된다 (world-info.js:4685·4956 실측).
 */
function renderPanelInjected($panel) {
    const $box = $panel.find('#jev_panel_injected').empty();
    const $title = $panel.find('#jev_panel_injected_title');

    // 판정 실패는 접힘 블록에 숨기지 않는다 — 표가 비는 이유가 여기 있을 수 있다.
    if (lastError) {
        $box.append($('<div class="jev-panel-error">').text(`⚠ 직전 판정이 실패했어요 (${new Date(lastError.ts).toLocaleTimeString()}): ${lastError.message}`));
    }

    if (!lastActivated || !lastActivated.entries.length) {
        $title.text(INJECTED_TITLE);
        $box.append($('<div class="jev-panel-muted">').text('아직 기록이 없어요 — 메시지를 한 번 보내면 여기에 표시돼요.'));
        return;
    }

    // 채택 여부·최종점수·판정 시점 본문은 전부 lastReport에서 온다.
    // lastReport가 없으면(첫 로드/판정 실패) 점수 칸과 탈락 블록만 빠지고 표는 그대로 그린다.
    const reportRows = new Map((lastReport?.rows ?? []).map(r => [`${r.world}.${r.uid}`, r]));
    const KIND_BADGE = { core: '⭐ 코어', jev: '🧠 Jev', random: '🎲 랜덤', keyword: '🔑 키워드' };
    // 🎲는 판정을 안 거쳤으니 점수 칸이 '—'다 (⭐·🔑과 같은 이유). 순서는 ⭐ → 🧠 → 🎲 → 🔑(나머지).
    const classify = (e) => (e.constant === true)
        ? 'core'
        : (reportRows.get(`${e.world}.${e.uid}`)?.adopted
            ? 'jev'
            : (lastRandomKeys.has(`${e.world}.${e.uid}`) ? 'random' : 'keyword'));

    const rows = lastActivated.entries.map(e => ({ entry: e, kind: classify(e) }));
    const counts = { core: 0, jev: 0, random: 0, keyword: 0 };
    for (const r of rows) counts[r.kind]++;
    // 토큰은 비동기라 제목줄은 개수부터 띄우고 뒤에서 채운다 (fillStackTokens 선례, v0.6.3)
    $title.text(`${INJECTED_TITLE} — ⭐${counts.core} / 🧠${counts.jev} / 🎲${counts.random} / 🔑${counts.keyword} · 집계 중…`);

    $box.append($('<div class="jev-panel-muted">').text(
        `${new Date(lastActivated.ts).toLocaleTimeString()} 생성 · 총 ${rows.length}개`));

    // 북별 그룹 헤더로 묶는다 (v0.8.0 패턴 재사용) — 4계층이라 여러 북이 섞인다.
    const layerOf = new Map(getTargetWorldsDetailed().map(d => [d.name, d.layer]));
    const headers = ['분류', '제목', '점수', '≈토큰', ''];
    const $table = $('<table class="jev-panel-table">');
    const $thead = $('<tr>');
    for (const h of headers) {
        $thead.append($('<th>').text(h));
    }
    $table.append($('<thead>').append($thead));
    const $tbody = $('<tbody>');

    const groups = new Map();
    for (const r of rows) {
        const key = String(r.entry.world);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }

    const $tokenCells = [];
    const ordered = [];
    for (const [world, groupRows] of groups) {
        const gc = { core: 0, jev: 0, random: 0, keyword: 0 };
        for (const r of groupRows) gc[r.kind]++;
        const $groupCell = $('<td>').attr('colspan', headers.length);
        const layer = layerOf.get(world);
        if (layer) $groupCell.append($('<span class="jev-layer-badge">').text(LAYER_LABELS[layer] ?? layer));
        $groupCell.append($('<span class="jev-group-name">').text(world || '(이름 없음)'));
        $groupCell.append($('<span class="jev-group-meta">').text(`⭐${gc.core} · 🧠${gc.jev} · 🎲${gc.random} · 🔑${gc.keyword}`));
        $tbody.append($('<tr class="jev-panel-group-row">').append($groupCell));

        for (const r of groupRows) {
            const reportRow = reportRows.get(`${r.entry.world}.${r.entry.uid}`);
            // 🧠는 판정 시점 본문이 lastReport에 박제돼 있다(v0.6.4 결정) — 그걸 보여준다.
            // ⭐·🔑는 판정을 안 거쳤으니 WORLD_INFO_ACTIVATED가 준 본문 그대로.
            const content = (r.kind === 'jev' && reportRow)
                ? String(reportRow.text ?? '')
                : String(r.entry.content ?? '');
            const $tr = $('<tr>').toggleClass('jev-adopted', r.kind === 'jev');
            $tr.append($('<td>').append($('<span class="jev-kind-badge">').addClass(`jev-kind-${r.kind}`).text(KIND_BADGE[r.kind])));
            $tr.append($('<td class="jev-cell-title">').text(String(r.entry.comment || `uid ${r.entry.uid}`).slice(0, 48)));
            // 점수는 판정을 거친 🧠만. ⭐·🔑에 숫자를 지어내면 표가 거짓말을 한다.
            $tr.append($('<td>').text((r.kind === 'jev' && reportRow) ? reportRow.final.toFixed(3) : '—'));
            const $tok = $('<td>').text('…');
            $tr.append($tok);

            // 전문 펼침은 기존 패턴 재사용 (buildDetailToggle, v0.6.4)
            const { $cell, $detail } = buildDetailToggle(content, headers.length, { world: r.entry.world, uid: r.entry.uid });
            $tr.append($cell);
            $tbody.append($tr).append($detail);

            $tokenCells.push($tok);
            ordered.push(r);
        }
    }
    $table.append($tbody);
    $box.append($table);

    // Jev 탈락 후보는 기본 접힘 (v0.9.1) — 볼 게 많다는 호소의 주범이라 평소엔 숨긴다.
    const rejected = (lastReport?.rows ?? []).filter(r => !r.adopted);
    if (rejected.length) {
        const best = rejected.reduce((max, r) => Math.max(max, Number(r.final) || 0), 0);
        const $body = $('<div class="jev-reject-body" style="display: none;">');
        const $toggle = $('<div class="jev-detail-toggle jev-reject-toggle" role="button" tabindex="0">')
            .attr('title', '채택되지 못한 판정 후보와 3축 점수를 펼쳐서 봐요')
            .append($('<i class="fa-solid fa-chevron-right">'))
            .append($('<span>').text(`Jev 탈락 후보 ${rejected.length}개 (최고 ${best.toFixed(2)})`));
        const toggleBlock = () => {
            const opening = $body.css('display') === 'none';
            $body.toggle(opening);
            $toggle.toggleClass('jev-open', opening)
                .find('i').toggleClass('fa-chevron-right', !opening).toggleClass('fa-chevron-down', opening);
        };
        $toggle.on('click', toggleBlock);
        $toggle.on('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleBlock(); }
        });
        $box.append($('<div class="jev-reject-block">').append($toggle).append($body));
        renderPanelJudgment($body, rejected);
    }

    void fillInjectedTokens($title, $tokenCells, ordered);
}

/** 주입 표의 토큰을 뒤에서 채운다 — getTokenCountAsync가 비동기라 패널 렌더를 막지 않는다 */
async function fillInjectedTokens($title, $cells, rows) {
    try {
        const counts = { core: 0, jev: 0, random: 0, keyword: 0 };
        const totals = { core: 0, jev: 0, random: 0, keyword: 0 };
        const tokens = await Promise.all(rows.map(r => {
            const text = String(r.entry.content ?? '');
            return text ? getTokenCountAsync(text) : Promise.resolve(0);
        }));
        for (let i = 0; i < rows.length; i++) {
            counts[rows[i].kind]++;
            totals[rows[i].kind] += tokens[i];
            $cells[i].text(tokens[i].toLocaleString());
        }
        const sum = totals.core + totals.jev + totals.random + totals.keyword;
        $title.text(`${INJECTED_TITLE} — `
            + `⭐${counts.core}·${totals.core.toLocaleString()}tok / `
            + `🧠${counts.jev}·${totals.jev.toLocaleString()}tok / `
            + `🎲${counts.random}·${totals.random.toLocaleString()}tok / `
            + `🔑${counts.keyword}·${totals.keyword.toLocaleString()}tok`
            + ` · 합계 ${sum.toLocaleString()}tok`);
    } catch (error) {
        $title.text(`${INJECTED_TITLE} — 토큰 집계에 실패했어요: ${error?.message ?? error}`);
    }
}
/** 패널 전체 갱신 */
async function refreshPanel($panel) {
    renderPanelSummary($panel);
    renderPanelWarnings($panel);
    renderPanelInjected($panel); // 탈락 후보(renderPanelJudgment)는 이 안의 접힘 블록에서 그려진다
    await renderPanelChunks($panel);
}

/** 세부 패널 열기 (요술봉 메뉴 클릭) */
async function openDetailPanel() {
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'panel');
    const $panel = $(html);
    const setConvertStatus = (text) => $panel.find('#jev_panel_convert_status').text(text);

    $panel.find('#jev_panel_convert').on('click', async function () {
        const $button = $(this);
        if ($button.hasClass('disabled')) return;
        $button.addClass('disabled');
        try {
            await convertChatToLorebook(setConvertStatus);
            renderPanelSummary($panel);
            renderPanelWarnings($panel);
            await renderPanelChunks($panel);
        } finally {
            $button.removeClass('disabled');
        }
    });

    $panel.find('#jev_panel_undo').on('click', async function () {
        const $button = $(this);
        if ($button.hasClass('disabled')) return;
        const snap = SillyTavern.getContext().chatMetadata?.[UNDO_META_KEY];
        if (!snap) {
            toastr.warning('되돌릴 변환 기록이 없어요.', 'Jev Lorebook');
            renderPanelSummary($panel);
            return;
        }
        const $confirm = $('<div>').append(
            $('<p>').text('직전 변환을 되돌릴까요?'),
            $('<ul>').append(
                $('<li>').text(`추가된 항목 ${Number(snap.incidentCount) || 0}건 삭제`),
                $('<li>').text('코어 규칙·일기를 변환 전 상태로 복원'),
                $('<li>').text('변환 지점·작중 앵커 되돌림 (그 구간을 다시 변환할 수 있게 돼요)'),
                $('<li>').text('숨긴 원본 메시지 복구'),
                $('<li>').text('로어북 재색인 (임베딩 호출이 발생해요)'),
            ),
        );
        const result = await callGenericPopup($confirm, POPUP_TYPE.CONFIRM, '', {
            okButton: '되돌리기',
            cancelButton: '취소',
        });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        $button.addClass('disabled');
        try {
            const r = await undoLastConversion(setConvertStatus);
            setConvertStatus(`되돌리기 완료: 항목 ${r.removed}개 삭제 · ${r.rulesNote} · ${r.diaryNote} · 메시지 ${r.unhidden}개 복구 · ${r.indexed}개 재색인`);
            toastr.success(`되돌렸어요 — 항목 ${r.removed}개 삭제, 메시지 ${r.unhidden}개 복구`, 'Jev Lorebook');
        } catch (error) {
            setConvertStatus(`되돌리기 실패: ${error?.message ?? error}`);
            toastr.error(`되돌리기 실패: ${error?.message ?? error}`, 'Jev Lorebook');
        } finally {
            $button.removeClass('disabled');
            renderPanelSummary($panel);
            renderPanelWarnings($panel);
            await renderPanelChunks($panel);
        }
    });

    $panel.find('#jev_panel_reindex').on('click', async function () {
        const $button = $(this);
        if ($button.hasClass('disabled')) return;
        const worlds = getTargetWorlds();
        if (!worlds.length) {
            toastr.warning('색인 대상이 없다.', 'Jev Lorebook');
            return;
        }
        $button.addClass('disabled');
        try {
            let total = 0;
            for (const world of worlds) {
                total += await indexWorld(world, setConvertStatus);
            }
            setConvertStatus(`재색인 완료: ${worlds.length}개 로어북 / ${total}개 항목`);
            await renderPanelChunks($panel);
        } catch (error) {
            setConvertStatus(`재색인 실패: ${error?.message ?? error}`);
            toastr.error(`재색인 실패: ${error?.message ?? error}`, 'Jev Lorebook');
        } finally {
            $button.removeClass('disabled');
        }
    });

    $panel.find('#jev_panel_split').on('click', async function () {
        const $button = $(this);
        if ($button.hasClass('disabled')) return;
        $button.addClass('disabled');
        try {
            await openSplitDialog(setConvertStatus, $panel);
        } finally {
            $button.removeClass('disabled');
        }
    });

    $panel.find('#jev_panel_open_editor').on('click', function () {
        const world = getConversionTargetWorld();
        if (!world) {
            toastr.warning('열 로어북이 없어요. 이 채팅/캐릭터에 로어북을 연결해 주세요.', 'Jev Lorebook');
            return;
        }
        openWorldEditor(world);
    });

    $panel.find('#jev_panel_refresh').on('click', () => refreshPanel($panel));

    // 남겨둘 최근 챗 수 (v0.15.0) — 설정탭 #jev_lorebook_keep_recent와 **같은 값**이다(창구가 둘).
    // 1회용 값이 아니라 settings.keepRecent를 직접 쓰고, 바꾸면 막대·판정문을 다시 그려 미리보기가 된다.
    const $keepRecent = $panel.find('#jev_panel_keep_recent').val(getKeepRecent());
    let keepRecentTimer = null;
    $keepRecent.on('input', function () {
        const raw = String($(this).val()).trim();
        const value = Number(raw);
        // 빈 값·비숫자·음수는 무시하고 직전 값을 유지한다 — 지우고 다시 치는 중일 수 있다
        if (!raw || !Number.isFinite(value) || value < 0) return;
        const settings = getSettings();
        settings.keepRecent = Math.floor(value);
        saveSettingsDebounced();
        $('#jev_lorebook_keep_recent').val(settings.keepRecent); // 팝업 B(로어북 만들기 설정)가 열려 있을 수 있다
        clearTimeout(keepRecentTimer);
        keepRecentTimer = setTimeout(() => renderPanelSummary($panel), 250); // 연타 시 렌더가 겹치지 않게
    });

    refreshPanel($panel); // 비동기 — 팝업은 즉시 뜨고 색인 대조가 따라 채워진다
    await callGenericPopup($panel, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        okButton: '닫기',
    });
}

// ── 설정 UI ─────────────────────────────────────────────────────────────

/** 임베딩 소스 셀렉트 채우기 */
function populateEmbeddingSourceSelect() {
    const settings = getSettings();
    const $select = $('#jev_lorebook_embed_source');
    $select.empty();
    for (const [value, meta] of Object.entries(EMBEDDING_SOURCES)) {
        $select.append($('<option>').val(value).text(meta.label));
    }
    $select.val(EMBEDDING_SOURCES[settings.embeddingSource] ? settings.embeddingSource : 'palm');
}

/**
 * ST의 'API 연결' 서랍을 연다 (v0.7.0).
 * 내비 서랍 토글은 $('.drawer-toggle').on('click', doNavbarIconClick) (script.js:12088)에 걸려 있고,
 * 아이콘(#API-status-top)은 그 .drawer-toggle의 자식이라 클릭이 버블링된다.
 * openWorldEditor의 #WIDrawerIcon 수법과 같은 경로 — 새 API를 쓰지 않는다.
 * 닫힌 상태(closedDrawer, index.html:2277)일 때만 누른다 — 열린 걸 다시 누르면 닫혀 버린다.
 */
function openApiConnectionsDrawer() {
    if ($('#rm_api_block').hasClass('closedDrawer')) {
        $('#API-status-top').trigger('click');
    }
}

/**
 * 키 등록 경로 안내문 조립 (v0.7.0).
 * 소스마다 키를 넣는 화면이 다르다 — ST 소스 실측:
 *   chat    : chat_completion_source 드롭다운에 있는 소스 (index.html:2900~)
 *   text    : togetherai만 Text Completion 쪽 (index.html:2435)
 *   vectors : nomicai는 API 연결 화면에 칸 자체가 없고 Vector Storage 설정에서 관리 (vectors/settings.html:181)
 * 소스 이름은 label이 아니라 stSource를 쓴다 — label엔 '(모델 고정: …)' 같은 우리 주석이 붙어 있어
 * 그대로 안내하면 ST 드롭다운에서 그 항목을 못 찾는다.
 */
function buildKeyGuide(meta) {
    const lines = ['이 키는 확장이 따로 받지 않고 SillyTavern에 저장된 키를 그대로 써요.'];
    if (meta.keyRoute === 'vectors') {
        lines.push(`등록: 확장 메뉴 → Vector Storage 설정에서 소스를 '${meta.stSource}'로 고르면 나오는 API 키 칸에 넣어 주세요.`);
        return { lines, punch: '', showButton: false };
    }
    const apiType = meta.keyRoute === 'text' ? 'Text Completion' : 'Chat Completion';
    lines.push(`등록: 상단 🔌 API 연결 → API를 '${apiType}'으로 → 소스를 '${meta.stSource}'로 고른 뒤, API 키를 붙여넣고 [Connect]를 누르면 저장돼요.`);
    // 진짜 함정은 이 줄이다: Claude로 RP하는 사람은 이 소스를 열 이유가 없어서 입력칸 자체를 못 본다 (현이 실사용 제보, 2026-09-20)
    return { lines, punch: '저장되면 채팅 연결은 원래 쓰던 소스로 되돌려도 키는 그대로 남아요.', showButton: true };
}

/** 선택 소스의 키 상태·모델 입력칸 상태 갱신 */
function updateEmbeddingSourceUi() {
    const settings = getSettings();
    const meta = EMBEDDING_SOURCES[settings.embeddingSource] ?? EMBEDDING_SOURCES.palm;
    const isPalm = settings.embeddingSource === 'palm';
    const dedicated = isPalm && settings.embeddingKeyMode === 'dedicated';
    const $status = $('#jev_lorebook_key_status');
    const $help = $('#jev_lorebook_key_help');

    // 전용 키 모드 UI는 palm에서만 노출 — 다른 소스는 reverse_proxy 배선을 안 탄다
    $('#jev_lorebook_embed_key_mode_row').toggle(isPalm);
    if (isPalm) {
        $('#jev_lorebook_embed_key_mode_shared').prop('checked', settings.embeddingKeyMode !== 'dedicated');
        $('#jev_lorebook_embed_key_mode_dedicated').prop('checked', settings.embeddingKeyMode === 'dedicated');
    }
    $('#jev_lorebook_embed_dedicated_key_row').toggle(dedicated);
    if (dedicated) {
        $('#jev_lorebook_embed_dedicated_key').val(settings.embeddingDedicatedKey || '');
    }
    // 이전에 전용 키를 고른 상태로 소스를 바꿔서 설정은 'dedicated'로 남아있는데 palm이 아니면 안내를 보여준다
    $('#jev_lorebook_embed_key_mode_unsupported').toggle(!isPalm && settings.embeddingKeyMode === 'dedicated');

    // 키 입력칸을 우리가 안 가지고 있다는 걸 명시해야 한다 — 설정탭에 칸이 없으니 최초 설치자는 어디에 넣는지 몰라 막힌다.
    if (dedicated) {
        // 전용 키 모드에서는 ST 금고가 아니라 이 확장 설정을 본다 (hasEmbeddingKey는 금고 전용이라 여기선 안 쓴다)
        if (String(settings.embeddingDedicatedKey || '').trim()) {
            $status.text('전용 키 사용 중 ✓').removeClass('jev-key-missing');
        } else {
            $status.text('전용 키 미입력 ✗').addClass('jev-key-missing');
        }
        $help.hide().empty();
    } else if (meta.secretKey === null) {
        $status.text('로컬 소스라 API 키가 필요 없어요.').removeClass('jev-key-missing');
        $help.hide().empty(); // 키가 필요 없는 소스엔 안내 자체가 소음이다
    } else if (hasEmbeddingKey(meta)) {
        $status.text(isPalm ? 'ST 저장 키 사용 중 ✓' : '키 등록됨 ✓').removeClass('jev-key-missing');
        $help.hide().empty(); // 끝난 사람한테 잔소리하지 않는다
    } else {
        $status.text('키 미등록 ✗').addClass('jev-key-missing');
        const guide = buildKeyGuide(meta);
        $help.empty();
        for (const line of guide.lines) {
            $help.append($('<div>').text(line));
        }
        if (guide.punch) {
            $help.append($('<div>').addClass('jev-key-help-punch').text(guide.punch));
        }
        if (guide.showButton) {
            $help.append($('<div id="jev_lorebook_open_api" class="menu_button menu_button_icon">')
                .attr('title', 'SillyTavern의 API 연결 서랍을 열어요')
                .append($('<i class="fa-solid fa-plug">'))
                .append($('<span>').text('API 연결 열기'))
                .on('click', openApiConnectionsDrawer));
        }
        $help.show();
    }
    const $model = $('#jev_lorebook_embed_model');
    $model.prop('disabled', !meta.modelFromRequest);
    $model.attr('placeholder', meta.modelFromRequest ? `비우면 기본값: ${meta.defaultModel}` : '이 소스는 모델이 서버에서 고정돼요');
    $('#jev_lorebook_reindex_warning').toggle(!!settings.embeddingDirty);
}

/** 변환 프로필 셀렉트 채우기 — connection-manager 비활성이면 행 숨김(현재 연결된 메인 API로 동작) */
function populateConvertProfiles($root = $(document)) {
    const settings = getSettings();
    const $row = $root.find('#jev_lorebook_profile_row');
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles(); // shared.js:525
        const $select = $root.find('#jev_lorebook_convert_profile');
        $select.empty().append($('<option>').val('').text('— 현재 연결된 메인 API —'));
        for (const p of profiles) {
            $select.append($('<option>').val(p.id).text(p.name || p.id));
        }
        $select.val(settings.convertProfileId || '');
        $row.show();
    } catch (error) {
        console.log(`${LOG} connection-manager 비활성 — 변환 프로필 선택 숨김 (현재 연결된 메인 API로 동작): ${error?.message ?? error}`);
        $row.hide();
    }
}

/**
 * topK 슬라이더 옆 '전체 N개' 채우기 (v0.7.0).
 * "30이 많은 건가 적은 건가"는 로어북 크기를 같이 봐야 판단된다.
 * 로어북 로드가 있어 비동기 — 렌더를 막지 않는다 (fillStackTokens과 같은 패턴).
 */
async function fillTopKTotal($root = $(document)) {
    const $total = $root.find('#jev_lorebook_topk_total');
    if (!$total.length) return;
    const worlds = getTargetWorlds();
    if (!worlds.length) {
        $total.text(' / 대상 로어북 없음');
        return;
    }
    try {
        let total = 0;
        for (const world of worlds) {
            const worldData = await loadWorldInfo(world);
            total += Object.values(worldData?.entries ?? {})
                .filter(e => !e.disable && String(e.content ?? '').trim()).length;
        }
        $total.text(` / 전체 ${total}개`);
    } catch (error) {
        console.log(`${LOG} topK 전체 항목 수 집계 실패(표시만 생략): ${error?.message ?? error}`);
        $total.text('');
    }
}

/**
 * 감지 목록 — 지금 감지된 북 목록 (v0.8.0 · v0.17.0에서 팝업 A로 이전 + 행 강화).
 *
 * 행마다 동기로 먼저 그리는 것: 층 배지 · 북 이름 · [설정 있음] 배지 · [톱니] 버튼.
 * 비동기로 뒤에 채우는 것: 항목수 · 색인 ✓/✗ N/M · 랜덤 후보 N개 · 쿨다운 N.
 * 톱니를 async 뒤로 미루면 로어북 읽기가 느린 환경에서 버튼이 한참 안 뜬다 — 먼저 그린다.
 * 로어북 로드·색인 대조가 있어 비동기 — 렌더를 막지 않는다(fillStackTokens과 같은 패턴).
 *
 * @param {*} [$root] 검색 기준. 팝업을 열 때는 아직 DOM에 안 붙은 $popup을 넘긴다.
 */
let layerListRun = 0;
async function renderLayerList($root = $(document)) {
    const run = ++layerListRun;
    const $box = $root.find('#jev_lorebook_layer_list');
    if (!$box.length) return;
    const detailed = getTargetWorldsDetailed();
    $box.empty();
    if (!detailed.length) {
        $box.append($('<div class="jev-layer-summary">').text('지금 감지된 로어북이 없어요.'));
        return;
    }
    const $summary = $('<div class="jev-layer-summary">').text(`북 ${detailed.length}개 · 총 …항목`);
    $box.append($summary);

    let totalEntries = 0;
    for (const { name, layer } of detailed) {
        const $row = $('<div class="jev-layer-row">');
        $row.append($('<span class="jev-layer-badge">').text(LAYER_LABELS[layer] ?? layer));
        $row.append($('<span class="jev-layer-name">').text(name));
        if (hasWorldOverride(name)) {
            $row.append($('<span class="jev-layer-badge jev-override-badge">').text('설정 있음'));
        }
        const openWorld = () => void openWorldSettingsPopup(name);
        $row.append($('<span class="jev-layer-gear" role="button" tabindex="0">')
            .attr('title', '이 로어북만의 주입 예산·랜덤·회수 후보 수를 정해요')
            .append($('<i class="fa-solid fa-gear">'))
            .on('click', openWorld)
            .on('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openWorld(); }
            }));
        const $meta = $('<span class="jev-layer-meta">').text('확인 중…');
        $row.append($meta);
        $box.append($row);

        try {
            const worldData = await loadWorldInfo(name);
            if (run !== layerListRun) return; // 그 사이 다시 렌더됨 — 옛 결과를 덮어쓰지 않는다
            const live = Object.values(worldData?.entries ?? {})
                .filter(e => !e.disable && String(e.content ?? '').trim());
            totalEntries += live.length;
            // 코어(constant)는 ST가 매 턴 네이티브 주입 = 색인 대상도, 랜덤 후보도 아니다 → 두 숫자의 모집단이 같다
            const indexTargets = live.filter(e => !e.constant);
            let indexText = '색인 확인 실패';
            try {
                const hashes = await vectorList(name);
                if (run !== layerListRun) return;
                const done = indexTargets.filter(e => hashes.has(Number(getStringHash(String(e.content ?? ''))))).length;
                indexText = indexTargets.length
                    ? `색인 ${done >= indexTargets.length ? '✓' : '✗'} ${done}/${indexTargets.length}`
                    : '색인 대상 없음';
            } catch (error) {
                indexText = `색인 확인 실패 (${error?.message ?? error})`;
            }
            // 랜덤이 꺼진 북에 후보·쿨다운 숫자를 띄우면 "뽑히는 중"으로 읽힌다 → 꺼짐을 먼저 말한다
            const randomText = isRandomEnabled(name)
                ? `랜덤 후보 ${indexTargets.length}개 · 쿨다운 ${randomCooldownSize(indexTargets.length)}`
                : '랜덤 꺼짐';
            $meta.text(`${live.length}항목 · ${indexText} · ${randomText}`);
        } catch (error) {
            $meta.text(`읽기 실패: ${error?.message ?? error}`);
        }
        if (run !== layerListRun) return;
        $summary.text(`북 ${detailed.length}개 · 총 ${totalEntries}항목`);
    }
}

function populateWorldSelect($root = $(document)) {
    const settings = getSettings();
    const $select = $root.find('#jev_lorebook_world');
    $select.empty().append('<option value="">— 자동: 위에서 켠 층의 로어북 —</option>');
    for (const name of (world_names ?? [])) {
        $select.append($('<option>').val(name).text(name));
    }
    $select.val(settings.world);
}

/**
 * 확장 탭 감지 요약 한 줄 (v0.17.0) — `북 3개 · 총 87항목 · 색인 ✓`.
 * 북별 상세 행은 팝업 A로 내렸으니, 탭에는 "지금 몇 개가 잡혀 있고 색인이 됐나"만 남긴다.
 * 로어북 로드·색인 대조가 있어 비동기 — 렌더를 막지 않는다.
 */
let detectSummaryRun = 0;
async function renderDetectionSummary() {
    const run = ++detectSummaryRun;
    const $line = $('#jev_lorebook_detect_summary');
    if (!$line.length) return;
    const detailed = getTargetWorldsDetailed();
    if (!detailed.length) {
        $line.text('감지된 로어북이 없어요 — 채팅·캐릭터·전역·페르소나 중 한 곳에 연결하거나 아래에서 고정 대상을 골라 주세요.');
        return;
    }
    $line.text(`북 ${detailed.length}개 · 확인 중…`);

    let totalEntries = 0;
    let indexTargets = 0;
    let indexedCount = 0;
    let failed = 0;
    for (const { name } of detailed) {
        try {
            const worldData = await loadWorldInfo(name);
            if (run !== detectSummaryRun) return;
            const live = Object.values(worldData?.entries ?? {})
                .filter(e => !e.disable && String(e.content ?? '').trim());
            totalEntries += live.length;
            const targets = live.filter(e => !e.constant);
            indexTargets += targets.length;
            const hashes = await vectorList(name);
            if (run !== detectSummaryRun) return;
            indexedCount += targets.filter(e => hashes.has(Number(getStringHash(String(e.content ?? ''))))).length;
        } catch {
            failed++; // 사유는 팝업 A의 북별 행이 그대로 보여준다 — 한 줄 요약에서는 개수만 센다
        }
    }
    if (run !== detectSummaryRun) return;
    const indexText = failed
        ? `색인 확인 실패 ${failed}개`
        : (indexTargets === 0
            ? '색인 대상 없음'
            : (indexedCount >= indexTargets ? '색인 ✓' : `색인 ✗ ${indexedCount}/${indexTargets}`));
    $line.text(`북 ${detailed.length}개 · 총 ${totalEntries}항목 · ${indexText}`);
}

/**
 * 주입 예산 합계 한 줄 (v0.17.0, 팝업 A — 요구 G).
 * 형태: `이 채팅 · 코어 1,470 + 검색 10,000 + 랜덤 500 = 매 턴 ≈11,970`
 *
 * - 코어는 예산이 아니라 **실제 항목 토큰의 합**이라 getTokenCountAsync가 필요하다 → 렌더를 막지 않고 뒤에서 채운다
 *   (v0.6.3 fillStackTokens 선례).
 * - ⚠ 꺼진 코어는 합계에서 뺀다. 매 턴 주입되지 않는 걸 더하면 이 줄이 거짓말한다.
 * - 검색·랜덤은 **북별 유효값의 합**이다(오버라이드 반영) — 인터셉터의 북별 예산 컷과 같은 계산이어야 한다.
 *
 * @param {*} [$root] 검색 기준. 팝업을 열 때는 아직 DOM에 안 붙은 $popup을 넘긴다.
 */
let budgetTotalRun = 0;
async function renderBudgetTotal($root = $(document)) {
    const run = ++budgetTotalRun;
    const $line = $root.find('#jev_lorebook_budget_total');
    if (!$line.length) return;
    const worlds = getTargetWorlds();
    if (!worlds.length) {
        $line.text('감지된 로어북이 없어서 합계를 낼 수 없어요.');
        return;
    }
    const searchBudget = worlds.reduce((sum, w) => sum + getBudgetTokens(w), 0);
    const randomBudget = worlds.reduce((sum, w) => sum + (isRandomEnabled(w) ? getRandomBudget(w) : 0), 0);
    const tail = `검색 ${searchBudget.toLocaleString()} + 랜덤 ${randomBudget.toLocaleString()}`;
    $line.text(`이 채팅 · 코어 집계 중… + ${tail}`);

    try {
        let coreTokens = 0;
        for (const world of worlds) {
            const worldData = await loadWorldInfo(world);
            for (const entry of Object.values(worldData?.entries ?? {})) {
                if (!entry?.constant || entry.disable) continue; // 꺼진 코어는 주입되지 않는다
                const text = String(entry.content ?? '');
                if (!text.trim()) continue;
                coreTokens += await getTokenCountAsync(text);
            }
        }
        if (run !== budgetTotalRun) return;
        const total = coreTokens + searchBudget + randomBudget;
        $line.text(`이 채팅 · 코어 ${coreTokens.toLocaleString()} + ${tail} = 매 턴 ≈${total.toLocaleString()}`);
    } catch (error) {
        if (run !== budgetTotalRun) return;
        $line.text(`이 채팅 · ${tail} · 코어 집계에 실패했어요: ${error?.message ?? error}`);
    }
}

/**
 * 로어북 하나짜리 설정 팝업 (v0.17.0 — 요구 H).
 *
 * 네 칸 모두 '비우면 전역값 상속'이다. 랜덤 켜기만 select인 이유: 체크박스로는 '미설정'을 표현할 수 없다
 * — 그 북만 끄는 것(false)과 전역을 따르는 것(미설정)은 다른 상태다.
 * 저장은 입력 즉시(saveSettingsDebounced). 값이 비면 키를 지우고, 레코드가 비면 레코드째 지운다
 * — 빈 레코드를 남기면 '설정 있음' 배지가 거짓말한다.
 */
async function openWorldSettingsPopup(world) {
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'popup-world');
    const $popup = $(html);
    const store = getPerWorldStore();
    const rec = () => {
        const r = store[world];
        return (r && typeof r === 'object' && !Array.isArray(r)) ? r : null;
    };

    $popup.find('#jev_world_title').text(world);

    const showEffective = () => {
        $popup.find('#jev_world_effective').text(
            `지금 적용되는 값 — 주입 예산 ${getBudgetTokens(world).toLocaleString()}`
            + ` · 랜덤 ${isRandomEnabled(world) ? '켜짐' : '꺼짐'}`
            + ` · 랜덤 예산 ${getRandomBudget(world).toLocaleString()}`
            + ` · 회수 후보 ${getQueryTopK(world)}`);
    };

    const setKey = (key, value) => {
        let r = rec();
        if (!r) { r = {}; store[world] = r; }
        if (value === undefined) delete r[key];
        else r[key] = value;
        if (!Object.keys(r).length) delete store[world];
        saveSettingsDebounced();
        showEffective();
        void renderLayerList();
        void renderBudgetTotal();
    };

    // 숫자 3칸 — placeholder에 현재 전역값을 찍는다. "이 칸을 안 건드리면 무슨 값이 되는지"가 화면에 있어야 한다.
    const numberFields = [
        { id: '#jev_world_budget', key: 'budgetTokens', min: BUDGET_TOKENS_MIN, max: BUDGET_TOKENS_MAX, fallback: getBudgetTokens() },
        { id: '#jev_world_random_budget', key: 'randomBudgetTokens', min: RANDOM_BUDGET_MIN, max: RANDOM_BUDGET_MAX, fallback: getRandomBudget() },
        { id: '#jev_world_topk', key: 'queryTopK', min: TOP_K_MIN, max: TOP_K_MAX, fallback: getQueryTopK() },
    ];
    for (const field of numberFields) {
        const current = resolveOverride(rec()?.[field.key]);
        $popup.find(field.id)
            .attr('placeholder', `전역값 ${field.fallback.toLocaleString()}`)
            .val(current !== undefined ? String(current) : '')
            .on('input', function () {
                const raw = String($(this).val()).trim();
                if (!raw) { setKey(field.key, undefined); return; } // 비우면 상속으로 되돌린다
                setKey(field.key, clampSetting(raw, field.min, field.max, field.fallback));
            });
    }

    const randomOverride = resolveOverride(rec()?.randomEnabled);
    $popup.find('#jev_world_random_enabled')
        .val(randomOverride === undefined ? '' : (randomOverride === true ? 'on' : 'off'))
        .on('change', function () {
            const value = String($(this).val());
            setKey('randomEnabled', value === '' ? undefined : value === 'on');
        });

    $popup.find('#jev_world_reset').on('click', function () {
        delete store[world];
        saveSettingsDebounced();
        for (const field of numberFields) $popup.find(field.id).val('');
        $popup.find('#jev_world_random_enabled').val('');
        showEffective();
        void renderLayerList();
        void renderBudgetTotal();
        toastr.info(`'${world}'의 설정을 지웠어요 — 이제 전역값을 따라요.`, 'Jev Lorebook');
    });

    showEffective();
    await callGenericPopup($popup, POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        okButton: '닫기',
    });
}

/**
 * 팝업 A 「주입 세부 설정」 (v0.17.0 — 요구 F).
 *
 * ⚠ 팝업이 닫히면 DOM이 통째로 사라진다 → 값 주입·이벤트 바인딩·목록 렌더를 **열 때마다** 다시 한다.
 *   로드 1회 바인딩으로 두면 두 번째로 열 때 컨트롤이 전부 죽는다.
 * ⚠ 렌더 함수에는 아직 DOM에 안 붙은 $popup을 $root로 넘긴다 — 전역 셀렉터는 이 시점에 아무것도 못 찾는다.
 * 저장은 입력 즉시(saveSettingsDebounced) — 닫을 때 일괄 저장으로 바꾸지 않는다.
 */
async function openInjectionSettingsPopup() {
    const settings = getSettings();
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'popup-injection');
    const $popup = $(html);

    $popup.find('#jev_lorebook_budget').val(settings.budgetTokens).on('input', function () {
        settings.budgetTokens = clampSetting($(this).val(), BUDGET_TOKENS_MIN, BUDGET_TOKENS_MAX, defaultSettings.budgetTokens);
        saveSettingsDebounced();
        void renderBudgetTotal($popup);
    });

    $popup.find('#jev_lorebook_random_enabled').prop('checked', settings.randomEnabled === true).on('change', function () {
        settings.randomEnabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        void renderLayerList($popup);   // 행의 '랜덤 후보/쿨다운'이 켜짐 여부에 따라 바뀐다
        void renderBudgetTotal($popup);
    });

    $popup.find('#jev_lorebook_random_budget').val(getRandomBudget()).on('input', function () {
        settings.randomBudgetTokens = clampSetting($(this).val(), RANDOM_BUDGET_MIN, RANDOM_BUDGET_MAX, DEFAULT_RANDOM_BUDGET);
        saveSettingsDebounced();
        void renderBudgetTotal($popup);
    });

    // topK 슬라이더 — 옆 숫자는 input에서 즉시 따라간다(놓을 때까지 모르면 조절을 못 한다)
    $popup.find('#jev_lorebook_topk').val(getQueryTopK()).on('input', function () {
        const value = clampSetting($(this).val(), TOP_K_MIN, TOP_K_MAX, DEFAULT_TOP_K);
        settings.queryTopK = value;
        $popup.find('#jev_lorebook_topk_value').text(String(value));
        saveSettingsDebounced();
    });
    $popup.find('#jev_lorebook_topk_value').text(String(getQueryTopK()));

    // 감지 대상 층 on/off (v0.8.0) — 끄면 그 층의 북이 감지 목록에서 빠진다
    for (const [key, selector] of Object.entries(LAYER_INPUTS)) {
        $popup.find(selector).prop('checked', settings[key] !== false).on('change', function () {
            settings[key] = !!$(this).prop('checked');
            saveSettingsDebounced();
            void renderLayerList($popup);
            void fillTopKTotal($popup);
            void renderBudgetTotal($popup);
            void renderDetectionSummary(); // 확장 탭 한 줄도 같이 따라가야 한다
        });
    }

    $popup.find('#jev_lorebook_world').on('change', function () {
        settings.world = String($(this).val());
        saveSettingsDebounced();
        void renderLayerList($popup);
        void fillTopKTotal($popup);
        void renderBudgetTotal($popup);
        void renderDetectionSummary();
    });

    populateWorldSelect($popup);
    void fillTopKTotal($popup);
    void renderLayerList($popup);
    void renderBudgetTotal($popup);

    await callGenericPopup($popup, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        okButton: '닫기',
    });
}

/**
 * 팝업 B 「로어북 만들기 설정」 (v0.17.0 — 요구 F).
 * 팝업 A와 같은 규칙: 열 때마다 바인딩·렌더, 저장은 입력 즉시.
 */
async function openConvertSettingsPopup() {
    const settings = getSettings();
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'popup-convert');
    const $popup = $(html);

    // 변환 프로필 (v0.5) — 열 때마다 최신 목록으로 갱신. focus에서도 다시 채운다(그새 프로필이 추가될 수 있다)
    populateConvertProfiles($popup);
    $popup.find('#jev_lorebook_convert_profile')
        .on('focus', function () { populateConvertProfiles($popup); })
        .on('change', function () {
            settings.convertProfileId = String($(this).val());
            saveSettingsDebounced();
        });

    $popup.find('#jev_lorebook_slice_tokens').val(getSliceTokens()).on('input', function () {
        settings.sliceTokens = clampSetting($(this).val(), SLICE_TOKENS_MIN, SLICE_TOKENS_MAX, DEFAULT_SLICE_TOKENS);
        saveSettingsDebounced();
    });

    $popup.find('#jev_lorebook_convert_max_tokens').val(getConvertMaxTokens()).on('input', function () {
        settings.convertMaxTokens = clampSetting($(this).val(), CONVERT_MAX_TOKENS_MIN, CONVERT_MAX_TOKENS_MAX, DEFAULT_CONVERT_MAX_TOKENS);
        saveSettingsDebounced();
    });

    $popup.find('#jev_lorebook_incident_max_tokens').val(getIncidentMaxTokens()).on('input', function () {
        settings.incidentMaxTokens = clampSetting($(this).val(), INCIDENT_TOKENS_MIN, INCIDENT_TOKENS_MAX, DEFAULT_INCIDENT_MAX_TOKENS);
        saveSettingsDebounced();
    });

    // 스타일 지시문 — 빈 값이 곧 기본값이라 placeholder에도 같은 글을 넣는다
    $popup.find('#jev_lorebook_convert_style')
        .attr('placeholder', DEFAULT_CONVERT_STYLE)
        .val(String(settings.convertStyle || ''))
        .on('input', function () {
            settings.convertStyle = String($(this).val());
            saveSettingsDebounced();
        });
    $popup.find('#jev_lorebook_style_reset').on('click', function () {
        settings.convertStyle = '';
        $popup.find('#jev_lorebook_convert_style').val('');
        saveSettingsDebounced();
        toastr.info('변환 스타일 지시문을 기본값으로 되돌렸어요.', 'Jev Lorebook');
    });

    // 최근 메시지 보존 — 요술봉 패널의 #jev_panel_keep_recent와 **같은 값**이다(창구가 둘)
    $popup.find('#jev_lorebook_keep_recent').val(getKeepRecent()).on('input', function () {
        const value = Number($(this).val());
        settings.keepRecent = Number.isFinite(value) && value >= 0 ? Math.floor(value) : defaultSettings.keepRecent;
        saveSettingsDebounced();
    });

    await callGenericPopup($popup, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        okButton: '닫기',
    });
}

jQuery(async () => {
    const settings = getSettings();

    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    $('#extensions_settings2').append(html);

    $('#jev_lorebook_enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#jev_lorebook_api_key').val(settings.jevApiKey).on('input', function () {
        settings.jevApiKey = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    // ── 확장 탭에 남는 것 (v0.17.0) ──────────────────────────────────
    // 켜기 / Jev 키 / 임베딩(소스·키 상태·전용키 모드·모델·재색인 경고) / [색인] / 상태줄 / 감지 요약 / 팝업 버튼 2개.
    // 나머지 입력칸은 팝업 A(주입 세부)·B(로어북 만들기)로 내렸다 — 탭에 20칸 넘게 늘어놓으면 쓸 수 없다는 게 발주 사유다.

    $('#jev_lorebook_index').on('click', indexLorebook);

    // 임베딩 소스/모델 (v0.5) — 변경 시 기존 색인과 벡터 차원이 어긋나므로 재색인 경고
    populateEmbeddingSourceSelect();
    updateEmbeddingSourceUi();
    // v0.9.2 — ST가 키를 저장·삭제·교체하면 즉시 다시 그린다.
    // 이게 없으면 API 연결에서 키를 제대로 등록해도 새로고침 전까지 '키 미등록 ✗'이 그대로 박혀 있다
    // — 사용자 제보로 확인된 오진 경로. writeSecret()이 SECRET_WRITTEN을 쏜다(secrets.js:375).
    for (const evt of [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED]) {
        if (evt) eventSource.on(evt, () => updateEmbeddingSourceUi());
    }
    $('#jev_lorebook_embed_source').on('change', function () {
        settings.embeddingSource = String($(this).val());
        settings.embeddingModel = ''; // 소스가 바뀌면 모델은 새 소스 기본값으로
        settings.embeddingDirty = true;
        $('#jev_lorebook_embed_model').val('');
        saveSettingsDebounced();
        updateEmbeddingSourceUi();
    });
    $('#jev_lorebook_embed_model').val(settings.embeddingModel).on('input', function () {
        settings.embeddingModel = String($(this).val()).trim();
        settings.embeddingDirty = true;
        saveSettingsDebounced();
        $('#jev_lorebook_reindex_warning').show();
    });
    // 임베딩 전용 키 모드 (palm 전용, v0.14.0)
    $('input[name="jev_lorebook_embed_key_mode"]').on('change', function () {
        settings.embeddingKeyMode = String($(this).val());
        settings.embeddingDirty = true;
        saveSettingsDebounced();
        updateEmbeddingSourceUi();
    });
    $('#jev_lorebook_embed_dedicated_key').val(settings.embeddingDedicatedKey).on('input', function () {
        settings.embeddingDedicatedKey = String($(this).val()).trim();
        settings.embeddingDirty = true;
        saveSettingsDebounced();
        updateEmbeddingSourceUi();
    });

    // 세부 설정 팝업 2개 (v0.17.0) — 값 주입·바인딩·목록 렌더는 '열 때마다' 팝업 함수 안에서 다시 한다.
    // 팝업이 닫히면 DOM이 통째로 사라지므로 로드 1회 바인딩으로 두면 두 번째로 열 때 컨트롤이 전부 죽는다.
    $('#jev_lorebook_open_injection').on('click', () => void openInjectionSettingsPopup());
    $('#jev_lorebook_open_convert').on('click', () => void openConvertSettingsPopup());

    void renderDetectionSummary();

    // 본문 날짜 헤더 자동 마이그레이션 (v0.12.0) — 채팅이 바뀔 때마다 대상 로어북을 보고 아직 안 한 것만 처리.
    // 확장 로드 시점엔 이미 채팅이 열려 있을 수 있어 CHAT_CHANGED가 안 온다 → 여기서 1회 직접 돌린다.
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            void runHeaderMigration();
            resetRandomCooldown(); // 🎲 채팅이 바뀌면 쿨다운 링버퍼를 비운다 (v0.15.0)
            void renderDetectionSummary(); // 감지 대상은 채팅에 딸려 바뀐다 — 한 줄 요약도 따라가야 한다 (v0.17.0)
        });
    } else {
        console.warn(`${LOG} event_types.CHAT_CHANGED가 없다 — 헤더 마이그레이션은 로드 시 1회만 돌아간다`);
    }
    void runHeaderMigration();

    if (event_types.WORLDINFO_UPDATED) {
        eventSource.on(event_types.WORLDINFO_UPDATED, () => {
            populateWorldSelect();
            void renderLayerList();
            void renderDetectionSummary();
        });
    }

    // 이번 턴 실제 주입 관측 (v0.9.0) — world-info.js:902 emit, isDryRun 턴에는 안 온다.
    // 인자는 활성화된 전체 엔트리 배열. 최신 1턴만 스냅샷으로 들고 있는다(패널 표시 전용).
    if (event_types.WORLD_INFO_ACTIVATED) {
        eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
            lastActivated = {
                ts: Date.now(),
                entries: (Array.isArray(entries) ? entries : []).map(e => ({
                    world: String(e?.world ?? ""),
                    uid: e?.uid,
                    comment: String(e?.comment ?? ""),
                    content: String(e?.content ?? ""),
                    constant: e?.constant === true,
                })),
            };
        });
    } else {
        console.warn(`${LOG} event_types.WORLD_INFO_ACTIVATED가 없다 — 이번 턴 주입 표는 비어 있게 된다`);
    }

    // 요술봉(#extensionsMenu) 항목 — 세부 조정은 여기서 (큰 분류는 확장 탭 서랍)
    // 부착 방식 선례: gallery/index.js:801 (extensionsMenu 직접), token-counter/index.js:105 (항목 마크업)
    const wandHtml = `
        <div id="jev_lorebook_wand_container" class="extension_container">
            <div id="jev_lorebook_wand_item" class="list-group-item flex-container flexGap5">
                <div class="fa-solid fa-scale-balanced extensionsMenuExtensionButton"></div>
                <span>Jev Lorebook</span>
            </div>
        </div>`;
    $('#extensionsMenu').append(wandHtml);
    $('#jev_lorebook_wand_item').on('click', openDetailPanel);

    console.log(`${LOG} 로드 완료`);
});
