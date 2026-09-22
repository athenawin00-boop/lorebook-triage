/**
 * 논제브(keeper) 전용부 — 이 파일은 **논제브 로어북 배포본에만** import된다 (v0.19.0).
 *
 * 제브 배포본에도 파일 자체는 소스 정본으로 존재하지만 루트 index.js가 import하지 않고,
 * `scripts/build-keeper.mjs`가 만드는 배포본에서만 실제로 물린다.
 *
 * 담는 것: 변환 시작 팝업(3옵션) / 팝업 선택에 따른 항목 후처리 / 키워드 제약 프롬프트 추가 지시.
 * 담지 않는 것: 외부 판정·벡터/임베딩·랜덤 주입·파라미터 오버라이드 — 논제브엔 그 기능이 없다.
 *
 * 방향 규칙: keeper → core import 허용, core → keeper는 **훅만**(src/hooks.js).
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { LOG } from './flavor.js';
import { getSettings, getPendingRange, countPendingTokens, ENTRY_KEY_MAX } from './core.js';

/**
 * 변환 시작 모드 — 생성되는 **사건 항목**이 어떻게 발동할지 정한다.
 * ⚠️ 코어 규칙/일기(⭐)는 이 선택과 **무관하게 항상 constant**다. 그건 "절대 잊으면 안 되는 상태"라
 *    발동 방식을 사용자 선택에 맡기는 값이 아니다(발주 확정).
 */
export const CONVERT_MODES = Object.freeze({
    /** 모두 파란불 — 전부 constant. 매 턴 전량 주입되므로 실비가 선형으로 는다 */
    CONSTANT: 'constant',
    /** 모두 초록불 + AI 키워드 — key를 달아 ST 키워드 발동에 맡긴다 */
    KEYS: 'keys',
    /** 모두 초록불 + 키 없음 — 자동 발동 안 됨. 보관·수동 입력용 */
    NOKEYS: 'nokeys',
});

const MODE_ORDER = [CONVERT_MODES.CONSTANT, CONVERT_MODES.KEYS, CONVERT_MODES.NOKEYS];
const DEFAULT_MODE = CONVERT_MODES.KEYS;

/** 마지막 선택. 직전 선택이 기본 선택이 되도록 설정에 저장한다(발주 확정). */
function getConvertMode() {
    const saved = String(getSettings().convertStartMode ?? '');
    return MODE_ORDER.includes(saved) ? saved : DEFAULT_MODE;
}

function setConvertMode(mode) {
    if (!MODE_ORDER.includes(mode)) return;
    getSettings().convertStartMode = mode;
    saveSettingsDebounced();
}

/**
 * 변환 시작 전 팝업 — **매번 뜬다**(발주 확정. "다시 묻지 않기"는 넣지 않는다).
 * 세 선택지의 대가가 서로 달라서, 한 번 고른 값이 조용히 유지되면 나중에 실비가 왜 늘었는지 모른다.
 * @returns {Promise<boolean>} 변환을 계속할지 (취소면 false — 변환 자체를 안 한다)
 */
export async function openConvertStartPopup() {
    const current = getConvertMode();
    const $body = $('<div class="jev-lorebook-settings jev-popup-body">');
    $body.append($('<h3>').text('이번 변환에서 만들 항목'));
    $body.append($('<div class="jev-panel-muted">').text(
        '새로 만들 사건 항목이 어떻게 발동할지 정해요. ⭐ 코어 규칙·일기는 이 선택과 상관없이 항상 매 턴 들어가요.'));

    const opts = [
        {
            mode: CONVERT_MODES.CONSTANT,
            label: '모두 파란불 (상시)',
            help: '만든 항목 전부를 매 턴 프롬프트에 넣어요. 빠짐없이 기억하지만 그만큼 매 턴 비용이 늘어요.',
            costSlot: true,
        },
        {
            mode: CONVERT_MODES.KEYS,
            label: `모두 초록불 + AI 키워드 ${ENTRY_KEY_MAX}개`,
            help: `항목마다 키워드를 최대 ${ENTRY_KEY_MAX}개까지 자동으로 달아요. 대화에 그 단어가 나오면 그 항목만 들어가요.`
                + ' 키워드는 영어 단어만 달려요 — 한국어는 어미가 붙어서 원형 그대로 걸리는 일이 거의 없어요.',
        },
        {
            mode: CONVERT_MODES.NOKEYS,
            label: '모두 초록불 + 키 없음 — 자동 발동 안 됨 (보관·수동 입력용)',
            help: '항목만 만들어 두고 발동은 시키지 않아요. 나중에 직접 키워드를 넣거나 파란불로 바꿀 때 써요.',
        },
    ];

    let picked = current;
    let $costSlot = null;
    for (const opt of opts) {
        const $label = $('<label class="radio_label jev-convert-opt">');
        const $radio = $('<input type="radio" name="jev_convert_start_mode">')
            .attr('value', opt.mode)
            .prop('checked', opt.mode === current)
            .on('change', function () { if ($(this).prop('checked')) picked = opt.mode; });
        const $text = $('<span>').append($('<b>').text(opt.label));
        if (opt.costSlot) {
            $costSlot = $('<span class="jev-convert-cost">').text(' (실비 계산 중…)');
            $text.append($costSlot);
        }
        $label.append($radio).append($text);
        $body.append($label);
        $body.append($('<small class="jev-set-help jev-convert-help">').text(opt.help));
    }

    // 실비는 토크나이저가 비동기라 팝업을 막지 않고 뒤에서 채운다 (v0.6.3 fillStackTokens 선례).
    // 값은 챗 적치 막대의 「대기」와 **같은 산식**(core.countPendingTokens)이다 — 두 화면이 다른 숫자를 말하면 안 된다.
    void (async () => {
        try {
            const { chat, from, to, count } = getPendingRange();
            const tokens = await countPendingTokens(chat, from, to);
            if ($costSlot) {
                $costSlot.text(` — 선택 시 매 턴 약 +${tokens.toLocaleString()}tok`);
            }
            $body.find('.jev-convert-cost-note').text(
                `대기 ${count}건을 기준으로 잡은 추정치예요. 실제 항목은 요약이라 보통 이보다 적어요.`);
        } catch (error) {
            if ($costSlot) $costSlot.text(' (실비 추정 실패)');
            console.warn(`${LOG} 변환 팝업 실비 추정 실패`, error);
        }
    })();
    $body.append($('<small class="jev-set-help jev-convert-cost-note">').text('실비 추정 중…'));

    const result = await callGenericPopup($body, POPUP_TYPE.CONFIRM, '', {
        okButton: '변환 시작',
        cancelButton: '취소',
        leftAlign: true,
        allowVerticalScrolling: true,
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return false;
    setConvertMode(picked);
    console.log(`${LOG} 변환 시작 — 모드 ${picked}`);
    return true;
}

/**
 * 변환이 만든 **사건 항목** 후처리. core가 기본값(검색층 · 키 없음)을 세운 직후 불린다.
 * @param {object} entry 방금 만들어진 로어북 엔트리
 * @param {object} inc   파서가 준 사건 (`inc.keys` = core.sanitizeEntryKeys를 통과한 키 후보)
 */
export function decorateNewEntry(entry, inc) {
    const mode = getConvertMode();
    if (mode === CONVERT_MODES.CONSTANT) {
        // 파란불 — order는 올리지 않는다. 코어 규칙·일기(order 1000·999)보다 아래여야 하고,
        // 사건 항목끼리는 순서 의미가 없다. constant만 세우는 게 여기선 맞다.
        entry.constant = true;
        entry.key = [];
        return;
    }
    entry.constant = false;
    if (mode === CONVERT_MODES.KEYS) {
        entry.key = Array.isArray(inc?.keys) ? inc.keys.slice(0, ENTRY_KEY_MAX) : [];
        // 🔑 재귀 방지는 **무조건** 켠다(발주 확정). 요약 항목의 본문은 인물·장소 이름을 반복하므로
        // 재귀 스캔이 켜진 환경에서 항목끼리 서로를 깨운다. 실측: 51항목 로어북에서 본문↔타 항목 키
        // 교차참조 221건. 게다가 제동 장치 world_info_max_recursion_steps는 값이 0이면 falsy라
        // 제한이 아예 안 걸린다(world-info.js:4656 `if (steps && steps <= count)`) — ST 기본이 0이다.
        // 우리가 만든 항목에만 거는 것이라 사용자가 손으로 넣은 항목의 플래그는 건드리지 않는다.
        entry.preventRecursion = true;
        return;
    }
    entry.key = []; // NOKEYS — 자동 발동 경로 없음
}

/**
 * 변환 프롬프트 추가 지시 — 「AI 키워드」를 고른 변환에서만 붙는다.
 * core의 계약부(헤더·개수 상한)는 건드리지 않고 **키워드 줄의 제약만** 더한다.
 * 왜 이 제약인가: 정제기(core.sanitizeEntryKeys)가 구절·한글·범용어를 전부 버리므로,
 * 프롬프트에서 미리 막지 않으면 모델이 5개를 내도 살아남는 게 0개가 된다.
 */
export function incidentPromptExtra() {
    if (getConvertMode() !== CONVERT_MODES.KEYS) return [];
    return [
        `- The Keywords line is REQUIRED for every incident, with at most ${ENTRY_KEY_MAX} entries.`,
        '- Each keyword MUST be a single English word: no spaces, no phrases, no hyphenated pairs of words, no Korean.',
        '  Good: Tucker, Laurie, voodoo, warehouse.   Bad: club zion, "Baron\'s club", 바론, the file.',
        '- Prefer proper nouns and rare concrete nouns that appear in this incident and nowhere else.',
        '- NEVER use generic words (love, night, day, time, he, she, room, work, life, people, ...).',
        '  A keyword that could match almost any message is worse than no keyword at all.',
    ];
}
