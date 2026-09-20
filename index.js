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
const DEFAULT_SLICE_TOKENS = 18000; // 슬라이스당 대화 토큰 상한 기본값. v0.7.0에서 설정으로 개방
const REAL_GAP_HOURS = 6;           // 실제 시간이 이만큼 벌어지면 전사에 장면 경계 힌트를 남긴다 (약한 힌트일 뿐)
const CORE_COMMENT = '⭐ Core Memory';   // 코어 메모리 항목 식별자 (comment 고정 = upsert 키)

// ── 스플릿(v0.4) 상수 — st_lorebook_split.py 규칙의 JS 이식 ─────────────────
// 줄머리 20자 이내 날짜 = 경계. $ 앵커 금지 — 엄격 버전은 헤더 뒤 본문 붙은 항목을 통짜로 남겼다 (실측, §4-10)
const SPLIT_DATE_RE = /^[^\S\n]*(?:#{1,4}[^\S\n]*)?(?:\*\*)?[^\n]{0,20}?(\d{4}-\d{2}-\d{2})/gm;
const SPLIT_MIN_CHUNK = 200;             // 이보다 작은 조각은 앞 덩어리에 흡수
const SPLIT_EST_CHARS_PER_TOKEN = 3;     // 한글 혼용 보수 추정 (이식 원본과 동일)
const SPLIT_BIG_CONSTANT_CHARS = 3000;   // constant 항목이 이 크기를 넘으면 기본 체크 후보 (≈1,000토큰)
const CORE_TOKEN_LIMIT = 800;            // 코어 스냅샷 상한 — 프롬프트 강제, 초과 시 경고 로그
const CORE_ORDER = 1000;                 // 코어 메모리 삽입 순서 — 일반 항목 기본값(100)보다 위
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
 * 코어 갱신 전용 system prompt — 유저 편집 불가 (구조가 깨지면 코어 항목 upsert가 통째로 죽는다).
 * v0.7.0에서 사건 추출과 분리했다: 슬라이스마다 코어를 같이 시키면
 * (a) 사건 출력 예산을 코어가 갈라먹고 (b) 중간 슬라이스의 코어는 어차피 버려진다 — 호출 낭비.
 */
const CORE_PROMPT = [
    'You maintain the CORE STATE of an ongoing roleplay: what must NEVER be forgotten between sessions.',
    'You are given the [Previous core state] and the [New incidents] extracted from the latest logs.',
    'UPDATE the previous core state with what changed in the new incidents.',
    'Present state only, never a running log of events. If nothing changed, restate it as-is.',
    '',
    'Strict output format:',
    '- Output exactly one section, starting with the exact header line: ### CORE STATE',
    '- Format as short labeled lines — NO flowing prose, NO paragraphs:',
    '  Relationship: <the current state in one line, as it stands NOW (confession/dating/conflict/etc.)>',
    '  Dynamics: <how they treat each other now, 1-2 short lines>',
    '  Ongoing: <unresolved arcs, promises, plans — one per line, each starting with "- ">',
    '  Facts: <immutable facts: identities, secrets known/unknown, living situation — one per line, each starting with "- ">',
    `- Every line short and declarative. Keep the whole CORE STATE section under ${CORE_TOKEN_LIMIT} tokens.`,
    '- Output in English. Output nothing else: no preamble, no commentary.',
].join('\n');

/** 직전 판정 결과 — 채팅이 안 전진했으면 Jev 재호출 없이 재주입만 한다 */
let lastJudgment = { key: 0, items: [], ts: 0 };
/** 직전 턴 판정 리포트 — 세부 패널 관측용 (콘솔 안 열어도 보이게) */
let lastReport = null;
/** 직전 인터셉터 에러 — 패널 표시용 */
let lastError = null;
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
const EMBEDDING_SOURCES = {
    palm:         { label: 'Google AI Studio (Gemini)', secretKey: SECRET_KEYS.MAKERSUITE, modelFromRequest: true, defaultModel: 'gemini-embedding-001', keyRoute: 'chat', stSource: 'Google AI Studio' }, // text-embedding-005는 404 — 실측
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

// 설정 숫자칸 범위 — UI(min/max)와 읽기 쪽 클램프가 같은 값을 써야 한다 (UI만 막으면 수동 설정 파일 편집을 못 막는다)
const SLICE_TOKENS_MIN = 2000;
const SLICE_TOKENS_MAX = 60000;
const CONVERT_MAX_TOKENS_MIN = 1024;
const CONVERT_MAX_TOKENS_MAX = 65536;
const DEFAULT_CONVERT_MAX_TOKENS = 16384; // 구 v0.6.4는 4096 고정 — 18,000토큰 슬라이스의 사건 다발을 담기엔 터무니없이 짧았다
const INCIDENT_TOKENS_MIN = 100;
const INCIDENT_TOKENS_MAX = 4000;
const DEFAULT_INCIDENT_MAX_TOKENS = 500;

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
    convertProfileId: '',      // 빈 값 = 현재 연결된 메인 API // 변환·숨김에서 제외할 최근 메시지 수 — 직전 장면은 원문으로 남아야 한다
    // ── v0.7.0 신규 ──
    sliceTokens: DEFAULT_SLICE_TOKENS,          // 슬라이스당 전사 토큰 상한
    convertMaxTokens: DEFAULT_CONVERT_MAX_TOKENS, // 변환 응답 최대 토큰 (프로필 경로에만 직접 먹임)
    incidentMaxTokens: DEFAULT_INCIDENT_MAX_TOKENS, // 사건 1건당 토큰 상한 (프롬프트에 주입)
    queryTopK: DEFAULT_TOP_K,                   // 벡터 회수 후보 수
    convertStyle: '',                           // 빈 값 = DEFAULT_CONVERT_STYLE 사용
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

function getQueryTopK() {
    return clampSetting(getSettings().queryTopK, TOP_K_MIN, TOP_K_MAX, DEFAULT_TOP_K);
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
 * 우선순위: 설정 고정 > 캐릭터 카드 북 > 채팅 바인딩 북.
 * ⚠ 전역·페르소나는 어떤 경우에도 반환하지 않는다 — 전역 북에 사건이 쌓이면 모든 채팅으로 샌다.
 * 카드 북이 없으면 채팅 북으로 폴백한다: 발주자 캐릭터 183장 중 카드에 북이 박힌 건 44장뿐이라
 * 폴백이 없으면 대부분의 채팅에서 변환이 죽는다.
 */
function getConversionTargetWorld() {
    const settings = getSettings();
    const known = new Set(world_names ?? []);
    if (settings.world) return known.has(settings.world) ? settings.world : '';
    const ctx = SillyTavern.getContext();
    for (const name of getCharacterCardWorlds(ctx)) {
        if (known.has(name)) return name;
    }
    const chatWorld = ctx.chatMetadata?.[METADATA_KEY];
    if (chatWorld && typeof chatWorld === 'string' && known.has(chatWorld)) return chatWorld;
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
    }
    return body;
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
        throw new Error(`벡터 query 실패 (HTTP ${response.status})`);
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
        throw new Error(`벡터 insert 실패 (HTTP ${response.status})`);
    }
}

async function vectorPurge(worldName) {
    const response = await fetch('/api/vector/purge', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ collectionId: getCollectionId(worldName) }),
    });
    if (!response.ok) {
        throw new Error(`벡터 purge 실패 (HTTP ${response.status})`);
    }
}

/**
 * 항목을 코어(constant) ↔ 검색층 사이로 옮긴다 (v0.6.4).
 *
 * 승격(검색층 → 코어): constant=true + order=1000.
 *   벼터는 그대로 두어도 된다 — 후보 회수부가 constant 항목을 이미 걸러낸다(이중 주입 없음).
 *   남은 벡터는 다음 재색인 때 자동으로 청소된다 → 임베딩 호출 0회.
 * 강등(코어 → 검색층): constant=false + order=100 + 그 항목만 벡터에 삽입 → 임베딩 1회.
 */
async function setEntryCore(world, uid, toCore) {
    const worldData = await loadWorldInfo(world);
    const entry = worldData?.entries?.[uid];
    if (!entry) throw new Error(`uid ${uid} 항목을 찾지 못했어요`);

    entry.constant = !!toCore;
    entry.order = toCore ? CORE_ORDER : NORMAL_ORDER;
    await saveWorldInfo(world, worldData, true);

    if (!toCore) {
        const content = String(entry.content ?? '');
        await vectorInsert(world, [{ hash: getStringHash(content), text: content, index: Number(uid) }]);
    }
    console.log(`${LOG} '${world}' uid ${uid} → ${toCore ? '코어(constant, order 1000)' : '검색층(order 100, 벡터 삽입)'}`);
}

/** 대략 토큰수 (chars/4) — 패널 표시용 근사치 */
function approxTokens(text) {
    return Math.max(1, Math.round(String(text ?? '').length / 4));
}

/**
 * 전문 펼침 셀 + 상세 행 (v0.6.4).
 * PC·폰 동일하게 클릭 하나. hover는 폰에 없어서 쓰지 않는다.
 * 여러 행을 동시에 펼칠 수 있고(항목끼리 비교용), 높이 제한은 두지 않는다(현이 결정).
 */
function buildDetailToggle(content, colSpan) {
    const $toggle = $('<span class="jev-detail-toggle" role="button" tabindex="0">')
        .attr('title', '이 항목의 본문 전문을 펼쳐서 봐요')
        .append($('<i class="fa-solid fa-chevron-down">'))
        .append($('<span>').text('전문'));

    const $detail = $('<tr class="jev-detail-row" style="display: none;">')
        .append($('<td>').attr('colspan', colSpan).append($('<div class="jev-detail-body">').text(String(content ?? ''))));

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
 * 코어 ↔ 검색층 전환 셀 (v0.6.4) — 파란 원 = 상시(코어), 초록 원 = 검색층.
 * 확인 팝업 없음(현이 결정) — 다시 누르면 되돌아가고 합계 토큰이 즉시 보이므로 피드백이 충분하다.
 */
function buildCoreToggle(world, uid, isCore, $panel) {
    const $btn = $('<span class="jev-core-toggle" role="button" tabindex="0">')
        .addClass(isCore ? 'jev-is-core' : 'jev-is-search')
        .attr('title', isCore
            ? '상시 메모리(코어) — 누르면 검색층으로 내려요'
            : '검색층 메모리 — 누르면 상시(코어)로 올려요')
        .append($('<i class="fa-solid fa-circle">'));

    const run = async () => {
        if ($btn.hasClass('disabled')) return;
        $btn.addClass('disabled');
        try {
            await setEntryCore(world, uid, !isCore);
            toastr.success(
                !isCore ? '상시 메모리로 올렸어요 (order 1000)' : '검색층으로 내렸어요 (벡터 삽입 완료)',
                'Jev Lorebook');
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
        throw new Error(`벡터 list 실패 (HTTP ${response.status})`);
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
    } catch (error) {
        console.log(`${LOG} 플러그인 경로 프로브 실패 — 다음 경로 시도: ${error?.message ?? error}`);
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
        if (r.status === 401) {
            corsFailReason = 'basicAuth 충돌(401) — Authorization을 Bearer가 덮어서 이 서버엔 플러그인만 가능';
        } else if (r.status === 404) {
            corsFailReason = '내장 CORS 프록시 꺼짐(404)';
        } else {
            return { kind: 'cors', endpoint: JEV_CORS_API, label: 'ST 내장 CORS 프록시 (/proxy)' };
        }
    } catch (error) {
        corsFailReason = String(error?.message ?? error);
    }
    throw new Error(`Jev 연결 경로가 없어요 — config.yaml의 enableCorsProxy: true(간단) 또는 jev-proxy 서버 플러그인(로그인/basicAuth 켠 서버용) 중 하나를 켜 주세요. (CORS 경로: ${corsFailReason})`);
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
            if (lastJudgment.items.length) {
                await eventSource.emit(
                    event_types.WORLDINFO_FORCE_ACTIVATE,
                    lastJudgment.items.map(x => ({ world: x.world, uid: x.uid })),
                );
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
                ({ metadata } = await vectorQuery(world, queryText, getQueryTopK()));
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
                });
            }
        }

        if (!candidates.length) {
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

        // 3. 점수순 정렬 → 예산 컷
        const budget = Number(settings.budgetTokens) || defaultSettings.budgetTokens;
        const ranked = judged.slice().sort((a, b) => b.final - a.final);
        const adopted = [];
        let usedTokens = 0;
        for (const item of ranked) {
            if (item.final < SCORE_FLOOR) break; // 정렬됐으니 이후는 전부 하한 미만
            const tokens = await getTokenCountAsync(item.text);
            if (usedTokens + tokens > budget) continue; // 남은 예산에 드는 다음 후보 탐색
            usedTokens += tokens;
            adopted.push({ ...item, tokens });
        }

        lastJudgment = { key: cacheKey, items: adopted.map(a => ({ world: a.world, uid: a.uid })), ts: Date.now() };

        // 4. 주입
        if (adopted.length) {
            await eventSource.emit(
                event_types.WORLDINFO_FORCE_ACTIVATE,
                adopted.map(a => ({ world: a.world, uid: a.uid })),
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
function looksTruncated(text) {
    const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return false;
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

/** 로어북에서 코어 메모리 항목 찾기 (comment 고정 식별, upsert 키) */
function findCoreEntry(worldData) {
    return Object.values(worldData?.entries ?? {}).find(e => e.comment === CORE_COMMENT) ?? null;
}

/**
 * 해당 작중 날짜로 이미 저장된 항목 수 (v0.7.0 에피소드 번호용).
 * 코어 항목은 날짜 개념이 없으므로 제외. ⚠ 새 항목을 worldData에 넣기 **전**에 세야 한다.
 */
function countExistingForDate(worldData, date) {
    if (!date) return 0;
    let n = 0;
    for (const e of Object.values(worldData?.entries ?? {})) {
        if (e.comment === CORE_COMMENT) continue;
        if (String(e.comment ?? '').includes(date)) n++;
    }
    return n;
}

/** 로어북 comment에 박힌 날짜 중 가장 늦은 것 — 앛커 폴백 2단계 */
function latestDateInWorld(worldData) {
    let latest = '';
    for (const e of Object.values(worldData?.entries ?? {})) {
        if (e.comment === CORE_COMMENT) continue;
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
        // 현재 연결 경로는 ST의 응답 최대 토큰 설정을 그대로 따른다.
        // generateRaw에 상한을 넘기지 않기로 했고(현이 결정, v0.7.0), 대신 패널과 경고로 알린다.
        const text = await ctx.generateRaw({ prompt: userPrompt, systemPrompt });
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
async function collectTruncationWarnings(warnings, text, viaProfile, maxTokens, label) {
    if (viaProfile) {
        try {
            const used = await getTokenCountAsync(String(text ?? ''));
            if (used >= Math.floor(maxTokens * TRUNCATION_RATIO)) {
                warnings.push(`${label}: 응답이 ${used.toLocaleString()}토큰으로 상한(${maxTokens.toLocaleString()})에 닿았어요 — 뒷부분이 잘렸을 수 있어요`);
            }
        } catch (error) {
            console.warn(`${LOG} ${label} 응답 토큰 계산 실패 (잘림 감지 (a) 건너뜀): ${error?.message ?? error}`);
        }
    }
    if (looksTruncated(text)) {
        warnings.push(`${label}: 응답이 문장 중간에서 끓겼어요 — 응답 최대 토큰을 늘려 보세요`);
    }
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
        let coreState = String(findCoreEntry(worldData)?.content ?? '').trim();
        const anchor = resolveStoryAnchor(ctx, worldData, fresh);

        setStatus('슬라이스 계산 중…');
        const sliceTokens = getSliceTokens();
        const maxTokens = getConvertMaxTokens();
        const slices = await buildSlices(fresh, sliceTokens);
        const incidentsPrompt = buildIncidentsPrompt(getConvertStyle(), getIncidentMaxTokens(), anchor);
        console.log(`${LOG} 변환 시작 — 대상='${world}' 메시지 ${fresh.length}건(인덱스 ${startIndex}~${endIndex}, 최근 ${keepRecent}개 보존) → 슬라이스 ${slices.length}개(${sliceTokens}토큰 단위) / 작중 앵커 '${anchor || '없음'}' / 이전 코어 ${coreState ? '있음' : '없음'}`);

        // 1. 슬라이스별 사건 추출 — 이 호출들은 코어를 전혀 다루지 않는다 (출력 예산 전액을 사건에 쓴다)
        const incidents = [];
        for (let i = 0; i < slices.length; i++) {
            const label = `슬라이스 ${i + 1}/${slices.length}`;
            setStatus(`요약 생성 중… ${i + 1}/${slices.length} (${getConvertProfileLabel()})`);
            const transcript = sliceToTranscript(slices[i]);
            const prompt = `[Anchor: ${anchor || 'unknown'}]\n\n[Transcript]\n${transcript}`;
            const { text: raw, viaProfile } = await generateConversion(ctx, incidentsPrompt, prompt);
            await collectTruncationWarnings(warnings, raw, viaProfile, maxTokens, label);
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

        // 1b. 코어 갱신 1회 — 입력은 전사 원문이 아니라 이번에 뽑은 사건 요약본 전체.
        //     형식이 깨지면 1회만 재시도하고, 그래도 안 되면 코어만 손대지 않고 진행한다 (사건은 살린다).
        setStatus(`코어 메모리 갱신 중… (${getConvertProfileLabel()})`);
        const digest = incidents.map(inc => `### ${inc.date} — ${inc.title}\n${inc.body}`).join('\n\n');
        const corePrompt = `[Previous core state]\n${coreState || '(none)'}\n\n[New incidents]\n${digest}`;
        let coreUpdated = false;
        let coreFailReason = '';
        for (let attempt = 1; attempt <= 2 && !coreUpdated; attempt++) {
            const label = attempt === 1 ? '코어 갱신' : '코어 갱신(재시도)';
            try {
                const { text: raw, viaProfile } = await generateConversion(ctx, CORE_PROMPT, corePrompt);
                await collectTruncationWarnings(warnings, raw, viaProfile, maxTokens, label);
                const parsed = parseConversionOutput(raw);
                if (parsed.core) {
                    coreState = parsed.core;
                    coreUpdated = true;
                } else {
                    coreFailReason = `${label}: 응답에 ### CORE STATE 섹션이 없거나 본문이 비었어요`;
                    console.warn(`${LOG} ${coreFailReason}`);
                }
            } catch (error) {
                coreFailReason = `${label}: ${error?.message ?? error}`;
                console.warn(`${LOG} ${coreFailReason}`);
            }
        }
        if (!coreUpdated) {
            coreFailed = true;
            warnings.push(`코어 메모리를 갱신하지 못했어요 (사건은 그대로 저장했어요) — ${coreFailReason || '사유 미상'}`);
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
        for (const inc of incidents) {
            const entry = createWorldInfoEntry(world, worldData);
            if (!entry) {
                throw new Error('로어북 항목 uid 할당 실패');
            }
            const seen = batchByDate.get(inc.date) ?? 0;
            batchByDate.set(inc.date, seen + 1);
            const n = (existingByDate.get(inc.date) ?? 0) + seen + 1;
            // 키워드 발동은 쓰지 않는다 — 발동 경로는 Jev(FORCE_ACTIVATE) 단일.
            // 키를 달면 ST 재귀 스캔이 본문의 이름·날짜를 물고 연쇄 발동하는데,
            // world_info_max_recursion_steps=0이면 제동이 아예 안 걸려 예산 상한까지 퍼붓는다. (2026-09-20)
            entry.key = [];
            // 1번째엔 번호를 안 붙인다 — 하루에 사건이 하나뿐인 날이 대부분이라 '#1'은 소음이다
            entry.comment = `${inc.title} · ${inc.date}${n > 1 ? ` #${n}` : ''}`;
            entry.content = inc.body;
            entry.constant = false;
            entry.disable = false;
        }

        // 2b. 코어 메모리 upsert — constant:true = ST가 매턴 네이티브 주입 (Jev 판정·색인 밖 — 설계 의도)
        //     갱신에 실패했으면 기존 코어 항목은 건드리지 않는다 (덮어쓸 새 값이 없다).
        if (coreState && coreUpdated) {
            const coreTokens = await getTokenCountAsync(coreState);
            if (coreTokens > CORE_TOKEN_LIMIT) {
                console.warn(`${LOG} 코어 스냅샷 ${coreTokens}토큰 — 상한 ${CORE_TOKEN_LIMIT} 초과 (자르지 않고 그대로 저장, 다음 변환에서 재압축됨)`);
            }
            let coreEntry = findCoreEntry(worldData);
            if (!coreEntry) {
                coreEntry = createWorldInfoEntry(world, worldData);
                if (!coreEntry) throw new Error('코어 항목 uid 할당 실패');
                coreEntry.comment = CORE_COMMENT;
            }
            coreEntry.key = [];
            coreEntry.order = CORE_ORDER; // 일반 항목(기본 100)보다 위 — 프롬프트 최상단 고정
            coreEntry.content = coreState;
            coreEntry.constant = true;
            coreEntry.disable = false;
            console.log(`${LOG} 코어 메모리 upsert — ${coreTokens}토큰 (constant, 매턴 네이티브 주입)`);
        } else {
            console.warn(`${LOG} 코어 미갱신 — 기존 코어 항목을 그대로 둔다`);
        }

        await saveWorldInfo(world, worldData, true);
        reloadEditor(world); // 에디터에 이 로어북이 열려 있으면 실시간 갱신 (world-info.js:1040, 강제 오픈 없음)

        // 3. 변환 지점 + 작중 날짜 앵커 기록 (chat_metadata — 이 채팅에만 귀속)
        //    앵커 = 마지막 사건의 날짜. 다음 변환이 여기서부터 경과를 센다.
        ctx.chatMetadata[CONVERT_META_KEY] = endIndex;
        const lastDate = incidents[incidents.length - 1]?.date;
        if (lastDate) ctx.chatMetadata[STORY_ANCHOR_META_KEY] = lastDate;
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
        const summary = `사건 ${incidents.length}건 추가 · 코어 ${coreUpdated ? '갱신' : '미갱신'} · 앵커 ${lastDate || '유지'} · ${indexed}개 색인 · 메시지 ${hiddenCount}개 변환·숨김, 최근 ${keepRecent}개 유지 (${ms}ms)`;
        const toastBody = `변환을 마쳤어요: 사건 ${incidents.length}건 · 메시지 ${hiddenCount}개 숨김 · 최근 ${keepRecent}개는 원문 유지 — ${world}.`;
        const toastOptions = { onclick: () => openWorldEditor(world), timeOut: 10000 };

        if (!warnings.length) {
            setStatus(`완료: ${summary}`);
            toastr.success(`${toastBody} 여기를 누르면 에디터에서 바로 확인할 수 있어요.`, 'Jev Lorebook', toastOptions);
        } else {
            // 경고가 하나라도 있으면 초록불을 띄우지 않는다 — "다 잘 됐구나"로 읽히면 잘린 요약이 그대로 굳는다
            setStatus(`완료(경고 ${warnings.length}건): ${summary} — ${warnings.join(' / ')}`);
            const warnBody = `${toastBody}\n⚠ 확인할 게 ${warnings.length}건 있어요: ${warnings.join(' / ')}`;
            if (coreFailed) {
                toastr.error(warnBody, 'Jev Lorebook', { ...toastOptions, timeOut: 20000 });
            } else {
                toastr.warning(warnBody, 'Jev Lorebook', { ...toastOptions, timeOut: 20000 });
            }
        }
        console.log(`${LOG} 변환 완료 — 사건 ${incidents.length}건 / 변환 지점 ${startIndex}→${endIndex} / 숨김 ${hiddenCount}개 / 경고 ${warnings.length}건 / ${ms}ms`);
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
    $summary.append(row('턴당 예산', `${Number(settings.budgetTokens) || defaultSettings.budgetTokens}토큰`));
    $summary.append(row('전송', jevTransport ? jevTransport.label : (lastTransportError ? `없음 — ${lastTransportError}` : '미감지 (첫 생성 때 자동으로 감지해요)')));
    const embedMeta = EMBEDDING_SOURCES[settings.embeddingSource] ?? EMBEDDING_SOURCES.palm;
    const embedModel = embedMeta.modelFromRequest ? (String(settings.embeddingModel || '').trim() || embedMeta.defaultModel) : '(서버 고정)';
    const embedKey = embedMeta.secretKey === null ? '키 불필요' : (secret_state[embedMeta.secretKey] ? '키 등록됨 ✓' : '키 미등록 ✗');
    $summary.append(row('임베딩', `${embedMeta.label} · ${embedModel} · ${embedKey}${settings.embeddingDirty ? ' · ⚠ 재색인 필요' : ''}`));
    $summary.append(row('변환 프로필', getConvertProfileLabel()));
    const keepRecent = Number.isFinite(Number(settings.keepRecent)) ? Math.max(0, Number(settings.keepRecent)) : defaultSettings.keepRecent;
    $summary.append(row('변환 대상', convertWorld || '없음'));
    $summary.append(renderChatStack(ctx.chat ?? [], converted, keepRecent, chatLength));
    renderConvertProfileBadge($panel);
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

/** 직전 턴 판정 리포트 렌더 — 북별 그룹 헤더로 묶는다 (v0.8.0: 4계층이라 여러 북이 섞인다) */
function renderPanelJudgment($panel) {
    const $box = $panel.find('#jev_panel_judgment').empty();

    if (lastError) {
        $box.append($('<div class="jev-panel-error">').text(`⚠ 직전 판정이 실패했어요 (${new Date(lastError.ts).toLocaleTimeString()}): ${lastError.message}`));
    }
    if (!lastReport) {
        $box.append($('<div class="jev-panel-muted">').text('아직 판정 기록이 없어요. 생성을 한 번 진행한 뒤 다시 열어 주세요.'));
        return;
    }

    const meta = `${new Date(lastReport.ts).toLocaleTimeString()} · type=${lastReport.type} · 후보 ${lastReport.candidateCount} → 채택 ${lastReport.adoptedCount} · ${lastReport.usedTokens}토큰 · ${lastReport.ms}ms`
        + (lastReport.cacheHits ? ` · 캐시 재사용 ${lastReport.cacheHits}회` : '')
        + ` — 대상 ${lastReport.worlds.length}개: ${lastReport.worlds.join(', ')}`;
    $box.append($('<div class="jev-panel-muted">').text(meta));

    // '월드' 칸을 없애고 그룹 헤더로 올렸다 — 16자로 잘린 칸으로는 북이 여럿일 때 분간이 안 된다.
    const headers = ['채택', 'uid', '제목', '모순위험', '장면적합', '최근중복', '최종', '토큰', ''];
    const $table = $('<table class="jev-panel-table">');
    const $thead = $('<tr>');
    for (const h of headers) {
        $thead.append($('<th>').text(h));
    }
    $table.append($('<thead>').append($thead));
    const $tbody = $('<tbody>');

    const layerOf = new Map(getTargetWorldsDetailed().map(d => [d.name, d.layer]));
    const groups = new Map();
    for (const r of lastReport.rows) {
        const key = String(r.world);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }

    for (const [world, rows] of groups) {
        const adoptedCount = rows.filter(r => r.adopted).length;
        const $groupCell = $('<td>').attr('colspan', headers.length);
        const layer = layerOf.get(world);
        if (layer) $groupCell.append($('<span class="jev-layer-badge">').text(LAYER_LABELS[layer] ?? layer));
        $groupCell.append($('<span class="jev-group-name">').text(world));
        $groupCell.append($('<span class="jev-group-meta">').text(`후보 ${rows.length}개 · 채택 ${adoptedCount}개`));
        $tbody.append($('<tr class="jev-panel-group-row">').append($groupCell));

        for (const r of rows) {
            const $tr = $('<tr>').toggleClass('jev-adopted', r.adopted);
            $tr.append($('<td>').text(r.adopted ? '✓' : ''));
            $tr.append($('<td>').text(r.uid));
            $tr.append($('<td class="jev-cell-title">').text(String(r.title).slice(0, 48)));
            $tr.append($('<td>').text(r.contradiction.toFixed(2)));
            $tr.append($('<td>').text(r.sceneFit.toFixed(2)));
            $tr.append($('<td>').text(r.duplicate.toFixed(2)));
            $tr.append($('<td>').text(r.final.toFixed(3)));
            $tr.append($('<td>').text(r.tokens ?? '—'));

            // 전문 펼치기(v0.6.4) — 점수만 보고는 왜 빠졌는지 몰라서 여기가 제일 많이 쓰인다.
            const { $cell, $detail } = buildDetailToggle(r.text, headers.length);
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
        // 코어(constant) 항목은 색인·판정 밖 — 별도 섹션으로 표시
        const coreEntries = allEntries.filter(e => e.constant && !e.disable && String(e.content ?? '').trim());
        const entries = allEntries.filter(e => !e.disable && !e.constant && String(e.content ?? '').trim());
        const disabledCount = allEntries.length - entries.length - coreEntries.length;

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
            const hash = getStringHash(content);
            const isIndexed = indexedHashes ? indexedHashes.has(Number(hash)) : false;
            if (isIndexed) indexedCount++;
            const $tr = $('<tr>').toggleClass('jev-missing', indexedHashes ? !isIndexed : false);
            $tr.append($('<td>').text(indexedHashes ? (isIndexed ? '✓' : '✗') : '?'));
            $tr.append($('<td>').text(e.uid));
            $tr.append($('<td class="jev-cell-title">').text(String(e.comment || `uid ${e.uid}`).slice(0, 48)));
            $tr.append($('<td>').text(approxTokens(content)));
            $tr.append(buildCoreToggle(world, e.uid, false, $panel));

            const { $cell, $detail } = buildDetailToggle(content, 6);
            $tr.append($cell);
            $tbody.append($tr).append($detail);
        }
        $table.append($tbody);

        const headline = listError
            ? `${world} — 항목 ${entries.length}개 / 색인 대조에 실패했어요: ${listError}`
            : `${world} — 항목 ${entries.length}개 / 색인 ${indexedCount}개 / 미색인 ${entries.length - indexedCount}개`
              + (indexedHashes ? ` (벡터 저장소 ${indexedHashes.size}건)` : '')
              + (disabledCount ? ` · 비활성/빈 항목 ${disabledCount}개 제외` : '');
        const $worldTitle = $('<div class="jev-panel-world-title">');
        const layer = layerOf.get(world);
        if (layer) $worldTitle.append($('<span class="jev-layer-badge">').text(LAYER_LABELS[layer] ?? layer));
        $worldTitle.append($('<span>').text(headline));
        $section.append($worldTitle);
        $section.append($('<div class="jev-panel-muted">').text(
            '🔵 = 상시 메모리(매 턴 주입) · 🟢 = 검색층 / 누르면 전환할 수 있습니다.'));

        // 코어 메모리 섹션 — constant라 ST가 매턴 네이티브 주입, Jev 판정·벡터 색인 제외.
        // v0.6.4: 아래 색인 현황과 같은 표 형식 + 합계 토큰. 코어는 매 턴 고정비용이라
        // 파란불을 늘릴수록 이 숫자가 올라간다 — 개수만 보여주면 늘린 대가가 안 보인다.
        if (coreEntries.length) {
            const coreTokens = coreEntries.reduce((sum, e) => sum + approxTokens(e.content), 0);
            const budget = Number(getSettings().budgetTokens) || defaultSettings.budgetTokens;
            const $core = $('<div class="jev-panel-core">');
            $core.append($('<div class="jev-panel-core-title">').text(
                `⭐ 코어 메모리 ${coreEntries.length}개 · 합계 ≈${coreTokens.toLocaleString()}토큰 · 주입 예산 ${budget.toLocaleString()} → 매 턴 ≈${(coreTokens + budget).toLocaleString()}토큰`));
            $core.append($('<div class="jev-panel-muted">').text('매 턴 항상 주입돼요 (constant, Jev 판정을 거치지 않아요)'));

            const $coreTable = $('<table class="jev-panel-table">');
            const $coreHead = $('<tr>');
            for (const h of ['uid', '제목', '≈토큰', '', '']) {
                $coreHead.append($('<th>').text(h));
            }
            $coreTable.append($('<thead>').append($coreHead));
            const $coreBody = $('<tbody>');
            for (const e of coreEntries) {
                const content = String(e.content ?? '');
                const $tr = $('<tr>');
                $tr.append($('<td>').text(e.uid));
                $tr.append($('<td class="jev-cell-title">').text(String(e.comment || `uid ${e.uid}`).slice(0, 48)));
                $tr.append($('<td>').text(approxTokens(content)));
                $tr.append(buildCoreToggle(world, e.uid, true, $panel));

                const { $cell, $detail } = buildDetailToggle(content, 5);
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

/** 패널 전체 갱신 */
async function refreshPanel($panel) {
    renderPanelSummary($panel);
    renderPanelWarnings($panel);
    renderPanelJudgment($panel);
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
    const $status = $('#jev_lorebook_key_status');
    const $help = $('#jev_lorebook_key_help');
    // 키 입력칸을 우리가 안 가지고 있다는 걸 명시해야 한다 — 설정탭에 칸이 없으니 최초 설치자는 어디에 넣는지 몰라 막힌다.
    if (meta.secretKey === null) {
        $status.text('로컬 소스라 API 키가 필요 없어요.').removeClass('jev-key-missing');
        $help.hide().empty(); // 키가 필요 없는 소스엔 안내 자체가 소음이다
    } else if (secret_state[meta.secretKey]) {
        $status.text('키 등록됨 ✓').removeClass('jev-key-missing');
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
function populateConvertProfiles() {
    const settings = getSettings();
    const $row = $('#jev_lorebook_profile_row');
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles(); // shared.js:525
        const $select = $('#jev_lorebook_convert_profile');
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
async function fillTopKTotal() {
    const $total = $('#jev_lorebook_topk_total');
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
 * 설정탭 '대상 로어북' — 지금 감지된 북 목록 (v0.8.0).
 * 후보 수 상한은 두지 않기로 했으므로(발주자 결정) 대신 북 개수·총 항목 수를 보여준다.
 * 로어북 로드·색인 대조가 있어 비동기 — fillTopKTotal과 같은 패턴으로 렌더를 막지 않는다.
 */
let layerListRun = 0;
async function renderLayerList() {
    const run = ++layerListRun;
    const $box = $('#jev_lorebook_layer_list');
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
        const $meta = $('<span class="jev-layer-meta">').text('확인 중…');
        $row.append($meta);
        $box.append($row);

        try {
            const worldData = await loadWorldInfo(name);
            if (run !== layerListRun) return; // 그 사이 다시 렌더됨 — 옛 결과를 덮어쓰지 않는다
            const live = Object.values(worldData?.entries ?? {})
                .filter(e => !e.disable && String(e.content ?? '').trim());
            totalEntries += live.length;
            // 코어(constant)는 ST가 매 턴 네이티브 주입 = 색인 대상이 아니다
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
            $meta.text(`${live.length}항목 · ${indexText}`);
        } catch (error) {
            $meta.text(`읽기 실패: ${error?.message ?? error}`);
        }
        if (run !== layerListRun) return;
        $summary.text(`북 ${detailed.length}개 · 총 ${totalEntries}항목`);
    }
}

function populateWorldSelect() {
    const settings = getSettings();
    const $select = $('#jev_lorebook_world');
    $select.empty().append('<option value="">— 자동: 위에서 켠 층의 로어북 —</option>');
    for (const name of (world_names ?? [])) {
        $select.append($('<option>').val(name).text(name));
    }
    $select.val(settings.world);
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

    $('#jev_lorebook_budget').val(settings.budgetTokens).on('input', function () {
        settings.budgetTokens = Number($(this).val()) || defaultSettings.budgetTokens;
        saveSettingsDebounced();
    });

    $('#jev_lorebook_world').on('change', function () {
        settings.world = String($(this).val());
        saveSettingsDebounced();
        void renderLayerList();
        void fillTopKTotal(); // 대상이 바뀌면 '전체 N개'도 따라가야 한다
    });

    $('#jev_lorebook_keep_recent').val(settings.keepRecent).on('input', function () {
        const value = Number($(this).val());
        settings.keepRecent = Number.isFinite(value) && value >= 0 ? value : defaultSettings.keepRecent;
        saveSettingsDebounced();
    });

    $('#jev_lorebook_index').on('click', indexLorebook);

    // ── v0.7.0 신규 설정 ──
    // topK 슬라이더 — 옆 숫자는 input에서 즉시 따라간다(놓을 때까지 몰라야 하면 조절을 못 한다)
    $('#jev_lorebook_topk').val(getQueryTopK()).on('input', function () {
        const value = clampSetting($(this).val(), TOP_K_MIN, TOP_K_MAX, DEFAULT_TOP_K);
        settings.queryTopK = value;
        $('#jev_lorebook_topk_value').text(String(value));
        saveSettingsDebounced();
    });
    $('#jev_lorebook_topk_value').text(String(getQueryTopK()));
    void fillTopKTotal();
    void renderLayerList();

    $('#jev_lorebook_slice_tokens').val(getSliceTokens()).on('input', function () {
        settings.sliceTokens = clampSetting($(this).val(), SLICE_TOKENS_MIN, SLICE_TOKENS_MAX, DEFAULT_SLICE_TOKENS);
        saveSettingsDebounced();
    });

    $('#jev_lorebook_convert_max_tokens').val(getConvertMaxTokens()).on('input', function () {
        settings.convertMaxTokens = clampSetting($(this).val(), CONVERT_MAX_TOKENS_MIN, CONVERT_MAX_TOKENS_MAX, DEFAULT_CONVERT_MAX_TOKENS);
        saveSettingsDebounced();
    });

    $('#jev_lorebook_incident_max_tokens').val(getIncidentMaxTokens()).on('input', function () {
        settings.incidentMaxTokens = clampSetting($(this).val(), INCIDENT_TOKENS_MIN, INCIDENT_TOKENS_MAX, DEFAULT_INCIDENT_MAX_TOKENS);
        saveSettingsDebounced();
    });

    // 스타일 지시문 — 빈 값이 곷 기본값이라 placeholder에도 같은 글을 넣는다
    $('#jev_lorebook_convert_style')
        .attr('placeholder', DEFAULT_CONVERT_STYLE)
        .val(String(settings.convertStyle || ''))
        .on('input', function () {
            settings.convertStyle = String($(this).val());
            saveSettingsDebounced();
        });
    $('#jev_lorebook_style_reset').on('click', function () {
        settings.convertStyle = '';
        $('#jev_lorebook_convert_style').val('');
        saveSettingsDebounced();
        toastr.info('변환 스타일 지시문을 기본값으로 되돌렸어요.', 'Jev Lorebook');
    });

    // 임베딩 소스/모델 (v0.5) — 변경 시 기존 색인과 벡터 차원이 어긋나므로 재색인 경고
    populateEmbeddingSourceSelect();
    updateEmbeddingSourceUi();
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

    // 변환 프로필 (v0.5) — 열 때마다 최신 목록으로 갱신
    populateConvertProfiles();
    $('#jev_lorebook_convert_profile').on('focus', populateConvertProfiles).on('change', function () {
        settings.convertProfileId = String($(this).val());
        saveSettingsDebounced();
    });

    // 감지 대상 층 on/off (v0.8.0) — 전부 기본 켜짐. 끄면 그 층의 북이 감지 목록에서 빠진다.
    const LAYER_INPUTS = {
        layerChat: '#jev_lorebook_layer_chat',
        layerChar: '#jev_lorebook_layer_char',
        layerGlobal: '#jev_lorebook_layer_global',
        layerPersona: '#jev_lorebook_layer_persona',
    };
    for (const [key, selector] of Object.entries(LAYER_INPUTS)) {
        $(selector).prop('checked', settings[key] !== false).on('change', function () {
            settings[key] = !!$(this).prop('checked');
            saveSettingsDebounced();
            void renderLayerList();
            void fillTopKTotal(); // 대상이 바뀌면 '전체 N개'도 따라가야 한다
        });
    }

    populateWorldSelect();
    if (event_types.WORLDINFO_UPDATED) {
        eventSource.on(event_types.WORLDINFO_UPDATED, () => {
            populateWorldSelect();
            void renderLayerList();
        });
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
