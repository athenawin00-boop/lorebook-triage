/**
 * 논제브 로어북 (lorebook-keeper) — 채팅을 날짜별 로어북 항목으로 정리해 주는 확장 (v0.19.0)
 *
 * 하는 일: 마지막 변환 지점 이후의 대화만 요약해서 대상 로어북에 날짜별 사건 항목으로 쌓고,
 * 「절대 잊으면 안 되는 것」은 ⭐ 코어 규칙·일기(매 턴 항상 들어가는 항목)로 따로 관리한다.
 * 만든 항목이 어떻게 발동할지는 변환할 때마다 팝업에서 고른다 —
 *   모두 파란불(상시) / 모두 초록불 + AI 키워드 / 모두 초록불 + 키 없음.
 *
 * 하지 않는 일: 외부 API로 기억을 **선별**하는 일. 임베딩·벡터 검색·판정 모델이 전혀 없고,
 * 어떤 데이터도 이 확장 때문에 외부로 나가지 않는다(변환 요약은 사용자가 이미 쓰고 있는
 * SillyTavern의 연결을 그대로 쓴다). 선별 주입이 필요하면 자매 확장 '제브 로어북'을 쓴다.
 *
 * ── 소스 구조 (자매 배포본 '제브 로어북'과 코어를 공유한다) ──────────────────
 *   index.js        이 파일. 얇은 엔트리 — flavor+core+keeper를 물리고, 훅을 등록하고, 부팅한다
 *   src/flavor.js   배포본마다 다른 유일한 JS (표시명·모듈 네임스페이스·템플릿 경로)
 *   src/hooks.js    훅 레지스트리 (양쪽 바이트 동일)
 *   src/core.js     공용 코어 — 변환 파이프라인·되돌리기·스플릿·패널 공용부 (양쪽 바이트 동일)
 *   src/keeper.js   논제브 전용 — 변환 시작 팝업 3옵션·항목 후처리·키워드 제약 프롬프트
 *
 * `src/core.js`는 제브 로어북 배포본과 **바이트 동일**하다. 변환 파이프라인 버그를 한 번
 * 고치면 양쪽에 같이 반영되게 하려는 것이고, 그 성립 근거가 바로 그 바이트 동일성이다.
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';

import { TEMPLATE_PATH, LOG, DISPLAY_NAME, SELF_GLOBAL_MARKER } from './src/flavor.js';
import { registerHooks } from './src/hooks.js';
import {
    getSettings,
    invalidateWorldLayerCache,
    openConvertSettingsPopup,
    openDetailPanel,
    recordActivatedEntries,
    runHeaderMigration,
    guardPeerExclusive,
} from './src/core.js';
import {
    openConvertStartPopup,
    decorateNewEntry,
    incidentPromptExtra,
} from './src/keeper.js';

// ── 훅 등록 ─────────────────────────────────────────────────────────────
// core는 이 표에 실린 것만 부를 수 있다. **등록하지 않은 훅은 그 기능이 없는 것으로 동작한다.**
// 여기 없는 것들이 곧 이 배포본에 없는 기능이다:
//   indexWorld / onEntryDemoted / vectorList  → 벡터·임베딩 호출 0회
//   budgetTokens / lastReport / renderPanelJudgment / summaryRows / openInjectionSettings
//                                             → 주입 예산·점수 칸·🧠🎲 분류·탈락 후보 표가 화면에 없다
registerHooks({
    beforeConvert: openConvertStartPopup,
    decorateNewEntry,
    incidentPromptExtra,
});

// 런타임 로드 마커 — 상대 확장(제브 로어북)이 '켜져 있는지'를 판정할 때 AND 조건으로 쓴다.
// extension_settings 단독 판정은 확장을 지운 뒤 남은 설정으로 오탐한다(설정은 ST settings.json에 산다).
globalThis[SELF_GLOBAL_MARKER] = true;

jQuery(async () => {
    const settings = getSettings();

    // ⚠️ DOM id는 flavor화하지 않는다(사양) — 그래서 자매 확장을 둘 다 설치하면 공용 마크업의 id가
    // 문서에 두 벌 생긴다. 전역 `$('#id')`는 먼저 로드된 쪽을 집으므로 **자기 서랍으로 스코프**한다.
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    const $drawer = $(html);
    $('#extensions_settings2').append($drawer);
    $drawer.find('#jev_lorebook_title').text(DISPLAY_NAME);

    $drawer.find('#jev_lorebook_enabled').prop('checked', settings.enabled).on('change', async function () {
        const want = !!$(this).prop('checked');
        // 상호 배제 — 두 확장은 같은 로어북과 같은 변환 이력을 쓴다. 상대가 켜져 있으면 되묻고,
        // 승인 시 원클릭으로 저쪽을 끈다.
        if (want && !(await guardPeerExclusive('enable'))) {
            $(this).prop('checked', false);
            return;
        }
        settings.enabled = want;
        saveSettingsDebounced();
    });

    $drawer.find('#jev_lorebook_open_convert').on('click', () => void openConvertSettingsPopup());

    // 본문 날짜 헤더 자동 마이그레이션 — 채팅이 바뀔 때마다 대상 로어북을 보고 아직 안 한 것만 처리.
    // 확장 로드 시점엔 이미 채팅이 열려 있을 수 있어 CHAT_CHANGED가 안 온다 → 아래에서 1회 직접 돌린다.
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            invalidateWorldLayerCache(); // 캐시 무효화 지점 ① — 감지 대상은 채팅에 딸려 바뀐다
            void runHeaderMigration();
        });
    } else {
        console.warn(`${LOG} event_types.CHAT_CHANGED가 없다 — 헤더 마이그레이션은 로드 시 1회만 돌아간다`);
    }
    void runHeaderMigration();

    if (event_types.WORLDINFO_UPDATED) {
        eventSource.on(event_types.WORLDINFO_UPDATED, () => {
            invalidateWorldLayerCache(); // 캐시 무효화 지점 ② — 로어북 목록·연결이 바뀜
        });
    }

    // 이번 턴 실제 주입 관측 — world-info.js:902 emit, isDryRun 턴에는 안 온다.
    // 논제브에서도 필요하다: 「발동됨」 배지의 유일한 근거가 이 스냅샷이다.
    if (event_types.WORLD_INFO_ACTIVATED) {
        eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
            recordActivatedEntries(entries);
        });
    } else {
        console.warn(`${LOG} event_types.WORLD_INFO_ACTIVATED가 없다 — 직전 턴 주입 표와 발동 배지가 비어 있게 된다`);
    }

    // 요술봉(#extensionsMenu) 항목 — 패널을 여는 유일한 동선이다.
    // 부착 방식 선례: gallery/index.js:801 (extensionsMenu 직접), token-counter/index.js:105 (항목 마크업)
    const wandHtml = `
        <div id="jev_lorebook_wand_container" class="extension_container">
            <div id="jev_lorebook_wand_item" class="list-group-item flex-container flexGap5">
                <div class="fa-solid fa-book extensionsMenuExtensionButton"></div>
                <span></span>
            </div>
        </div>`;
    $('#extensionsMenu').append(wandHtml);
    $('#jev_lorebook_wand_item').find('span').text(DISPLAY_NAME);
    $('#jev_lorebook_wand_item').on('click', openDetailPanel);

    console.log(`${LOG} 로드 완료 v0.19.0 — flavor=keeper, core=src/core.js`);
});
