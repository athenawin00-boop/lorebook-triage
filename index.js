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
import { world_names, loadWorldInfo, METADATA_KEY, createWorldInfoEntry, saveWorldInfo, newWorldInfoEntryTemplate, updateWorldInfoList, reloadEditor } from '../../../world-info.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { getStringHash, timestampToMoment } from '../../../utils.js';
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

const QUERY_TOP_K = 30;          // 벡터 회수 후보 수 — 20으론 Jev 상위권을 놓침(2026-09-20 실측)
const SCORE_FLOOR = 0.5;         // 최종 점수 하한. 대조실험 눈금: 0.74=빼면 모순 / 0.52=장면만 맞음 / 0.37=무관
const QUERY_USER_MESSAGES = 3;   // 검색 쿼리로 쓸 최근 유저 메시지 수
const SCENE_MESSAGES = 6;        // Jev에 보여줄 최근 장면 메시지 수
const INSERT_CHUNK = 20;         // 색인 시 insert 배치 크기
const JUDGMENT_CACHE_MS = 60000; // 동일 쿼리 판정 캐시 (같은 턴의 연쇄 quiet 생성 대응)

// ── 변환 파이프라인 상수 ────────────────────────────────────────────────
const CONVERT_META_KEY = 'jevLorebookLastConverted'; // chat_metadata에 저장하는 마지막 변환 지점 (chat 배열 인덱스, exclusive)
const SLICE_TOKEN_BUDGET = 18000; // 슬라이스당 대화 토큰 상한 (지시문·응답 여유 포함해 2만 이하로)
const CORE_COMMENT = '⭐ Core Memory';   // 코어 메모리 항목 식별자 (comment 고정 = upsert 키)

// ── 스플릿(v0.4) 상수 — st_lorebook_split.py 규칙의 JS 이식 ─────────────────
// 줄머리 20자 이내 날짜 = 경계. $ 앵커 금지 — 엄격 버전은 헤더 뒤 본문 붙은 항목을 통짜로 남겼다 (실측, §4-10)
const SPLIT_DATE_RE = /^[^\S\n]*(?:#{1,4}[^\S\n]*)?(?:\*\*)?[^\n]{0,20}?(\d{4}-\d{2}-\d{2})/gm;
const SPLIT_MIN_CHUNK = 200;             // 이보다 작은 조각은 앞 덩어리에 흡수
const SPLIT_EST_CHARS_PER_TOKEN = 3;     // 한글 혼용 보수 추정 (이식 원본과 동일)
const SPLIT_BIG_CONSTANT_CHARS = 3000;   // constant 항목이 이 크기를 넘으면 기본 체크 후보 (≈1,000토큰)
const CORE_TOKEN_LIMIT = 800;            // 코어 스냅샷 상한 — 프롬프트 강제, 초과 시 경고 로그
const CORE_ORDER = 1000;                 // 코어 메모리 삽입 순서 — 일반 항목 기본값(100)보다 위
// 변환 지시문 — 현이가 손으로 쓰던 프롬프트 + 파싱용 구조 강제 + 코어 상태 스냅샷(누적 서술 아님)
const CONVERT_PROMPT = [
    'You are converting roleplay chat logs into lorebook entries.',
    'For the lorebook, summarize each incident in six or more sentences. Quote dialogue when necessary. Separate by date. Output in English.',
    '',
    'Strict output format:',
    '- Begin each incident with a header line exactly like: ### YYYY-MM-DD — <short title>',
    '- Use the [Date: ...] markers in the transcript to date each incident. If unsure, use the most recent marker before the incident.',
    '- After all incidents, output one final section starting with the exact header line: ### CORE STATE',
    '  The core state is what must NEVER be forgotten between sessions.',
    '  You are given the [Previous core state]; UPDATE it with what changed in this transcript.',
    '  Present state only, never a running log of events. If nothing changed, restate it as-is.',
    '  Format as short labeled lines — NO flowing prose, NO paragraphs:',
    '  Relationship: <the current state in one line, as it stands NOW (confession/dating/conflict/etc.)>',
    '  Dynamics: <how they treat each other now, 1-2 short lines>',
    '  Ongoing: <unresolved arcs, promises, plans — one per line, each starting with "- ">',
    '  Facts: <immutable facts: identities, secrets known/unknown, living situation — one per line, each starting with "- ">',
    '  Every line short and declarative. Keep the whole CORE STATE section under 800 tokens.',
    '- Output nothing else: no preamble, no commentary.',
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

// ── 임베딩 소스 (v0.5) — vectors 확장 지원 소스의 부분집합 ─────────────────
// 제외: ollama/llamacpp/vllm/koboldcpp(서버 URL 필요), webllm(브라우저 모듈), vertexai(인증 모드 복잡),
//       workers_ai(계정 설정 필요), extras(deprecated). 근거 → 보고서 v0.5 섹션.
// secretKey: secret_state 대조용 (vectors/index.js:1075 throwIfSourceInvalid 매핑 그대로)
// modelFromRequest: 서버 getSourceSettings가 req.body.model을 읽는 소스만 true (vectors.js:214~ 검증)
const EMBEDDING_SOURCES = {
    palm:         { label: 'Google AI Studio (Gemini)', secretKey: SECRET_KEYS.MAKERSUITE, modelFromRequest: true, defaultModel: 'gemini-embedding-001' }, // text-embedding-005는 404 — 실측
    transformers: { label: 'Local (Transformers) — 키 불필요', secretKey: null, modelFromRequest: false, defaultModel: '' },
    openai:       { label: 'OpenAI', secretKey: SECRET_KEYS.OPENAI, modelFromRequest: true, defaultModel: 'text-embedding-3-small' },
    cohere:       { label: 'Cohere', secretKey: SECRET_KEYS.COHERE, modelFromRequest: true, defaultModel: 'embed-english-v3.0' },
    mistral:      { label: 'MistralAI (모델 고정: mistral-embed)', secretKey: SECRET_KEYS.MISTRALAI, modelFromRequest: false, defaultModel: '' },
    togetherai:   { label: 'TogetherAI', secretKey: SECRET_KEYS.TOGETHERAI, modelFromRequest: true, defaultModel: 'togethercomputer/m2-bert-80M-32k-retrieval' },
    nomicai:      { label: 'NomicAI (모델 고정: nomic-embed-text-v1.5)', secretKey: SECRET_KEYS.NOMICAI, modelFromRequest: false, defaultModel: '' },
    openrouter:   { label: 'OpenRouter', secretKey: SECRET_KEYS.OPENROUTER, modelFromRequest: true, defaultModel: 'openai/text-embedding-3-large' },
    electronhub:  { label: 'Electron Hub', secretKey: SECRET_KEYS.ELECTRONHUB, modelFromRequest: true, defaultModel: 'text-embedding-3-small' },
    nanogpt:      { label: 'NanoGPT', secretKey: SECRET_KEYS.NANOGPT, modelFromRequest: true, defaultModel: 'text-embedding-3-small' },
    siliconflow:  { label: 'SiliconFlow', secretKey: SECRET_KEYS.SILICONFLOW, modelFromRequest: true, defaultModel: 'Qwen/Qwen3-Embedding-0.6B' },
    chutes:       { label: 'Chutes', secretKey: SECRET_KEYS.CHUTES, modelFromRequest: true, defaultModel: 'chutes-qwen-qwen3-embedding-8b' },
};

const CONVERT_MAX_TOKENS = 4096; // 프로필 경로(sendRequest)의 응답 상한 — 현재 연결 경로(generateRaw)는 기존처럼 현재 설정을 따른다

const defaultSettings = Object.freeze({
    enabled: false,
    jevApiKey: '',
    budgetTokens: 4000,
    world: '',
    keepRecent: 20,
    embeddingSource: 'palm',   // 기존 하드코딩(palm)과 동일한 기본값 — 동작 불변
    embeddingModel: '',        // 빈 값 = 소스별 기본 모델
    embeddingDirty: false,     // 임베딩 설정 변경 후 재색인 전 = true (경고 표시)
    convertProfileId: '',      // 빈 값 = 현재 연결 그대로 // 변환·숨김에서 제외할 최근 메시지 수 — 직전 장면은 원문으로 남아야 한다
});

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
 * 대상 로어북 결정 (v0.2): 고정 오버라이드가 없으면 **이 채팅/캐릭터에 물린 로어북만** 쓴다.
 * 전역 1개 고정은 다른 채팅에 남의 기억이 새는 구조라 기각 (2026-09-20 현이 지적).
 */
function getTargetWorlds() {
    const settings = getSettings();
    if (settings.world) return (world_names ?? []).includes(settings.world) ? [settings.world] : [];
    const ctx = SillyTavern.getContext();
    const found = [];
    const chatWorld = ctx.chatMetadata?.[METADATA_KEY];                                // 채팅에 물린 로어북
    const charWorld = ctx.characters?.[ctx.characterId]?.data?.extensions?.world;      // 캐릭터 카드 로어북
    for (const w of [chatWorld, charWorld]) {
        if (w && typeof w === 'string' && !found.includes(w) && (world_names ?? []).includes(w)) {
            found.push(w);
        }
    }
    return found;
}

/** 변환 대상 로어북 1개: 고정 오버라이드 > 채팅에 물린 것 > 캐릭터 카드 순 */
function getConversionTargetWorld() {
    const settings = getSettings();
    if (settings.world) return (world_names ?? []).includes(settings.world) ? settings.world : '';
    return getTargetWorlds()[0] ?? '';
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

        // 대상 로어북: 이 채팅/캐릭터에 물린 것만 (전역 오염 방지)
        const worlds = getTargetWorlds();
        if (!worlds.length) {
            console.log(`${LOG} 이 채팅/캐릭터에 물린 로어북 없음 — 건너뜀 (특정 로어북을 강제하려면 설정의 고정 대상)`);
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
                ({ metadata } = await vectorQuery(world, queryText, QUERY_TOP_K));
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
        toastr.warning('색인할 대상이 없어요. 이 채팅/캐릭터에 로어북을 연결하거나, 설정에서 고정 대상을 선택해 주세요.', 'Jev Lorebook');
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

/** 메시지의 날짜(YYYY-MM-DD). ST send_date 포맷이 제각각이라 timestampToMoment(utils.js:1079) 사용 */
function messageDay(message) {
    try {
        const m = timestampToMoment(message?.send_date);
        return m?.isValid?.() ? m.format('YYYY-MM-DD') : '';
    } catch {
        return '';
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
        fresh.push({
            name: String(m.name || (m.is_user ? 'User' : 'Char')),
            mes,
            day: messageDay(m),
        });
    }
    return fresh;
}

/** 메시지들을 토큰 예산 단위 슬라이스로 분할 (메시지 경계 유지) */
async function buildSlices(messages) {
    const slices = [];
    let current = [];
    let currentTokens = 0;
    for (const m of messages) {
        const line = `${m.name}: ${m.mes}`;
        const tokens = await getTokenCountAsync(line);
        if (current.length && currentTokens + tokens > SLICE_TOKEN_BUDGET) {
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
    const lines = [];
    let lastDay = '';
    for (const m of slice) {
        if (m.day && m.day !== lastDay) {
            lines.push('');
            lines.push(`[Date: ${m.day}]`);
            lastDay = m.day;
        }
        lines.push(m.line);
    }
    return lines.join('\n').trim();
}

/**
 * 변환 출력 파싱: `### YYYY-MM-DD — <title>` 헤더로 쪼개고 `Keywords: …` 줄을 분리.
 * `### CORE STATE` 이후는 코어 스냅샷으로 별도 수집 (사건 헤더가 다시 나오면 코어 종료).
 * @returns {{incidents: {date:string, title:string, keywords:string[], body:string}[], core: string}}
 */
function parseConversionOutput(text) {
    const incidents = [];
    const coreLines = [];
    const headerRe = /^#{2,4}\s*(\d{4}-\d{2}-\d{2})\s*[—–:\-]?\s*(.*)$/;
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
 * 변환용 생성 1회 — 프로필 지정 시 ConnectionManagerRequestService(shared.js:388), 아니면 현재 연결(generateRaw).
 * 프로필 실패 시 폴백하지 않는다 — 유저가 고른 프로필을 조용히 비싼 현재 연결로 바꾸는 건 배신이다.
 */
async function generateConversion(ctx, userPrompt) {
    const settings = getSettings();
    if (!settings.convertProfileId) {
        return await ctx.generateRaw({ prompt: userPrompt, systemPrompt: CONVERT_PROMPT });
    }
    let profileName = settings.convertProfileId;
    try {
        profileName = ConnectionManagerRequestService.getProfile(settings.convertProfileId)?.name ?? profileName;
    } catch { /* 이름 조회 실패는 치명 아님 — id로 표기 */ }
    // 메시지 배열은 텍스트 컴플리션 프로필에서도 동작한다 (custom-request.js:293 Array.isArray 분기 → instruct 조립)
    const result = await ConnectionManagerRequestService.sendRequest(
        settings.convertProfileId,
        [
            { role: 'system', content: CONVERT_PROMPT },
            { role: 'user', content: userPrompt },
        ],
        CONVERT_MAX_TOKENS,
    );
    const text = typeof result === 'string' ? result : String(result?.content ?? '');
    if (!text.trim()) {
        throw new Error(`변환 프로필(${profileName})의 응답이 비어 있어요`);
    }
    return text;
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

/** 변환 프로필 표시명 — 패널·상태줄용 */
function getConvertProfileLabel() {
    const settings = getSettings();
    if (!settings.convertProfileId) return '현재 연결 그대로';
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
 * - 코어: 슬라이스마다 [Previous core state]를 주고 갱신 → 마지막 코어를 constant 항목으로 upsert (ST 네이티브 매턴 주입)
 * - 저장: createWorldInfoEntry(uid 자동 할당) → saveWorldInfo → 변환 지점 saveMetadata → 자동 색인 → 성공 후에만 원본 구간 숨김
 * - 실패 시: 항목·변환 지점 미저장·숨김 없음 (전량 성공 후에만 쓴다) → 재실행하면 같은 범위 재시도
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
    try {
        // 0. 로어북 선로드 — 이전 코어 상태를 읽어 프롬프트에 넣는다 (누적 서술이 아니라 스냅샷 갱신)
        const worldData = await loadWorldInfo(world);
        if (!worldData?.entries) {
            throw new Error(`로어북 '${world}' 로드 실패`);
        }
        let coreState = String(findCoreEntry(worldData)?.content ?? '').trim();

        setStatus('슬라이스 계산 중…');
        const slices = await buildSlices(fresh);
        console.log(`${LOG} 변환 시작 — 대상='${world}' 메시지 ${fresh.length}건(인덱스 ${startIndex}~${endIndex}, 최근 ${keepRecent}개 보존) → 슬라이스 ${slices.length}개 / 이전 코어 ${coreState ? '있음' : '없음'}`);

        // 1. 슬라이스별 메인 API 생성 (순차 — 코어 상태를 다음 슬라이스로 이어받는다)
        const incidents = [];
        for (let i = 0; i < slices.length; i++) {
            setStatus(`요약 생성 중… ${i + 1}/${slices.length} (${getConvertProfileLabel()})`);
            const transcript = sliceToTranscript(slices[i]);
            const prompt = `[Previous core state]\n${coreState || '(none)'}\n\n[Transcript]\n${transcript}`;
            const raw = await generateConversion(ctx, prompt);
            const parsed = parseConversionOutput(raw);
            if (!parsed.incidents.length) {
                console.warn(`${LOG} 슬라이스 ${i + 1}/${slices.length} — 출력 ${String(raw ?? '').length}자에서 사건 헤더 0건 (형식 불일치)`);
            } else {
                console.log(`${LOG} 슬라이스 ${i + 1}/${slices.length} — 사건 ${parsed.incidents.length}건 파싱 / 코어 ${parsed.core ? '갱신' : '유지'}`);
            }
            incidents.push(...parsed.incidents);
            if (parsed.core) coreState = parsed.core; // 마지막 유효 코어가 최종 스냅샷
        }
        if (!incidents.length) {
            throw new Error('출력에서 사건 헤더(### YYYY-MM-DD — 제목)를 하나도 찾지 못했어요 — 항목과 변환 지점은 저장하지 않았어요');
        }

        // 2. 로어북 항목 추가 — createWorldInfoEntry가 uid를 충돌 없이 할당 (world-info.js:4057)
        setStatus(`로어북 항목 생성 중… ${incidents.length}건`);
        for (const inc of incidents) {
            const entry = createWorldInfoEntry(world, worldData);
            if (!entry) {
                throw new Error('로어북 항목 uid 할당 실패');
            }
            // 키워드 발동은 쓰지 않는다 — 발동 경로는 Jev(FORCE_ACTIVATE) 단일.
            // 키를 달면 ST 재귀 스캔이 본문의 이름·날짜를 물고 연쇄 발동하는데,
            // world_info_max_recursion_steps=0이면 제동이 아예 안 걸려 예산 상한까지 퍼붓는다. (2026-09-20)
            entry.key = [];
            entry.comment = `${inc.title} · ${inc.date}`;
            entry.content = inc.body;
            entry.constant = false;
            entry.disable = false;
        }

        // 2b. 코어 메모리 upsert — constant:true = ST가 매턴 네이티브 주입 (Jev 판정·색인 밖 — 설계 의도)
        if (coreState) {
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
            console.warn(`${LOG} 출력에 CORE STATE 섹션 없음 — 코어 항목 미갱신`);
        }

        await saveWorldInfo(world, worldData, true);
        reloadEditor(world); // 에디터에 이 로어북이 열려 있으면 실시간 갱신 (world-info.js:1040, 강제 오픈 없음)

        // 3. 변환 지점 기록 (chat_metadata — 이 채팅에만 귀속)
        ctx.chatMetadata[CONVERT_META_KEY] = endIndex;
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
        setStatus(`완료: 사건 ${incidents.length}건 추가 · 코어 ${coreState ? '갱신' : '미갱신'} · ${indexed}개 색인 · 메시지 ${hiddenCount}개 변환·숨김, 최근 ${keepRecent}개 유지 (${ms}ms)`);
        toastr.success(`변환을 마쳤어요: 사건 ${incidents.length}건 · 메시지 ${hiddenCount}개 숨김 · 최근 ${keepRecent}개는 원문 유지 — ${world}. 여기를 누르면 에디터에서 바로 확인할 수 있어요.`, 'Jev Lorebook', { onclick: () => openWorldEditor(world), timeOut: 10000 });
        console.log(`${LOG} 변환 완료 — 사건 ${incidents.length}건 / 변환 지점 ${startIndex}→${endIndex} / 숨김 ${hiddenCount}개 / ${ms}ms`);
    } catch (error) {
        console.error(`${LOG} 변환 실패`, error);
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
        toastr.error('대상 로어북이 없어요. 이 채팅/캐릭터에 로어북을 연결하거나 고정 대상을 설정해 주세요.', 'Jev Lorebook');
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
    const worlds = getTargetWorlds();
    const convertWorld = getConversionTargetWorld();
    const chatLength = (ctx.chat ?? []).length;
    const converted = Math.max(0, Number(ctx.chatMetadata?.[CONVERT_META_KEY]) || 0);

    const $summary = $panel.find('#jev_panel_summary').empty();
    const row = (label, value) => $('<div class="jev-panel-row">')
        .append($('<span class="jev-panel-label">').text(label))
        .append($('<span>').text(value));
    $summary.append(row('상태', settings.enabled ? '켜짐' : '꺼짐'));
    $summary.append(row('대상 로어북', worlds.length ? `${settings.world ? '고정' : '자동'}: ${worlds.join(', ')}` : '없음 (채팅/캐릭터에 연결된 로어북이 없어요)'));
    $summary.append(row('턴당 예산', `${Number(settings.budgetTokens) || defaultSettings.budgetTokens}토큰`));
    $summary.append(row('전송', jevTransport ? jevTransport.label : (lastTransportError ? `없음 — ${lastTransportError}` : '미감지 (첫 생성 때 자동으로 감지해요)')));
    const embedMeta = EMBEDDING_SOURCES[settings.embeddingSource] ?? EMBEDDING_SOURCES.palm;
    const embedModel = embedMeta.modelFromRequest ? (String(settings.embeddingModel || '').trim() || embedMeta.defaultModel) : '(서버 고정)';
    const embedKey = embedMeta.secretKey === null ? '키 불필요' : (secret_state[embedMeta.secretKey] ? '키 등록됨 ✓' : '키 미등록 ✗');
    $summary.append(row('임베딩', `${embedMeta.label} · ${embedModel} · ${embedKey}${settings.embeddingDirty ? ' · ⚠ 재색인 필요' : ''}`));
    $summary.append(row('변환 프로필', getConvertProfileLabel()));
    const keepRecent = Number.isFinite(Number(settings.keepRecent)) ? Math.max(0, Number(settings.keepRecent)) : defaultSettings.keepRecent;
    $summary.append(row('변환 대상', convertWorld || '없음'));
    $summary.append(row('변환 지점', `${converted}/${chatLength} 메시지 (다음 변환: ${Math.max(0, chatLength - keepRecent - converted)}건, 최근 ${keepRecent}개 보존)`));
}

/** 직전 턴 판정 리포트 렌더 */
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
        + ` — 대상: ${lastReport.worlds.join(', ')}`;
    $box.append($('<div class="jev-panel-muted">').text(meta));

    const $table = $('<table class="jev-panel-table">');
    const $thead = $('<tr>');
    for (const h of ['채택', '월드', 'uid', '제목', '모순위험', '장면적합', '최근중복', '최종', '토큰']) {
        $thead.append($('<th>').text(h));
    }
    $table.append($('<thead>').append($thead));
    const $tbody = $('<tbody>');
    for (const r of lastReport.rows) {
        const $tr = $('<tr>').toggleClass('jev-adopted', r.adopted);
        $tr.append($('<td>').text(r.adopted ? '✓' : ''));
        $tr.append($('<td>').text(String(r.world).slice(0, 16)));
        $tr.append($('<td>').text(r.uid));
        $tr.append($('<td class="jev-cell-title">').text(String(r.title).slice(0, 48)));
        $tr.append($('<td>').text(r.contradiction.toFixed(2)));
        $tr.append($('<td>').text(r.sceneFit.toFixed(2)));
        $tr.append($('<td>').text(r.duplicate.toFixed(2)));
        $tr.append($('<td>').text(r.final.toFixed(3)));
        $tr.append($('<td>').text(r.tokens ?? '—'));
        $tbody.append($tr);
    }
    $table.append($tbody);
    $box.append($table);
}

/** 색인 현황 렌더 — 로어북 항목 hash를 /api/vector/list 결과와 대조 */
async function renderPanelChunks($panel) {
    const $box = $panel.find('#jev_panel_chunks').empty();
    const worlds = getTargetWorlds();
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
        for (const h of ['색인', 'uid', '제목', '날짜키', '≈토큰']) {
            $thead.append($('<th>').text(h));
        }
        $table.append($('<thead>').append($thead));
        const $tbody = $('<tbody>');
        for (const e of entries) {
            const content = String(e.content ?? '');
            const hash = getStringHash(content);
            const isIndexed = indexedHashes ? indexedHashes.has(Number(hash)) : false;
            if (isIndexed) indexedCount++;
            const keys = Array.isArray(e.key) ? e.key : [];
            const $tr = $('<tr>').toggleClass('jev-missing', indexedHashes ? !isIndexed : false);
            $tr.append($('<td>').text(indexedHashes ? (isIndexed ? '✓' : '✗') : '?'));
            $tr.append($('<td>').text(e.uid));
            $tr.append($('<td class="jev-cell-title">').text(String(e.comment || `uid ${e.uid}`).slice(0, 48)));
            $tr.append($('<td>').text(String(keys[0] ?? '')));
            $tr.append($('<td>').text(Math.max(1, Math.round(content.length / 4)))); // 대략치 (chars/4)
            $tbody.append($tr);
        }
        $table.append($tbody);

        const headline = listError
            ? `${world} — 항목 ${entries.length}개 / 색인 대조에 실패했어요: ${listError}`
            : `${world} — 항목 ${entries.length}개 / 색인 ${indexedCount}개 / 미색인 ${entries.length - indexedCount}개`
              + (indexedHashes ? ` (벡터 저장소 ${indexedHashes.size}건)` : '')
              + (disabledCount ? ` · 비활성/빈 항목 ${disabledCount}개 제외` : '');
        $section.append($('<div class="jev-panel-world-title">').text(headline));

        // 코어 메모리 섹션 — constant라 ST가 매턴 네이티브 주입, Jev 판정·벡터 색인 제외
        if (coreEntries.length) {
            const $core = $('<div class="jev-panel-core">');
            $core.append($('<div class="jev-panel-core-title">').text(`⭐ 코어 메모리 ${coreEntries.length}개 — 매 턴 항상 주입돼요 (constant, Jev 판정을 거치지 않아요)`));
            for (const e of coreEntries) {
                const content = String(e.content ?? '');
                $core.append($('<div class="jev-panel-row">')
                    .append($('<span class="jev-panel-label">').text(String(e.comment || `uid ${e.uid}`).slice(0, 32)))
                    .append($('<span>').text(`≈${Math.max(1, Math.round(content.length / 4))}토큰 · uid ${e.uid}`)));
            }
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

/** 선택 소스의 키 상태·모델 입력칸 상태 갱신 */
function updateEmbeddingSourceUi() {
    const settings = getSettings();
    const meta = EMBEDDING_SOURCES[settings.embeddingSource] ?? EMBEDDING_SOURCES.palm;
    const $status = $('#jev_lorebook_key_status');
    if (meta.secretKey === null) {
        $status.text('로컬 소스라 API 키가 필요 없어요.').removeClass('jev-key-missing');
    } else if (secret_state[meta.secretKey]) {
        $status.text('키 등록됨 ✓').removeClass('jev-key-missing');
    } else {
        $status.text('키 미등록 — SillyTavern의 API 연결 화면에서 키를 등록해 주세요.').addClass('jev-key-missing');
    }
    const $model = $('#jev_lorebook_embed_model');
    $model.prop('disabled', !meta.modelFromRequest);
    $model.attr('placeholder', meta.modelFromRequest ? `비우면 기본값: ${meta.defaultModel}` : '이 소스는 모델이 서버에서 고정돼요');
    $('#jev_lorebook_reindex_warning').toggle(!!settings.embeddingDirty);
}

/** 변환 프로필 셀렉트 채우기 — connection-manager 비활성이면 행 숨김(현재 연결 그대로 동작) */
function populateConvertProfiles() {
    const settings = getSettings();
    const $row = $('#jev_lorebook_profile_row');
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles(); // shared.js:525
        const $select = $('#jev_lorebook_convert_profile');
        $select.empty().append($('<option>').val('').text('— 현재 연결 그대로 —'));
        for (const p of profiles) {
            $select.append($('<option>').val(p.id).text(p.name || p.id));
        }
        $select.val(settings.convertProfileId || '');
        $row.show();
    } catch (error) {
        console.log(`${LOG} connection-manager 비활성 — 변환 프로필 선택 숨김 (현재 연결 그대로): ${error?.message ?? error}`);
        $row.hide();
    }
}

function populateWorldSelect() {
    const settings = getSettings();
    const $select = $('#jev_lorebook_world');
    $select.empty().append('<option value="">— 자동: 이 채팅/캐릭터에 연결된 로어북 —</option>');
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
    });

    $('#jev_lorebook_keep_recent').val(settings.keepRecent).on('input', function () {
        const value = Number($(this).val());
        settings.keepRecent = Number.isFinite(value) && value >= 0 ? value : defaultSettings.keepRecent;
        saveSettingsDebounced();
    });

    $('#jev_lorebook_index').on('click', indexLorebook);

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

    populateWorldSelect();
    if (event_types.WORLDINFO_UPDATED) {
        eventSource.on(event_types.WORLDINFO_UPDATED, populateWorldSelect);
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
