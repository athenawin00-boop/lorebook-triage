/**
 * 제브(Jev) 전용부 — 이 파일은 **제브 로어북 배포본에만** 들어간다 (v0.19.0).
 *
 * Jev 3축 판정 / 벡터·임베딩 전부 / generate_interceptor / 랜덤 주입 /
 * 파라미터 오버라이드(북별 > 계층 > 전역) / 색인 현황·탈락 후보 표 / 임베딩 소스 UI.
 *
 * 방향 규칙: jev → core import는 허용, core → jev는 **금지**(순환 방지). core가 이쪽을 부를 때는
 * src/hooks.js에 등록된 훅을 경유한다 — 등록은 루트 index.js가 한다.
 */

import { getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { eventSource, event_types } from '../../../../events.js';
import { renderExtensionTemplateAsync } from '../../../../extensions.js';
import { world_names, loadWorldInfo } from '../../../../world-info.js';
import { getTokenCountAsync } from '../../../../tokenizers.js';
import { getStringHash } from '../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { secret_state, SECRET_KEYS } from '../../../../secrets.js';
import { oai_settings } from '../../../../openai.js';
import { TEMPLATE_PATH, LOG, DISPLAY_NAME } from './flavor.js';
import {
    DEFAULT_RANDOM_BUDGET,
    DEFAULT_TOP_K,
    LAYER_LABELS,
    buildDetailToggle,
    clampSetting,
    conversionInProgress,
    defaultSettings,
    fillStackTokens,
    getSettings,
    getTargetWorlds,
    getTargetWorldsDetailed,
    getWorldLayer,
    invalidateWorldLayerCache,
    renderPanelSummary,
} from './core.js';

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


const TOP_K_MIN = 20;

const TOP_K_MAX = 50;

const SCORE_FLOOR = 0.5;         // 최종 점수 하한. 대조실험 눈금: 0.74=빼면 모순 / 0.52=장면만 맞음 / 0.37=무관

const QUERY_USER_MESSAGES = 3;   // 검색 쿼리로 쓸 최근 유저 메시지 수

const SCENE_MESSAGES = 6;        // Jev에 보여줄 최근 장면 메시지 수

const INSERT_CHUNK = 20;         // 색인 시 insert 배치 크기

const JUDGMENT_CACHE_MS = 60000; // 동일 쿼리 판정 캐시 (같은 턴의 연쇄 quiet 생성 대응)


/** 직전 판정 결과 — 채팅이 안 전진했으면 Jev 재호출 없이 재주입만 한다 */
let lastJudgment = { key: 0, items: [], ts: 0 };

/** 직전 턴 판정 리포트 — 세부 패널 관측용 (콘솔 안 열어도 보이게) */
export let lastReport = null;

/** 직전 인터셉터 에러 — 패널 표시용 */
export let lastError = null;

/** Jev 전송 경로 캐시 (세션당 1회 감지). 판정 실패 시 null로 리셋 → 다음 턴 재감지 */
let jevTransport = null; // { kind: 'plugin'|'cors', endpoint, label }

/** 마지막 경로 감지 실패 사유 — 패널 표시용 */
let lastTransportError = null;

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

export let lastRandomKeys = new Set();


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


// 🎲 랜덤 주입 예산 (v0.15.0) — 주입 예산(budgetTokens)과 별개 통이다. 0이면 랜덤은 돌지 않는다.
const RANDOM_BUDGET_MIN = 0;

const RANDOM_BUDGET_MAX = 20000;

// 주입 예산 범위 (v0.17.0) — settings.html의 min/max와 같은 값을 쓴다.
// 로어북별 오버라이드도 전역과 같은 범위로 클램프한다 — 창구가 둘인데 허용 범위가 다르면 설명할 수 없다.
const BUDGET_TOKENS_MIN = 500;

const BUDGET_TOKENS_MAX = 20000;


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


// ── 계층별 파라미터 오버라이드 (v0.18.0) ─────────────────────────────
// v0.17.0의 오버라이드는 로어북 '이름' 단위였다. 발주 요구가 바뀌어(2026-09-22) 랜덤 주입 같은 값을
// '어느 계층에 걸지'로 정해야 한다 → 계층(채팅·페르소나·캐릭터·전역) 레코드를 넣고,
// 북별은 지우지 않고 예외 층으로 남긴다. 우선순위: 북별 > 계층 > 전역. 네 게터 전부 같은 규칙이다.
const LAYER_ORDER = Object.freeze(['chat', 'persona', 'character', 'global']);


/**
 * 계층 오버라이드 저장소. getPerWorldStore()의 '공유 객체 끊기'를 **두 겹**으로 한다.
 * ⚠ getSettings()의 결손 키 보충은 defaultSettings.perLayer를 참조로 물려준다(Object.freeze는 얕다).
 *   바깥 객체만 갈면 네 계층 레코드가 여전히 defaultSettings 쪽 같은 객체를 가리켜,
 *   업그레이드 설치에서 채팅 계층에 넣은 값이 다른 계층에도 그대로 보인다.
 */
function getPerLayerStore() {
    const settings = getSettings();
    const store = settings.perLayer;
    const usable = store && typeof store === 'object' && !Array.isArray(store);
    if (!usable || store === defaultSettings.perLayer) {
        settings.perLayer = usable ? { ...store } : {};
    }
    for (const layer of LAYER_ORDER) {
        const rec = settings.perLayer[layer];
        const recUsable = rec && typeof rec === 'object' && !Array.isArray(rec);
        if (!recUsable || rec === defaultSettings.perLayer?.[layer]) {
            settings.perLayer[layer] = recUsable ? { ...rec } : {};
        }
    }
    return settings.perLayer;
}


/** 이 계층의 오버라이드 레코드 — 없거나 형식이 깨졌으면 null */
function getLayerOverride(layer) {
    if (!layer) return null;
    const rec = getPerLayerStore()[layer];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    return rec;
}


/** 이 계층에 지정된 값이 하나라도 있나 — 감지 목록의 '계층 설정 따름' 표기 판정 */
function hasLayerOverride(layer) {
    const rec = getLayerOverride(layer);
    return !!rec && PER_WORLD_KEYS.some(key => resolveOverride(rec[key]) !== undefined);
}


/**
 * 값 하나를 북별 > 계층 > 전역 순으로 해석한다. undefined 반환 = 전역값을 쓰라는 뜻.
 * layer를 넘기면 계층 조회를 건너뛴다. world만 넘기면 캐시로 계층을 찾는다.
 * `0`과 `false`는 사용자가 고른 정당한 값이라 resolveOverride()가 '미설정'과 갈라 준다.
 */
function resolveLayered(key, world, layer) {
    const own = resolveOverride(getWorldOverride(world)?.[key]);
    if (own !== undefined) return own;
    const target = layer !== undefined ? layer : getWorldLayer(world);
    return resolveOverride(getLayerOverride(target)?.[key]);
}


/** 주입 예산 — 북별 > 계층 > 전역 순으로 해석한다 (v0.18.0) */
export function getBudgetTokens(world, layer) {
    const override = resolveLayered('budgetTokens', world, layer);
    const raw = override !== undefined ? override : getSettings().budgetTokens;
    return clampSetting(raw, BUDGET_TOKENS_MIN, BUDGET_TOKENS_MAX, defaultSettings.budgetTokens);
}


/** 랜덤 주입 예산 — 북별 > 계층 > 전역 (v0.18.0) */
function getRandomBudget(world, layer) {
    const override = resolveLayered('randomBudgetTokens', world, layer);
    const raw = override !== undefined ? override : getSettings().randomBudgetTokens;
    return clampSetting(raw, RANDOM_BUDGET_MIN, RANDOM_BUDGET_MAX, DEFAULT_RANDOM_BUDGET);
}


/** 랜덤 주입 켜짐 여부 — 북별 > 계층 > 전역. 체크박스가 아니라 select인 이유: '미설정'을 표현해야 한다 (v0.18.0) */
function isRandomEnabled(world, layer) {
    const override = resolveLayered('randomEnabled', world, layer);
    if (override !== undefined) return override === true;
    return getSettings().randomEnabled === true;
}


/** 회수 후보 수(topK) — 북별 > 계층 > 전역 (v0.18.0) */
function getQueryTopK(world, layer) {
    const override = resolveLayered('queryTopK', world, layer);
    const raw = override !== undefined ? override : getSettings().queryTopK;
    return clampSetting(raw, TOP_K_MIN, TOP_K_MAX, DEFAULT_TOP_K);
}


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


export async function vectorInsert(worldName, items) {
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


/** 색인된 hash 목록 — 관측 뷰어의 색인 여부 대조용 (src/endpoints/vectors.js:530 POST /list → number[]) */
export async function vectorList(worldName) {
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
 * @param {Map<string,string>|null} [layerOf] 북 → 계층 표. 없으면 게터가 캐시로 조회한다 (v0.18.0)
 */
async function pickRandomEntries(worlds, excludeKeys, layerOf = null) {
    const picked = [];
    for (const world of worlds) {
        if (!isRandomEnabled(world, layerOf?.get(world))) continue; // 북별 켜기 — 전역이 켜져 있어도 이 북만 끌 수 있다
        const budget = getRandomBudget(world, layerOf?.get(world));
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
export function resetRandomCooldown() {
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
        toastr.error('Jev API 키가 필요해요. 이번 턴은 주입 없이 넘어갈게요. (폴백은 없어요)', DISPLAY_NAME);
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
        invalidateWorldLayerCache(); // 캐시 무효화 지점 ⑤ — 턴 시작. 채팅·카드·전역 구성이 바뀌었을 수 있다
        const detailed = getTargetWorldsDetailed();
        const worlds = detailed.map(d => d.name);
        // 이 턴에 쓸 북 → 계층 표. 게터에 직접 넘겨 계층 조회를 건너뛴다(한 턴에 '북 수 × 게터 수'만큼 부른다).
        const layerOf = new Map(detailed.map(d => [d.name, d.layer]));
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
                ({ metadata } = await vectorQuery(world, queryText, getQueryTopK(world, layerOf.get(world))));
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
            const randomOnly = await pickRandomEntries(worlds, new Set(), layerOf);
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
            const budget = getBudgetTokens(world, layerOf.get(world));
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
        const randomPicks = await pickRandomEntries(worlds, new Set(adopted.map(a => `${a.world}.${a.uid}`)), layerOf);
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
        toastr.error(`Jev 판정에 실패했어요: ${error?.message ?? error}. 이번 턴은 주입 없이 넘어갈게요.`, DISPLAY_NAME);
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
export async function indexWorld(world, onProgress) {
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


export async function indexLorebook() {
    const settings = getSettings();
    const worlds = getTargetWorlds();
    if (!worlds.length) {
        toastr.warning('색인할 대상이 없어요. 채팅·캐릭터·전역·페르소나 중 한 곳에 로어북을 연결하거나, 설정에서 고정 대상을 선택해 주세요.', DISPLAY_NAME);
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
            toastr.warning('색인할 항목이 없어요 (활성 상태이면서 본문이 있는 항목이 없어요).', DISPLAY_NAME);
            $status.text('');
            return;
        }

        $status.text(`색인 완료: ${worlds.length}개 로어북 / ${totalItems}개 항목 (${new Date().toLocaleTimeString()})`);
        toastr.success(`${totalItems}개 항목 색인을 마쳤어요 — ${worlds.join(', ')}`, DISPLAY_NAME);
        settings.embeddingDirty = false; // 새 임베딩 설정으로 재색인 완료 — 경고 해제
        saveSettingsDebounced();
        $('#jev_lorebook_reindex_warning').hide();
    } catch (error) {
        console.error(`${LOG} 색인 실패`, error);
        toastr.error(`색인에 실패했어요: ${error?.message ?? error}`, DISPLAY_NAME);
        $status.text('색인에 실패했어요');
    } finally {
        $button.removeClass('disabled');
    }
}

// ── 챗 → 로어북 변환 파이프라인 (v0.3) ─────────────────────────────────


/**
 * Jev 탈락 후보 표 (v0.9.1) — 접힘 블록 안에서만 그린다.
 * v0.9.0까지 '직전 턴 판정' 섹션의 본체였던 렌더를 그대로 옮겨 왔다(3축 점수 세부 = 모순위험/장면적합/최근중복).
 * 채택분은 위 주입 표에 🧠로 이미 있으니 여기서는 탈락분만 나열한다 — 같은 사건이 두 번 나오던 게 소음의 주범이었다.
 * 북별 그룹 헤더는 v0.8.0 패턴 그대로(4계층이라 여러 북이 섞인다).
 */
export function renderPanelJudgment($box, rejected) {
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


/** 임베딩 소스 셀렉트 채우기 */
export function populateEmbeddingSourceSelect() {
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
export function updateEmbeddingSourceUi() {
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

export async function renderLayerList($root = $(document)) {
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
        } else if (hasLayerOverride(layer)) {
            // 북별 값이 없을 때만 계층을 말한다 — 둘 다 띄우면 어느 게 이기는지 화면이 설명하지 못한다
            $row.append($('<span class="jev-layer-badge">').text('계층 설정 따름'));
        }
        const openWorld = () => void openOverrideSettingsPopup('world', name);
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
            const randomText = isRandomEnabled(name, layer)
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


export function populateWorldSelect($root = $(document)) {
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

export async function renderDetectionSummary() {
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
    const detailed = getTargetWorldsDetailed();
    const worlds = detailed.map(d => d.name);
    if (!worlds.length) {
        $line.text('감지된 로어북이 없어서 합계를 낼 수 없어요.');
        return;
    }
    const searchBudget = detailed.reduce((sum, d) => sum + getBudgetTokens(d.name, d.layer), 0);
    const randomBudget = detailed.reduce((sum, d) => sum + (isRandomEnabled(d.name, d.layer) ? getRandomBudget(d.name, d.layer) : 0), 0);
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
 * 계층별 설정 4행 (v0.18.0 — 팝업 A).
 *
 * 행 순서는 채팅 > 페르소나 > 캐릭터 > 전역으로 고정한다(LAYER_ORDER) — getTargetWorldsDetailed()의
 * 귀속 순서와 같아야 사용자가 "위에 있는 층이 먼저 먹는다"를 한 번만 배우면 된다.
 * 행마다 유효값 한 줄 + 톱니뿐이다. 설명은 섹션에 한 줄만 둔다(행마다 달면 같은 말이 네 번 나온다).
 * 동기 렌더 — 로어북을 읽지 않고 설정값만 쓴다(감지 목록과 달리 비동기가 필요 없다).
 *
 * @param {*} [$root] 검색 기준. 팝업을 열 때는 아직 DOM에 안 붙은 $popup을 넘긴다.
 */
function renderLayerOverrides($root = $(document)) {
    const $box = $root.find('#jev_lorebook_layer_overrides');
    if (!$box.length) return;
    $box.empty();
    for (const layer of LAYER_ORDER) {
        const $row = $('<div class="jev-layer-row">');
        $row.append($('<span class="jev-layer-badge">').text(LAYER_LABELS[layer] ?? layer));
        // world 없이 layer만 넘긴다 — 북별 예외를 섞지 않은 '이 계층의 유효값'이어야 한다
        const randomText = isRandomEnabled(undefined, layer)
            ? `랜덤 켜짐 ${getRandomBudget(undefined, layer).toLocaleString()}`
            : '랜덤 꺼짐';
        const rec = getLayerOverride(layer);
        const setCount = PER_WORLD_KEYS.filter(key => resolveOverride(rec?.[key]) !== undefined).length;
        $row.append($('<span class="jev-layer-effective">').text(
            `주입 ${getBudgetTokens(undefined, layer).toLocaleString()}`
            + ` · ${randomText}`
            + ` · 회수 ${getQueryTopK(undefined, layer)}`
            + ` — ${setCount ? `이 계층에서 ${setCount}개 정했어요` : '전부 전역값을 상속해요'}`));
        const openLayer = () => void openOverrideSettingsPopup('layer', layer);
        $row.append($('<span class="jev-layer-gear" role="button" tabindex="0">')
            .attr('title', '이 계층에 속한 로어북의 주입 예산·랜덤·회수 후보 수를 정해요')
            .append($('<i class="fa-solid fa-gear">'))
            .on('click', openLayer)
            .on('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openLayer(); }
            }));
        $box.append($row);
    }
}


/**
 * 오버라이드 설정 팝업 — 로어북 하나(v0.17.0) / 계층 하나(v0.18.0) 겸용.
 *
 * 입력칸 구성이 같으므로 popup-world.html 템플릿 **하나**를 두 모드가 함께 쓴다.
 * 템플릿을 복제하면 다음 수정에서 한쪽만 고쳐진다 — 달라지는 건 제목·설명·되돌리기 문구·상속 대상뿐이라
 * 모드 인자로 갈랐다.
 *
 * 네 칸 모두 '비우면 상속'이다. 랜덤 켜기만 select인 이유: 체크박스로는 '미설정'을 표현할 수 없다
 * — 그 층만 끄는 것(false)과 상위값을 따르는 것(미설정)은 다른 상태다.
 * 저장은 입력 즉시(saveSettingsDebounced). 값이 비면 키를 지우고, 레코드가 비면 레코드째 지운다
 * — 빈 레코드를 남기면 '설정 있음' 배지가 거짓말한다.
 *
 * ⚠ 되돌리기 문구가 모드별로 다른 이유: 북별을 지우면 **계층**값으로 내려가고(전역이 아니다),
 *   계층을 지우면 전역값으로 내려간다. 우선순위가 3단이 된 v0.18.0부터 "전역값으로 되돌리기"는
 *   북별 모드에서 거짓말이 된다.
 *
 * @param {'world'|'layer'} mode 오버라이드 단위
 * @param {string} key 로어북 이름(world 모드) 또는 계층 키(layer 모드)
 */
async function openOverrideSettingsPopup(mode, key) {
    const isLayer = mode === 'layer';
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'popup-world');
    const $popup = $(html);
    const store = isLayer ? getPerLayerStore() : getPerWorldStore();
    const rec = () => {
        const r = store[key];
        return (r && typeof r === 'object' && !Array.isArray(r)) ? r : null;
    };
    // 게터 인자쌍 — 계층 모드에서는 world를 비우고 layer만 넘긴다
    const argWorld = isLayer ? undefined : key;
    const argLayer = isLayer ? key : undefined;
    // 이 레코드를 비웠을 때 내려갈 값 — 북별은 자기 계층으로, 계층은 전역으로
    const inhLayer = isLayer ? undefined : getWorldLayer(key);

    $popup.find('#jev_world_title').text(isLayer ? `${LAYER_LABELS[key] ?? key} 계층` : key);
    $popup.find('#jev_world_help').text(isLayer
        ? '비워 두면 전역 설정값을 그대로 써요. 값을 넣은 칸만 이 계층의 로어북에서 달라져요.'
        : '비워 두면 이 로어북이 속한 계층의 값을, 계층에도 없으면 전역값을 써요. 값을 넣은 칸만 이 로어북에서 달라져요.');

    const showEffective = () => {
        $popup.find('#jev_world_effective').text(
            `지금 적용되는 값 — 주입 예산 ${getBudgetTokens(argWorld, argLayer).toLocaleString()}`
            + ` · 랜덤 ${isRandomEnabled(argWorld, argLayer) ? '켜짐' : '꺼짐'}`
            + ` · 랜덤 예산 ${getRandomBudget(argWorld, argLayer).toLocaleString()}`
            + ` · 회수 후보 ${getQueryTopK(argWorld, argLayer)}`);
    };

    const refreshLists = () => {
        void renderLayerList();
        renderLayerOverrides();
        void renderBudgetTotal();
    };

    const setKey = (field, value) => {
        let r = rec();
        if (!r) { r = {}; store[key] = r; }
        if (value === undefined) delete r[field];
        else r[field] = value;
        if (!Object.keys(r).length) delete store[key];
        saveSettingsDebounced();
        showEffective();
        refreshLists();
    };

    // 숫자 3칸 — placeholder에 '안 건드리면 되는 값'(상속값)을 찍는다. 화면에 없으면 빈칸의 뜻을 모른다.
    const numberFields = [
        { id: '#jev_world_budget', key: 'budgetTokens', min: BUDGET_TOKENS_MIN, max: BUDGET_TOKENS_MAX, fallback: getBudgetTokens(undefined, inhLayer) },
        { id: '#jev_world_random_budget', key: 'randomBudgetTokens', min: RANDOM_BUDGET_MIN, max: RANDOM_BUDGET_MAX, fallback: getRandomBudget(undefined, inhLayer) },
        { id: '#jev_world_topk', key: 'queryTopK', min: TOP_K_MIN, max: TOP_K_MAX, fallback: getQueryTopK(undefined, inhLayer) },
    ];
    const inheritLabel = isLayer ? '전역값' : '상속값';
    for (const field of numberFields) {
        const current = resolveOverride(rec()?.[field.key]);
        $popup.find(field.id)
            .attr('placeholder', `${inheritLabel} ${field.fallback.toLocaleString()}`)
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

    const $reset = $popup.find('#jev_world_reset');
    $reset.attr('title', isLayer
        ? '이 계층의 설정을 모두 지우고 전역값을 따르게 해요'
        : '이 로어북만의 설정을 모두 지우고 계층·전역 설정을 따르게 해요');
    $reset.find('span').text(isLayer ? '전역값으로 되돌리기' : '북별 설정 지우기');
    $reset.on('click', function () {
        delete store[key];
        saveSettingsDebounced();
        for (const field of numberFields) $popup.find(field.id).val('');
        $popup.find('#jev_world_random_enabled').val('');
        showEffective();
        refreshLists();
        toastr.info(isLayer
            ? `${LAYER_LABELS[key] ?? key} 계층의 설정을 지웠어요 — 이제 전역값을 따라요.`
            : `'${key}'의 설정을 지웠어요 — 이제 계층·전역 설정을 따라요.`, DISPLAY_NAME);
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
export async function openInjectionSettingsPopup() {
    const settings = getSettings();
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'popup-injection');
    const $popup = $(html);

    $popup.find('#jev_lorebook_budget').val(settings.budgetTokens).on('input', function () {
        settings.budgetTokens = clampSetting($(this).val(), BUDGET_TOKENS_MIN, BUDGET_TOKENS_MAX, defaultSettings.budgetTokens);
        saveSettingsDebounced();
        renderLayerOverrides($popup); // 계층 4행은 전역값을 상속 표시한다 — 전역이 바뀌면 같이 바뀌어야 한다
        void renderBudgetTotal($popup);
    });

    $popup.find('#jev_lorebook_random_enabled').prop('checked', settings.randomEnabled === true).on('change', function () {
        settings.randomEnabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        renderLayerOverrides($popup);
        void renderLayerList($popup);   // 행의 '랜덤 후보/쿨다운'이 켜짐 여부에 따라 바뀐다
        void renderBudgetTotal($popup);
    });

    $popup.find('#jev_lorebook_random_budget').val(getRandomBudget()).on('input', function () {
        settings.randomBudgetTokens = clampSetting($(this).val(), RANDOM_BUDGET_MIN, RANDOM_BUDGET_MAX, DEFAULT_RANDOM_BUDGET);
        saveSettingsDebounced();
        renderLayerOverrides($popup);
        void renderBudgetTotal($popup);
    });

    // topK 슬라이더 — 옆 숫자는 input에서 즉시 따라간다(놓을 때까지 모르면 조절을 못 한다)
    $popup.find('#jev_lorebook_topk').val(getQueryTopK()).on('input', function () {
        const value = clampSetting($(this).val(), TOP_K_MIN, TOP_K_MAX, DEFAULT_TOP_K);
        settings.queryTopK = value;
        $popup.find('#jev_lorebook_topk_value').text(String(value));
        saveSettingsDebounced();
        renderLayerOverrides($popup);
    });
    $popup.find('#jev_lorebook_topk_value').text(String(getQueryTopK()));

    // 감지 대상 층 on/off (v0.8.0) — 끄면 그 층의 북이 감지 목록에서 빠진다
    for (const [key, selector] of Object.entries(LAYER_INPUTS)) {
        $popup.find(selector).prop('checked', settings[key] !== false).on('change', function () {
            settings[key] = !!$(this).prop('checked');
            saveSettingsDebounced();
            invalidateWorldLayerCache(); // 캐시 무효화 지점 ③ — 감지 층 on/off로 북의 귀속 계층이 바뀐다
            void renderLayerList($popup);
            renderLayerOverrides($popup);
            void fillTopKTotal($popup);
            void renderBudgetTotal($popup);
            void renderDetectionSummary(); // 확장 탭 한 줄도 같이 따라가야 한다
        });
    }

    $popup.find('#jev_lorebook_world').on('change', function () {
        settings.world = String($(this).val());
        saveSettingsDebounced();
        invalidateWorldLayerCache(); // 캐시 무효화 지점 ④ — 고정 대상은 'fixed' 층으로 귀속이 바뀐다
        void renderLayerList($popup);
        renderLayerOverrides($popup);
        void fillTopKTotal($popup);
        void renderBudgetTotal($popup);
        void renderDetectionSummary();
    });

    populateWorldSelect($popup);
    void fillTopKTotal($popup);
    renderLayerOverrides($popup);
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
 * 패널 상태 요약의 **제브 전용 3행** (v0.19.0 — core에서 그대로 이사).
 * 단일파일 시절 renderPanelSummary 본문에 있던 줄을 한 글자도 안 고치고 옮겼다.
 * 훅으로 뺀 이유: 논제브 배포본에는 주입 예산·Jev 전송·임베딩이 아예 없다 → 행 자체가 없어야 한다.
 */
export function renderSummaryJevRows($summary, row, worlds, settings) {
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
}

