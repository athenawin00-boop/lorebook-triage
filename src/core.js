/**
 * 공용 코어 — 제브 로어북 / 논제브 로어북 **양쪽 배포본에서 바이트 동일**한 파일이다 (v0.19.0).
 *
 * 담는 것: 챗 → 로어북 변환 파이프라인 전부(슬라이스·파서·코어 Rules/Diary·봉인·강등·Ongoing 이월·
 * 검산·잘림감지·작중날짜/앵커) / 되돌리기 / 기존 항목 스플릿 / 헤더 마이그레이션 / 챗 적치 막대 /
 * 요술봉 패널의 공용부 / 항목 3상태 순환 / 로어북 매니저 번역 읽기 / 설정 기반부 / 대상 로어북 감지.
 *
 * 담지 않는 것: Jev 판정·벡터/임베딩·랜덤 주입·파라미터 오버라이드(→ src/jev.js),
 * 변환 시작 팝업(→ src/keeper.js). 그쪽으로 가는 호출은 전부 src/hooks.js를 경유한다.
 *
 * ⚠️ 이 파일을 고치면 양쪽 배포본이 같이 바뀐다. 한쪽에만 필요한 동작은 훅으로 빼라.
 * ⚠️ chat_metadata 키 상수(CONVERT_META_KEY·STORY_ANCHOR_META_KEY·UNDO_META_KEY)는 값이 `jevLorebook*`
 *    그대로다 — 두 확장이 같은 이력을 공유해서 갈아타도 변환 지점·되돌리기가 이어지게 하는 게 사양이다.
 *    flavor화하면 갈아탄 사용자의 변환 지점이 리셋된다.
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../../extensions.js';
import { world_names, loadWorldInfo, METADATA_KEY, createWorldInfoEntry, saveWorldInfo, newWorldInfoEntryTemplate, updateWorldInfoList, reloadEditor, selected_world_info, world_info } from '../../../../world-info.js';
import { power_user } from '../../../../power-user.js';
import { getTokenCountAsync } from '../../../../tokenizers.js';
import { getStringHash, timestampToMoment, getCharaFilename } from '../../../../utils.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { hideChatMessageRange } from '../../../../chats.js';
import { MODULE, TEMPLATE_PATH, LOG, DISPLAY_NAME, PEER_MODULE, PEER_DISPLAY_NAME, PEER_GLOBAL_MARKER } from './flavor.js';
import { hooks } from './hooks.js';

// ── flavor 훅 경계 (v0.19.0) ─────────────────────────────────────────────
// core는 flavor 전용부(src/jev.js·src/keeper.js)를 **직접 import하지 않는다**(순환 방지).
// 아래는 단일파일 시절 제브 전용 함수와 **같은 이름의 얇은 위임자**다 — 이름을 그대로 둔 덕에
// 옮겨온 함수 본문을 한 줄도 고치지 않았다(리팩터 = 이동, 재작성 아님).
// 훅이 없는 배포본(논제브)에서는 임베딩·벡터 호출이 0회가 되도록 안전한 기본값으로 착지한다.
export const EMPTY_KEY_SET = new Set();
export const indexWorld = (world, onProgress) => hooks.indexWorld ? hooks.indexWorld(world, onProgress) : Promise.resolve(0);
export const vectorInsert = (world, items) => hooks.onEntryDemoted ? hooks.onEntryDemoted(world, items) : Promise.resolve(null);
export const vectorList = (world) => hooks.vectorList ? hooks.vectorList(world) : Promise.resolve(null);
export const getBudgetTokens = (world, layer) => hooks.budgetTokens ? hooks.budgetTokens(world, layer) : 0;
export const renderPanelJudgment = ($box, rejected) => hooks.renderPanelJudgment?.($box, rejected);
export const openInjectionSettingsPopup = () => hooks.openInjectionSettings?.();

// ── 항목 키 정제 (v0.19.0) ───────────────────────────────────────────────
// 변환 파서는 v0.6.0부터 모델의 `Keywords:` 줄을 읽어 **버리고** 있었다(배관은 살아 있었다).
// 그 배관을 살려 `inc.keys`로 돌려준다. 소비는 flavor가 결정한다:
//   - 제브 로어북  : 소비하지 않는다. 항목은 계속 `key: []`다(발동은 Jev 단일 경로, v0.6.0 결정 유지).
//   - 논제브 로어북: 변환 시작 팝업에서 「초록불 + AI 키워드」를 고른 경우에만 소비한다.
// 왜 영어 단일 단어만인가: ST `world_info_match_whole_words`가 기본 켜짐이라 두 단어 구절은
// 실채팅에서 거의 안 걸리고(실측 — `['club zion']`이 "클럽 zion에 가?"에 불발), 한글은 형태소가
// 붙어 원형 매칭이 깨진다. 범용어는 매 턴 걸려서 선별을 무의미하게 만든다.
const ENTRY_KEY_RE = /^[A-Za-z][A-Za-z'-]*$/;
export const ENTRY_KEY_MAX = 5;
const ENTRY_KEY_STOPWORDS = new Set([
    'love', 'night', 'day', 'time', 'he', 'she', 'it', 'they', 'him', 'her', 'them', 'his', 'hers',
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'this', 'that', 'these', 'those',
    'good', 'bad', 'new', 'old', 'big', 'small', 'man', 'woman', 'boy', 'girl', 'people', 'person',
    'thing', 'things', 'place', 'room', 'home', 'house', 'work', 'life', 'world', 'way',
    'today', 'tonight', 'yesterday', 'tomorrow', 'morning', 'evening', 'now', 'here', 'there',
    'i', 'you', 'we', 'me', 'us', 'my', 'your', 'our', 'is', 'are', 'was', 'were', 'be', 'been',
]);

/**
 * 모델이 준 키워드 후보를 항목 키로 쓸 수 있는 것만 남긴다 — 순수 함수(단위검증 대상).
 * 영어 단일 단어 → 소문자 정규화 → 스톱워드 제거 → 중복 제거 → 상한 ENTRY_KEY_MAX.
 * 입력이 배열이 아니거나(파서 실패) 빈 경우엔 빈 배열이다 — 호출부가 길이만 보면 된다.
 */
export function sanitizeEntryKeys(raw) {
    const out = [];
    for (const item of (Array.isArray(raw) ? raw : [])) {
        const word = String(item ?? '').trim();
        if (!ENTRY_KEY_RE.test(word)) continue;          // 구절·한글·기호 섞임 전부 탈락
        const key = word.toLowerCase();
        if (ENTRY_KEY_STOPWORDS.has(key)) continue;
        if (out.includes(key)) continue;
        out.push(key);
        if (out.length >= ENTRY_KEY_MAX) break;
    }
    return out;
}

// ── 상호 배제 (v0.19.0) ──────────────────────────────────────────────────
// 자매 배포본(제브 / 논제브)은 같은 로어북·같은 chat_metadata 이력에 손을 댄다.
// 둘이 동시에 켜져 있으면 변환 지점과 되돌리기 스냅샷이 서로를 덮는다 → 한쪽만 켜도록 막는다.

/**
 * 상대 확장이 **실제로 활성인가.**
 * 🔑 `extension_settings` 단독 판정은 확장을 지운 뒤 남은 설정으로 오탐한다(설정은 확장 폴더가 아니라
 * ST settings.json에 살아서 폴더를 삭제해도 안 날아간다 — v0.5 실측). 그래서 런타임 로드 마커와 AND로 건다.
 */
export function isPeerActive() {
    if (!globalThis[PEER_GLOBAL_MARKER]) return false;
    return extension_settings?.[PEER_MODULE]?.enabled === true;
}

/**
 * 상대가 켜져 있으면 막고, 원클릭 전환을 제안한다.
 * @param {'enable'|'convert'} action 무엇을 하려다 막혔는지 (문구 분기용)
 * @returns {Promise<boolean>} 계속 진행해도 되는가
 */
export async function guardPeerExclusive(action) {
    if (!isPeerActive()) return true;
    const $content = $('<div>').append(
        $('<p>').text(`${PEER_DISPLAY_NAME}이 켜져있어요. 끄고 사용이 가능해요.`),
        $('<p class="jev-panel-muted">').text(action === 'convert'
            ? '두 확장이 같은 로어북과 같은 변환 이력을 쓰기 때문에, 둘 다 켜두면 변환 지점과 되돌리기 기록이 서로를 덮어써요.'
            : '두 확장은 같은 변환 이력을 공유해요. 한 번에 하나만 켜 주세요.'),
    );
    const result = await callGenericPopup($content, POPUP_TYPE.CONFIRM, '', {
        okButton: `${PEER_DISPLAY_NAME} 끄고 ${DISPLAY_NAME} 켜기`,
        cancelButton: '그만두기',
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return false;
    // 원클릭 전환 — 상대를 끄고 이쪽을 켠다. 두 네임스페이스는 별개라 서로의 값을 망가뜨리지 않는다.
    if (extension_settings?.[PEER_MODULE]) extension_settings[PEER_MODULE].enabled = false;
    getSettings().enabled = true;
    saveSettingsDebounced();
    toastr.success(`${PEER_DISPLAY_NAME}을 끄고 ${DISPLAY_NAME}을 켰어요. 상대 확장 화면은 새로고침하면 반영돼요.`, DISPLAY_NAME);
    return true;
}

/**
 * 이 항목이 **직전 턴 프롬프트에 들어갔나** (v0.19.0 — 발동 배지).
 * 근거는 이미 구독 중인 `WORLD_INFO_ACTIVATED` 스냅샷 하나뿐이다(world-info.js:902, dryRun 아닐 때만).
 * ⚠️ 어느 **키가** 걸렸는지는 표시하지 않는다 — 그건 ST가 알려주지 않아 우리가 재매칭해야 하고,
 * 재매칭 결과는 ST의 실제 판정(정규식·whole words·대소문자·sticky)과 어긋날 수 있다. 발주 기각 사항.
 */
export function isRecentlyActivated(world, uid) {
    if (!lastActivated || !Array.isArray(lastActivated.entries)) return false;
    return lastActivated.entries.some(e => String(e.world) === String(world) && String(e.uid) === String(uid));
}


export const DEFAULT_TOP_K = 30;        // 벡터 회수 후보 수 기본값 — 20으론 Jev 상위권을 놓침(2026-09-20 실측). v0.7.0에서 설정(20~50)으로 개방

// ── 변환 파이프라인 상수 ────────────────────────────────────────────────
export const CONVERT_META_KEY = 'jevLorebookLastConverted'; // chat_metadata에 저장하는 마지막 변환 지점 (chat 배열 인덱스, exclusive)

// 작중 날짜 앵커 (v0.7.0) — 실제 send_date가 아니라 '이야기 속 날짜'의 기준점. 이 채팅에만 귀속.
// send_date는 "내가 언제 쳤나"라 작중 시간과 무관하다 — 하루에 작중 3개월을 쓸 수도 있다 (현이 지적, 2026-09-20)
export const STORY_ANCHOR_META_KEY = 'jevLorebookStoryAnchor';

// 직전 변환 되돌리기 스냅샷 (v0.11.0) — chat_metadata에 두어 이 채팅에만 귀속시킨다.
// 변환은 다섯 가지를 한꺼번에 바꾼다(항목 추가 / 코어 덮어쓰기 / 변환 지점 / 작중 앵커 / 원본 숨김).
export const UNDO_META_KEY = 'jevLorebookUndo';

export const DEFAULT_SLICE_TOKENS = 18000; // 슬라이스당 대화 토큰 상한 기본값. v0.7.0에서 설정으로 개방

export const REAL_GAP_HOURS = 6;           // 실제 시간이 이만큼 벌어지면 전사에 장면 경계 힌트를 남긴다 (약한 힌트일 뿐)

// v0.13.0 — 코어 2층화(규칙/일기). 기존 단일 '⭐ Core Memory'는 레거시 식별자로만 남긴다(마이그레이션 입력용).
export const LEGACY_CORE_COMMENT = '⭐ Core Memory';        // 레거시 통짜 코어 — 마이그레이션 입력 + archived 표시 대상

export const LEGACY_CORE_ARCHIVED_SUFFIX = ' (archived)';   // 마이그레이션 후 레거시 항목에 붙이는 표시 (disable=true와 함께)

export const CORE_RULES_COMMENT = '⭐ Core Rules';           // 코어 규칙 항목 — 항상 1개, upsert 키(comment 완전일치)

export const CORE_DIARY_COMMENT_PREFIX = '⭐ Core Diary';    // 코어 일기 항목 comment 접두사 — 뒤에 '(sealed)'?·시작~종료일이 붙는다

export const DIARY_ARCHIVE_COMMENT_PREFIX = 'Diary Archive'; // 강등된(구) 일기 comment 접두사 — ⭐를 떼어 코어 계열 스캔에서 확실히 빠지게 한다


// ── 본문 날짜 헤더 (v0.12.0) ────────────────────────────────────────────
// ST는 주입 조립에 entry.content만 넣는다 (world-info.js:5095 `WIBeforeEntries.unshift(content)`).
// comment(제목)는 편집창·내보내기 전용이라 프롬프트에 절대 닿지 않는다 → v0.11.0까지 저장된 항목은
// 날짜가 comment에만 있어서 ① 모델이 사건 순서를 못 읽고 ② content만 임베딩하니 시기 쿼리 회수도 안 됐다.
// 변환 출력 헤더(`### YYYY-MM-DD — 제목`)와 같은 형식으로 본문 머리에 박아 왕복 구조를 일치시킨다.
export const INCIDENT_HEADER_RE = /^#{2,4}\s*\d{4}-\d{2}-\d{2}/;

// comment 형식 `제목 · YYYY-MM-DD[ #N]` 역파싱 — 마이그레이션이 날짜·제목을 여기서 긁는다
export const COMMENT_META_RE = /^(.*?)\s*·\s*(\d{4}-\d{2}-\d{2})(?:\s*#\s*\d+)?\s*$/;

// 날짜가 두 번 박힌 레거시 comment가 실재한다 — `ㅅㅃㄹ 1 · 2025-01-18 · 2025-01-18` (v0.4 스플릿 산물, 2026-09-20 실측 4건).
// 그대로 두면 헤더가 `### 2025-01-18 — ㅅㅃㄹ 1 · 2025-01-18`로 나온다 → 제목 꼬리의 날짜를 전부 벗긴다.
export const COMMENT_DATE_TAIL_RE = /\s*·\s*\d{4}-\d{2}-\d{2}(?:\s*#\s*\d+)?\s*$/;


/** comment에서 제목만 — 말미에 붙은 날짜 꼬리를 남지 않을 때까지 벗긴다 */
export function stripDateTail(title) {
    let out = String(title ?? '').trim();
    let prev;
    do { prev = out; out = out.replace(COMMENT_DATE_TAIL_RE, '').trim(); } while (out !== prev);
    return out;
}


/** 사건 항목 본문 = 날짜 헤더 + 본문. 저장·주입·임베딩이 전부 이 문자열 하나를 쓴다 */
export function buildIncidentContent(date, title, body) {
    return `### ${date} — ${title}\n${body}`;
}


// ── 스플릿(v0.4) 상수 — st_lorebook_split.py 규칙의 JS 이식 ─────────────────
// 줄머리 20자 이내 날짜 = 경계. $ 앵커 금지 — 엄격 버전은 헤더 뒤 본문 붙은 항목을 통짜로 남겼다 (실측, §4-10)
export const SPLIT_DATE_RE = /^[^\S\n]*(?:#{1,4}[^\S\n]*)?(?:\*\*)?[^\n]{0,20}?(\d{4}-\d{2}-\d{2})/gm;

export const SPLIT_MIN_CHUNK = 200;             // 이보다 작은 조각은 앞 덩어리에 흡수

export const SPLIT_EST_CHARS_PER_TOKEN = 3;     // 한글 혼용 보수 추정 (이식 원본과 동일)

export const SPLIT_BIG_CONSTANT_CHARS = 3000;   // constant 항목이 이 크기를 넘으면 기본 체크 후보 (≈1,000토큰)

export const CORE_RULES_TOKEN_LIMIT = 400;      // 규칙 섹션 상한 — 프롬프트 강제 (v0.13.0, 기존 CORE_TOKEN_LIMIT 800을 규칙/일기로 분리)

export const CORE_DIARY_TOKEN_LIMIT = 600;      // 일기 섹션 상한 — 갱신 직후 이걸 넘으면 그 즉시 봉인(sealed)한다

export const CORE_DIARY_MAX_COUNT = 3;          // 슬라이딩 일기 개수 상한 — 넘으면 가장 오래된 것을 검색층으로 강등

export const CORE_RULES_ORDER = 1000;           // 코어 규칙 삽입 순서 — 최상단(일반 항목 기본값 100보다 위). 수동 승격(🔵)도 이 값을 쓴다

export const CORE_DIARY_ORDER_BASE = 999;       // 코어 일기 삽입 순서 기준 — 규칙 바로 아래. 오래된 것일수록 값이 크다(recomputeDiaryOrders)

export const NORMAL_ORDER = 100;                // 일반(검색층) 항목 순서 — 코어에서 강등할 때 되돌리는 값

// 문장 종결부호 — 응답 끝줄이 이걸로 안 끝나면 잘림 의심 (프로필·현재연결 양쪽 공통 휴리스틱)
export const SENTENCE_END_RE = /[.!?"”'’)」』]$/;

export const TRUNCATION_RATIO = 0.95;           // 응답 토큰이 상한의 이 비율을 넘으면 잘림 의심 (v0.7.0)


// ── 변환 프롬프트 (v0.7.0에서 2분할) ──────────────────────────────────
// 하나였던 CONVERT_PROMPT를 '스타일부(유저 편집 가능)'와 '계약부(잠금)'으로 갈랐다.
// 이유: 문체를 바꾸고 싶다는 요구는 잦은데, 출력 형식을 같이 건드리면 파서가 통째로 죽는다.
// 형식은 코드가 의존하는 계약이라 유저 손이 닿으면 안 된다.
export const DEFAULT_CONVERT_STYLE = [
    'You are converting roleplay chat logs into lorebook entries.',
    'Summarize each incident in six or more sentences. Quote dialogue when necessary. Output in English.',
].join('\n');


/**
 * 사건 추출용 system prompt 조립 — 스타일부(유저) + 계약부(잠금).
 * 작중 날짜(in-story date)를 쓰게 한다: send_date는 "내가 언제 쳤나"라 작중 시간과 무관하다.
 * 번호는 여기서 금지하고 코드 후처리로 붙인다 — 모델은 슬라이스마다 1부터 다시 세서 중복 번호를 만든다.
 */
export function buildIncidentsPrompt(style, incidentMaxTokens, anchor) {
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
export const RULES_PROMPT = [
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


export const DIARY_PROMPT = [
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


/**
 * 이번 턴 ST가 실제로 주입한 엔트리 (v0.9.0) — WORLD_INFO_ACTIVATED 구독 결과.
 * world-info.js:902에서 isDryRun이 아닐 때만 emit되고, 인자는 활성화된 **전체** 엔트리 배열이다
 * (우리 FORCE_ACTIVATE 채택분 + 키워드·sticky·데코레이터·constant 전부).
 * 패널의 나머지 표는 전부 "우리 판정"이라, 프롬프트에 실제로 뭐가 들어갔는지는 여기서만 보인다.
 * 최신 1턴만 보관. 엔트리 객체는 ST가 재사용할 수 있어 필요한 필드만 스냅샷으로 복사한다.
 */
export let lastActivated = null; // { ts, entries: [{ world, uid, comment, content, constant }] }

/** 변환 진행 중 플래그 — generateRaw는 인터셉터를 안 타지만(검증: script.js:4063→generateRawData 직행) 이중 실행·오발동 보험 */
export let conversionInProgress = false;

/**
 * 직전 변환에서 모인 경고 — 패널 표시용 (v0.7.0).
 * 토스트는 몇 초 뒤면 사라지는데 "잘렸을지도 모른다"는 나중에 확인하고 싶은 정보라 남긴다.
 */
export let lastConvertWarnings = [];

// 설정 숫자칸 범위 — UI(min/max)와 읽기 쪽 클램프가 같은 값을 써야 한다 (UI만 막으면 수동 설정 파일 편집을 못 막는다)
export const SLICE_TOKENS_MIN = 2000;

export const SLICE_TOKENS_MAX = 60000;

export const CONVERT_MAX_TOKENS_MIN = 1024;

export const CONVERT_MAX_TOKENS_MAX = 65536;

export const DEFAULT_CONVERT_MAX_TOKENS = 16384; // 구 v0.6.4는 4096 고정 — 18,000토큰 슬라이스의 사건 다발을 담기엔 터무니없이 짧았다

export const INCIDENT_TOKENS_MIN = 100;

export const INCIDENT_TOKENS_MAX = 4000;

export const DEFAULT_INCIDENT_MAX_TOKENS = 500;

export const DEFAULT_RANDOM_BUDGET = 500;

export const defaultSettings = Object.freeze({
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
    // ── v0.18.0 신규 ──
    // 계층별 파라미터 오버라이드. 레코드 키는 perWorld와 같은 넷(PER_WORLD_KEYS를 그대로 쓴다).
    // 값이 없거나 빈 문자열이면 전역값을 상속한다. 우선순위는 북별(perWorld) > 계층(perLayer) > 전역.
    // ⚠ 계층 키는 getTargetWorldsDetailed()가 내는 layer 값과 같아야 한다 — 'character'다(사양서 표기 'char' 아님).
    //   'fixed'(설정 고정 대상)는 계층 레코드를 두지 않는다 → 북별이 없으면 전역값으로 간다.
    perLayer: { chat: {}, persona: {}, character: {}, global: {} },
});


/** 설정 숫자 방어 — 설정 파일이 손으로 망가졌어도 파이프라인은 돌아가야 한다 */
export function clampSetting(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}


export function getSliceTokens() {
    return clampSetting(getSettings().sliceTokens, SLICE_TOKENS_MIN, SLICE_TOKENS_MAX, DEFAULT_SLICE_TOKENS);
}


export function getConvertMaxTokens() {
    return clampSetting(getSettings().convertMaxTokens, CONVERT_MAX_TOKENS_MIN, CONVERT_MAX_TOKENS_MAX, DEFAULT_CONVERT_MAX_TOKENS);
}


export function getIncidentMaxTokens() {
    return clampSetting(getSettings().incidentMaxTokens, INCIDENT_TOKENS_MIN, INCIDENT_TOKENS_MAX, DEFAULT_INCIDENT_MAX_TOKENS);
}


/**
 * 로어북 → 계층 조회 캐시.
 * getTargetWorldsDetailed()는 4계층 전수 스캔(카드 charLore 조회 포함)이라 게터가 매 호출 부르면 비싸다
 * — 주입 파이프라인은 한 턴에 '북 수 × 게터 수'만큼 부른다.
 * ⚠ 무효화 지점은 이 다섯뿐이다: ① CHAT_CHANGED ② WORLDINFO_UPDATED ③ 감지 층 체크박스 변경
 *    ④ 고정 대상(settings.world) 변경 ⑤ 인터셉터 진입(턴 시작). 그 밖에서는 캐시를 믿는다.
 * 이미 detailed 목록을 쥔 호출부는 게터에 layer를 직접 넘겨 이 조회 자체를 건너뛴다.
 */
export let worldLayerCache = null;


export function invalidateWorldLayerCache() {
    worldLayerCache = null;
}


/** 이 로어북이 귀속된 계층. 귀속 순서(채팅 > 페르소나 > 캐릭터 > 전역)는 getTargetWorldsDetailed()가 정한다 */
export function getWorldLayer(world) {
    if (!world) return null;
    if (!worldLayerCache) {
        worldLayerCache = new Map(getTargetWorldsDetailed().map(d => [d.name, d.layer]));
    }
    return worldLayerCache.get(world) ?? null;
}


/** 변환·숨김에서 제외할 최근 메시지 수. 설정탭과 요술봉 패널 두 창구가 같은 값을 쓴다 (v0.15.0) */
export function getKeepRecent() {
    const value = Number(getSettings().keepRecent);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : defaultSettings.keepRecent;
}


/** 비어 두면 기본 스타일 — "비우면 기본값"이 복원 버튼과 같은 의미가 되게 한다 */
export function getConvertStyle() {
    return String(getSettings().convertStyle || '').trim() || DEFAULT_CONVERT_STYLE;
}


export function getSettings() {
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
export const LAYER_LABELS = Object.freeze({
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
export function getCharacterCardWorlds(ctx) {
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
export function getTargetWorldsDetailed() {
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
export function getTargetWorlds() {
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
export function getConversionTargetWorld() {
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


/**
 * 항목 3상태 (v0.17.0) — 🔵 상시(코어) / 🟢 검색층 / ⚫ 꺼짐.
 *
 * `disable`과 `constant`는 ST 엔트리의 **독립 필드**다. 끌 때는 `disable`만 세우므로 별도 백업 저장소가 필요 없다.
 * ⚠️ 복귀는 **항상 🔵 상시**로 간다 — 3상태가 한 방향으로 순환해야 🟢 검색층 항목을 🔵로 승격할 경로가 생긴다.
 * "원래 색으로 복귀"(v0.17.0 1차안)는 초록 → 파랑 경로를 통째로 없애 승격 자체를 불가능하게 만들었다.
 */
export const ENTRY_STATE_CORE = 'core';

export const ENTRY_STATE_SEARCH = 'search';

export const ENTRY_STATE_OFF = 'off';


/** 엔트리의 현재 상태. 꺼짐이 constant보다 우선한다 — 꺼진 파랑도 화면에선 회색이다 */
export function getEntryState(entry) {
    if (entry?.disable) return ENTRY_STATE_OFF;
    return entry?.constant ? ENTRY_STATE_CORE : ENTRY_STATE_SEARCH;
}


/**
 * 클릭 1회의 다음 상태와 패치 — 순수 함수(단위검증 대상).
 * 🔵 → 🟢 → ⚫ → 🔵 한 방향 순환. 세 상태 어디서든 세 번 안에 원하는 상태로 갈 수 있다.
 * needsIndex = 그 항목만 단건 벡터 삽입이 필요한가. 검색층으로 들어오는 경로에서만 true다
 * (코어는 회수 후보 필터가 constant를 이미 거르므로 색인 대상이 아니다).
 */
export function planEntryStateCycle(entry) {
    const state = getEntryState(entry);
    if (state === ENTRY_STATE_CORE) {
        // 강등 — order를 같이 되돌린다. 안 되돌리면 검색층인데 프롬프트 최상단 자리를 계속 차지한다.
        return { from: state, to: ENTRY_STATE_SEARCH, patch: { constant: false, order: NORMAL_ORDER }, needsIndex: true };
    }
    if (state === ENTRY_STATE_SEARCH) {
        // 끄기 — 벡터는 지우지 않는다. 회수 후보 필터가 disable을 이미 거르고, 남은 벡터는 다음 재색인에서 정리된다.
        return { from: state, to: ENTRY_STATE_OFF, patch: { disable: true }, needsIndex: false };
    }
    // 켜기 — 순환을 닫는다. 항상 🔵 상시로 올라간다(여기가 🟢 → 🔵 승격의 유일한 통로다).
    // order를 같이 올리는 이유: constant만 세우면 order 100이라 코어인데 프롬프트 최하단에 깔린다(v0.6.0 버그 재발 경로).
    return { from: state, to: ENTRY_STATE_CORE, patch: { disable: false, constant: true, order: CORE_RULES_ORDER }, needsIndex: false };
}


/**
 * 항목 상태를 한 칸 돌린다 (v0.17.0 — v0.6.4의 2상태 전환 함수를 대체).
 * 검색층으로 들어오는 경로(강등·회색에서 복귀)에서만 그 항목 하나를 벡터에 삽입한다 → 임베딩 1회.
 * 코어로 가는 경로는 임베딩 0회다.
 */
export async function cycleEntryState(world, uid) {
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
export function approxTokens(text) {
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
export const MANAGER_EXT = 'simple-lorebook';

export const MANAGER_KEY_SEP = '\u241f';

export const MANAGER_LANGUAGE_LABELS = { Korean: '한국어', English: '영어' };


/**
 * 매니저의 hashText() 재구현 (FNV-1a 32bit + `_길이`).
 * 저쪽 파일을 import하지 않는다 — 로드 순서 의존이 생기고, 미설치 시 확장 전체가 죽는다.
 */
export function managerHashText(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${hash.toString(36)}_${text.length}`;
}


/** 번역 레코드 → 표시용 형태. 본문이 비면 없는 것으로 친다. */
export function normalizeManagerRecord(record) {
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
export function getManagerTranslation(world, uid, sourceText) {
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
export function buildDetailToggle(content, colSpan, meta = null) {
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

    // 발동 배지 + 키 칩 (v0.19.0). 삽입은 textContent로만 — 키는 모델·사용자가 쓴 값이라 HTML로 넣으면 XSS다.
    const $badges = $('<div class="jev-detail-meta">');
    if (meta && isRecentlyActivated(meta.world, meta.uid)) {
        $badges.append($('<span class="jev-fire-badge">')
            .attr('title', '직전 턴 프롬프트에 이 항목이 들어갔어요')
            .text('발동됨'));
    }
    for (const key of (Array.isArray(meta?.keys) ? meta.keys : [])) {
        const label = String(key ?? '').trim();
        if (label) $badges.append($('<span class="jev-key-chip">').text(label));
    }
    if ($badges.children().length) $detailCell.prepend($badges);

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
 * 🔵 상시(코어) → 🟢 검색층 → ⚫ 꺼짐 → 🔵 순환. 확인 팝업 없음(기존 전환 버튼과 같은 정책).
 * ⚫ 회색 행에서도 이 버튼이 동작해야 한다 — 확장 안에서 꺼진 항목을 되살릴 수 있는 유일한 경로다.
 */
export const ENTRY_STATE_CLASS = Object.freeze({
    [ENTRY_STATE_CORE]: 'jev-is-core',
    [ENTRY_STATE_SEARCH]: 'jev-is-search',
    [ENTRY_STATE_OFF]: 'jev-is-off',
});

export const ENTRY_STATE_TITLE = Object.freeze({
    [ENTRY_STATE_CORE]: '상시 메모리(코어) — 누르면 검색층으로 내려요',
    [ENTRY_STATE_SEARCH]: '검색층 메모리 — 누르면 이 항목을 꺼요',
    [ENTRY_STATE_OFF]: '꺼진 항목 — 누르면 상시 메모리로 켜요',
});

export const ENTRY_STATE_DONE_TOAST = Object.freeze({
    [ENTRY_STATE_CORE]: '상시 메모리(코어)로 올렸어요 — 매 턴 주입돼요',
    [ENTRY_STATE_SEARCH]: '검색층으로 내렸어요 (이 항목만 벡터에 넣었어요)',
    [ENTRY_STATE_OFF]: '이 항목을 껐어요 — 표에 회색으로 남고, 한 번 더 누르면 상시 메모리로 켜져요',
});


export function buildStateToggle(world, uid, state, $panel) {
    const $btn = $('<span class="jev-core-toggle" role="button" tabindex="0">')
        .addClass(ENTRY_STATE_CLASS[state] ?? 'jev-is-search')
        .attr('title', ENTRY_STATE_TITLE[state] ?? '')
        .append($('<i class="fa-solid fa-circle">'));

    const run = async () => {
        if ($btn.hasClass('disabled')) return;
        $btn.addClass('disabled');
        try {
            const plan = await cycleEntryState(world, uid);
            toastr.success(ENTRY_STATE_DONE_TOAST[plan.to] ?? '상태를 바꿨어요', DISPLAY_NAME);
            await renderPanelChunks($panel);
            renderPanelSummary($panel);
        } catch (error) {
            toastr.error(String(error?.message ?? error), DISPLAY_NAME);
            $btn.removeClass('disabled');
        }
    };
    $btn.on('click', run);
    $btn.on('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); run(); }
    });

    return $('<td class="jev-cell-core">').append($btn);
}


/**
 * 메시지의 raw moment. ST send_date 포맷이 제각각이라 timestampToMoment(utils.js:1079) 사용.
 * v0.7.0에서 messageDay(문자열 날짜)를 걷어냈다 — 장면 경계는 날짜가 바뀌었나가 아니라
 * 실제 시간이 얼마나 벌어졌나로 판정하고, 실제 날짜 자체는 전사에 넣지 않기 때문이다.
 */
export function messageMoment(message) {
    try {
        const m = timestampToMoment(message?.send_date);
        return m?.isValid?.() ? m : null;
    } catch {
        return null;
    }
}


/** 변환 대상 메시지 수집: is_system(숨김)·빈 본문 제외. [startIndex, endIndex) — 끕은 보존 버퍼 경계 */
export function collectFreshMessages(chat, startIndex, endIndex) {
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
export async function buildSlices(messages, sliceTokens) {
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
export function sliceToTranscript(slice) {
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
export const STRUCTURAL_TAIL_RE = /^(?:[-*_=]{3,}$|#{1,6}\s|>\s|\||\**\s*Keywords?\s*:|[-*•+]\s+|\d+[.)]\s+)/i;

export function looksTruncated(text) {
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
export function parseConversionOutput(text) {
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
        current.keys = sanitizeEntryKeys(current.keywords); // v0.19.0 — 소비는 flavor가 결정한다
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
export function findCoreRulesEntry(worldData) {
    return Object.values(worldData?.entries ?? {}).find(e => e.constant && e.comment === CORE_RULES_COMMENT) ?? null;
}


export const CORE_DIARY_COMMENT_RE = /^⭐ Core Diary(?:\s*\(sealed\))?\s*·\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})\s*$/;

/** 일기 comment 파싱 — `⭐ Core Diary[ (sealed)] · <시작> ~ <종료>`. 못 읽으면 null(일기가 아님) */
export function parseDiaryComment(comment) {
    const m = String(comment ?? '').match(CORE_DIARY_COMMENT_RE);
    if (!m) return null;
    return { start: m[1], end: m[2], sealed: /\(sealed\)/.test(comment) };
}

export function isDiarySealed(entry) {
    return !!parseDiaryComment(entry?.comment)?.sealed;
}

export function buildDiaryComment(start, end, sealed) {
    return `${CORE_DIARY_COMMENT_PREFIX}${sealed ? ' (sealed)' : ''} · ${start} ~ ${end}`;
}

/** 일기 항목 본문 헤더 — 모델은 날짜를 찍지만 코드가 항상 다시 찍는다(모델은 새 사건 날짜만 알지 범위는 모른다) */
export const DIARY_HEADER_RE = /^#{1,4}\s*\**\s*CORE\s+DIARY\b/i;

export function buildDiaryContent(start, end, body) {
    return `### CORE DIARY (${start} ~ ${end})\n${body}`;
}

/** 저장된 일기 본문에서 코드가 찍은 헤더 줄을 떼고 라벨줄만 돌려준다 — 다음 프롬프트의 [Previous current diary] 입력용 */
export function stripDiaryHeader(content) {
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
export function findCoreDiaryEntries(worldData) {
    return Object.values(worldData?.entries ?? {})
        .filter(e => e.constant && parseDiaryComment(e.comment))
        .sort((a, b) => parseDiaryComment(a.comment).start.localeCompare(parseDiaryComment(b.comment).start));
}

/** 레거시 통짜 코어(마이그레이션 입력용) — archived 표시된 것은 comment가 달라져 자동으로 제외된다 */
export function findLegacyCoreEntry(worldData) {
    return Object.values(worldData?.entries ?? {}).find(e => e.comment === LEGACY_CORE_COMMENT) ?? null;
}

/** 코어 계열(규칙/일기/강등된 일기/레거시) comment 판별 — 사건 날짜 스캔(countExistingForDate·latestDateInWorld)이 오염되지 않게 */
export function isCoreFamilyComment(comment) {
    const c = String(comment ?? '');
    return c === CORE_RULES_COMMENT
        || c.startsWith(CORE_DIARY_COMMENT_PREFIX)
        || c.startsWith(DIARY_ARCHIVE_COMMENT_PREFIX)
        || c === LEGACY_CORE_COMMENT
        || c.startsWith(`${LEGACY_CORE_COMMENT}${LEGACY_CORE_ARCHIVED_SUFFIX}`);
}

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(d) { return ISO_DATE_RE.test(String(d ?? '')); }


/**
 * 일기 날짜 범위 산출 (v0.13.1 버그 수정) — 사건 배열의 나열 순서가 항상 시간순은 아니라서
 * '첫 사건=시작 / 마지막 사건=종료'로 집으면 역전될 수 있었다(실측: 시작 2026-09-14 > 종료 2026-05-12).
 * 기존 일기 범위(있으면)와 이번 사건들의 날짜를 전부 모아 min~max로 계산한다 — 범위가 줄어들 일은 없다.
 * 파싱 실패(YYYY-MM-DD 형식이 아닌) 날짜는 후보에서 제외하고, 후보가 하나도 없으면 앵커로 대체한다.
 */
export function computeDiaryRange(existingRange, incidentDates, anchor) {
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
export function recomputeDiaryOrders(worldData) {
    findCoreDiaryEntries(worldData).forEach((entry, idx) => {
        entry.order = CORE_DIARY_ORDER_BASE - idx;
    });
}


/** 모델 출력에서 지정 헤더 다음의 본문만 뽑는다 (RULES_PROMPT/DIARY_PROMPT 공용 파서) */
export function parseSingleSectionOutput(text, headerRe) {
    const lines = String(text ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (headerRe.test(lines[i])) {
            return lines.slice(i + 1).join('\n').trim();
        }
    }
    return '';
}

export const RULES_HEADER_RE = /^#{1,4}\s*\**\s*CORE\s+RULES\b/i;


/**
 * 코어 규칙/일기 갱신 공용 — 프롬프트만 다르고 재시도(최대 2회)·잘림 검증·섹션 파싱은 같다 (v0.13.0).
 * 코어는 라벨·불릿 포맷이라 문장으로 안 끝나는 게 정상 → 끝줄 검사(checkTail)는 끈다.
 * @returns {Promise<{ok:boolean, body:string, warnings:string[], failReason:string}>}
 */
export async function updateCoreSection(ctx, { systemPrompt, previousLabel, previousBody, digest, maxTokens, headerRe, retryLabel }) {
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
export function normalizeOngoingLine(line) {
    return String(line ?? '')
        .replace(/^[-*]\s*/, '')
        .toLowerCase()
        .replace(/[^a-z0-9가-힣\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 일기 본문(헤더 제외)에서 Ongoing: 섹션의 줄만 뽑는다 */
export function extractOngoingLines(diaryBody) {
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
export function ongoingLineSurvives(prevLine, newBody) {
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
export function checkOngoingCarryover(prevBody, newBody) {
    return extractOngoingLines(prevBody).filter(line => !ongoingLineSurvives(line, newBody));
}

/** 강등 시 미해결 Ongoing을 현재 일기에 기계적으로 합친다(모델에 맡기지 않는다) — 정규화 중복은 걸러낸다 */
export function appendOngoingLines(diaryBody, newLines) {
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
export function countExistingForDate(worldData, date) {
    if (!date) return 0;
    let n = 0;
    for (const e of Object.values(worldData?.entries ?? {})) {
        if (e.constant || isCoreFamilyComment(e.comment)) continue; // 코어 계열(규칙/일기/레거시)은 사건이 아니다
        if (String(e.comment ?? '').includes(date)) n++;
    }
    return n;
}


/** 로어북 comment에 박힌 날짜 중 가장 늦은 것 — 앛커 폴백 2단계 */
export function latestDateInWorld(worldData) {
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
export function resolveStoryAnchor(ctx, worldData, fresh) {
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
export async function generateConversion(ctx, systemPrompt, userPrompt) {
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
export async function detectTruncation(text, maxTokens, label, { checkTail = true } = {}) {
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
export function openWorldEditor(world) {
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
export function getConvertProfileBadge() {
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
export function renderConvertProfileBadge($panel) {
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
export function renderPanelWarnings($panel) {
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
export function getConvertProfileLabel() {
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
export async function convertChatToLorebook(setStatus) {
    if (conversionInProgress) {
        toastr.warning('변환이 이미 진행 중이에요.', DISPLAY_NAME);
        return;
    }
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    const world = getConversionTargetWorld();
    if (!world) {
        toastr.error('대상 로어북이 없어요. 이 채팅 또는 캐릭터 카드에 로어북을 먼저 연결해 주세요. (자동으로 만들지는 않아요)', DISPLAY_NAME);
        return;
    }
    const chat = ctx.chat ?? [];
    if (!chat.length) {
        toastr.warning('채팅이 비어 있어요.', DISPLAY_NAME);
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
        toastr.info(`변환할 새 메시지가 없어요 (변환 지점 ${startIndex}, 최근 ${keepRecent}개 보존, 전체 ${chat.length}).`, DISPLAY_NAME);
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
            // flavor 후처리 (v0.19.0) — 논제브는 여기서 팝업 선택에 따라 constant·key·preventRecursion을 얹는다.
            // 제브는 이 훅을 등록하지 않으므로 위 기본값(검색층 · 키 없음)이 그대로 남는다.
            hooks.decorateNewEntry?.(entry, inc);
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
            toastr.success(`${toastBody} 여기를 누르면 에디터에서 바로 확인할 수 있어요.`, DISPLAY_NAME, toastOptions);
        } else {
            // 경고가 하나라도 있으면 초록불을 띄우지 않는다 — "다 잘 됐구나"로 읽히면 잘린 요약이 그대로 굳는다
            setStatus(`완료(경고 ${warnings.length}건): ${summary} — ${warnings.join(' / ')}`);
            const warnBody = `${toastBody}\n⚠ 확인할 게 ${toastWarnings.length}건 있어요: ${toastWarnings.join(' / ')}`;
            if (coreFailed) {
                toastr.error(warnBody, DISPLAY_NAME, { ...toastOptions, timeOut: 20000 });
            } else {
                toastr.warning(warnBody, DISPLAY_NAME, { ...toastOptions, timeOut: 20000 });
            }
        }
        console.log(`${LOG} 변환 완료 — 사건 ${incidents.length}건 / 변환 지점 ${startIndex}→${endIndex} / 숨김 ${hiddenCount}개 / 경고 ${warnings.length}건 (토스트 표시 ${toastWarnings.length}건) / ${ms}ms`);
    } catch (error) {
        console.error(`${LOG} 변환 실패`, error);
        warnings.push(`변환 실패: ${error?.message ?? error}`);
        lastConvertWarnings = warnings.slice();
        setStatus(`실패했어요: ${error?.message ?? error}`);
        toastr.error(`변환에 실패했어요: ${error?.message ?? error}`, DISPLAY_NAME);
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
export async function migrateContentHeaders(world) {
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
export async function runHeaderMigration() {
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
                toastr.info(`'${world}' 항목 ${patched}개 본문에 날짜 헤더를 넣고 재색인했어요 (${indexed}개).`, DISPLAY_NAME);
            } catch (error) {
                settings.embeddingDirty = true;
                console.warn(`${LOG} '${world}' 마이그레이션 후 재색인 실패: ${error?.message ?? error}`);
                toastr.warning(`'${world}' 날짜 헤더는 넣었는데 재색인이 실패했어요. 설정에서 [색인]을 한 번 눌러주세요: ${error?.message ?? error}`, DISPLAY_NAME);
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
export function countDateHeaders(text) {
    return [...String(text || '').matchAll(SPLIT_DATE_RE)].length;
}


/**
 * 날짜 헤더 기준 분할 — st_lorebook_split.py split_content()의 JS 이식.
 * 규칙: 선두 무날짜부는 200자 이상일 때만 독립 덩어리(날짜 null), 200자 미만 조각은 앞 덩어리에 흡수.
 * @returns {{date: string|null, chunk: string}[]}
 */
export function splitEntryContent(text) {
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
export async function runSplitForWorld(world, uids, setStatus) {
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
export async function openSplitDialog(setStatus, $panel) {
    const worlds = getTargetWorlds();
    if (!worlds.length) {
        toastr.error('대상 로어북이 없어요. 채팅·캐릭터·전역·페르소나 중 한 곳에 로어북을 연결하거나 고정 대상을 설정해 주세요.', DISPLAY_NAME);
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
        toastr.info('스플릿할 항목이 없어요 (본문이 있는 항목이 없어요).', DISPLAY_NAME);
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
        toastr.info('선택된 항목이 없어서 아무것도 바꾸지 않았어요.', DISPLAY_NAME);
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
        toastr.success(`${totalSplit}개 항목을 ${totalChunks}개 덩어리로 나눴어요. 백업: ${backups.join(', ')}. 여기를 누르면 에디터에서 바로 확인할 수 있어요.`, DISPLAY_NAME, { onclick: () => openWorldEditor(firstWorld), timeOut: 10000 });
        if ($panel) {
            renderPanelSummary($panel);
            await renderPanelChunks($panel);
        }
    } catch (error) {
        console.error(`${LOG} 스플릿 실패`, error);
        setStatus(`스플릿에 실패했어요: ${error?.message ?? error}`);
        toastr.error(`스플릿에 실패했어요: ${error?.message ?? error}`, DISPLAY_NAME);
    }
}

// ── 세부 패널 (요술봉 메뉴) ─────────────────────────────────────────────


/**
 * 직전 변환 되돌리기 (v0.11.0).
 * 항목 삭제 → 코어 복원 → 변환 지점·작중 앵커 원복 → 숨김 해제 → 재색인.
 * 벡터는 재색인으로 청소한다(발주자 결정) — 삭제한 항목의 벡터가 남으면 '없는 항목'이 후보로 올라온다.
 */
export async function undoLastConversion(setStatus) {
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
export function renderUndoButton($panel) {
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
export function renderPanelSummary($panel) {
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
    // 제브 전용 3행(턴당 예산·전송·임베딩)은 flavor가 얹는다 — 논제브에선 아예 안 그려진다.
    hooks.summaryRows?.($summary, row, worlds, settings);
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
export function renderChatStack(chat, converted, keepRecent, chatLength) {
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
export async function fillStackTokens($slots, chat, from, to, keepRecent, chatLength) {
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


/** 색인 현황 렌더 — 로어북 항목 hash를 /api/vector/list 결과와 대조 */
export async function renderPanelChunks($panel) {
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

            const { $cell, $detail } = buildDetailToggle(content, 6, { world, uid: e.uid, keys: e.key });
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
            '동그라미를 누르면 🔵 상시 메모리(매 턴 주입) → 🟢 검색층 → ⚫ 꺼짐 → 🔵 순서로 돌아요. '
            + '⚫에서 한 번 더 누르면 원래 색으로 돌아와요.'));

        // 코어 섹션 — constant라 ST가 매턴 네이티브 주입, Jev 판정·벡터 색인 제외.
        // v0.13.0: 규칙(최대 1) · 일기(최대 3, 오래된→최신, 봉인/열림 배지) · 기타(수동 승격분)를 구분 표시한다.
        if (coreEntries.length) {
            // ⚠ 합계 토큰에서 꺼진 파랑은 뺀다 (v0.17.0) — 매 턴 주입되지 않는 걸 합계에 넣으면 이 줄이 거짓말한다.
            const coreLive = coreEntries.filter(e => !e.disable);
            const coreOffCount = coreEntries.length - coreLive.length;
            const coreTokens = coreLive.reduce((sum, e) => sum + approxTokens(e.content), 0);
            const liveOtherCount = coreOther.filter(e => !e.disable).length;
            const budget = getBudgetTokens(world, layer); // 북별 유효 예산 (오버라이드 반영)
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

                const { $cell, $detail } = buildDetailToggle(content, 6, { world, uid: e.uid, keys: e.key });
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
export const INJECTED_TITLE = '직전 턴 — 프롬프트에 들어간 것';


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
export function renderPanelInjected($panel) {
    // 제브 전용 상태는 훅으로 받는다 — 아래 본문은 단일파일 시절 그대로다(순수 이동).
    // 훅 미등록(논제브) = lastReport/lastError 없음 + 랜덤키 공집합 → 분류가 ⭐코어/🔑키워드 2층으로만 떨어진다.
    const lastError = hooks.lastError?.() ?? null;
    const lastReport = hooks.lastReport?.() ?? null;
    const lastRandomKeys = hooks.randomKeys?.() ?? EMPTY_KEY_SET;
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
            const { $cell, $detail } = buildDetailToggle(content, headers.length, { world: r.entry.world, uid: r.entry.uid, keys: r.entry.key });
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
export async function fillInjectedTokens($title, $cells, rows) {
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
export async function refreshPanel($panel) {
    renderPanelSummary($panel);
    renderPanelWarnings($panel);
    renderPanelInjected($panel); // 탈락 후보(renderPanelJudgment)는 이 안의 접힘 블록에서 그려진다
    await renderPanelChunks($panel);
}


/** 세부 패널 열기 (요술봉 메뉴 클릭) */
export async function openDetailPanel() {
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'panel');
    const $panel = $(html);
    const setConvertStatus = (text) => $panel.find('#jev_panel_convert_status').text(text);

    $panel.find('#jev_panel_convert').on('click', async function () {
        const $button = $(this);
        if ($button.hasClass('disabled')) return;
        // 상호 배제 (v0.19.0) — 켜기와 변환 둘 다 막는다. 켜기만 막으면 '꺼진 채로 변환'이 통과해서
        // 두 확장이 같은 변환 지점·되돌리기 스냅샷을 번갈아 덮는 경로가 그대로 남는다.
        if (!(await guardPeerExclusive('convert'))) return;
        // 변환 시작 게이트 (v0.19.0) — 논제브는 여기서 팝업 3옵션을 띄운다. false면 변환 자체를 안 한다.
        if (hooks.beforeConvert && !(await hooks.beforeConvert())) return;
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
            toastr.warning('되돌릴 변환 기록이 없어요.', DISPLAY_NAME);
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
            toastr.success(`되돌렸어요 — 항목 ${r.removed}개 삭제, 메시지 ${r.unhidden}개 복구`, DISPLAY_NAME);
        } catch (error) {
            setConvertStatus(`되돌리기 실패: ${error?.message ?? error}`);
            toastr.error(`되돌리기 실패: ${error?.message ?? error}`, DISPLAY_NAME);
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
            toastr.warning('색인 대상이 없다.', DISPLAY_NAME);
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
            toastr.error(`재색인 실패: ${error?.message ?? error}`, DISPLAY_NAME);
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
            toastr.warning('열 로어북이 없어요. 이 채팅/캐릭터에 로어북을 연결해 주세요.', DISPLAY_NAME);
            return;
        }
        openWorldEditor(world);
    });

    $panel.find('#jev_panel_refresh').on('click', () => refreshPanel($panel));
    // 채팅 중에 바로 조정할 수 있어야 한다 — 설정 서랍과 같은 팝업을 패널에서도 연다 (v0.17.1)
    $panel.find('#jev_panel_open_injection').on('click', () => void openInjectionSettingsPopup());
    $panel.find('#jev_panel_open_convert').on('click', () => void openConvertSettingsPopup());

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


/** 변환 프로필 셀렉트 채우기 — connection-manager 비활성이면 행 숨김(현재 연결된 메인 API로 동작) */
export function populateConvertProfiles($root = $(document)) {
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
 * 팝업 B 「로어북 만들기 설정」 (v0.17.0 — 요구 F).
 * 팝업 A와 같은 규칙: 열 때마다 바인딩·렌더, 저장은 입력 즉시.
 */
export async function openConvertSettingsPopup() {
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
        toastr.info('변환 스타일 지시문을 기본값으로 되돌렸어요.', DISPLAY_NAME);
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

/**
 * WORLD_INFO_ACTIVATED 스냅샷 기록 (v0.19.0 — 루트 index.js 구독부에서 그대로 이사).
 * 모듈 경계를 넘는 `let` 대입이 ESM에선 불가능해 setter로 뺐다. 매핑 내용은 단일파일 시절과 동일.
 */
export function recordActivatedEntries(entries) {
    lastActivated = {
        ts: Date.now(),
        entries: (Array.isArray(entries) ? entries : []).map(e => ({
            world: String(e?.world ?? ""),
            uid: e?.uid,
            comment: String(e?.comment ?? ""),
            content: String(e?.content ?? ""),
            constant: e?.constant === true,
            key: Array.isArray(e?.key) ? e.key.map(k => String(k)) : [], // v0.19.0 — 키 칩 표시용
        })),
    };
}
