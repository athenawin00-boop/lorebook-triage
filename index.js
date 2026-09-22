/**
 * Jev Lorebook — 로어북 장기기억을 벡터 검색 + Jev 3축 판정으로 주입하는 확장 (v0.19.0)
 *
 * 흐름 (매 생성, generate_interceptor):
 *   최근 유저 메시지 3개 + 직전 캐릭 응답 1개 → /api/vector/query → 후보 topK
 *   → Jev(TypeSafe System One) 3축 병렬 판정 (모순위험 / 장면적합 / 최근중복)
 *   → 점수순 정렬 → 북별 토큰 예산까지 채택 → WORLDINFO_FORCE_ACTIVATE 로 주입
 *
 * ── v0.19.0 소스 구조 (자매 배포본 '논제브 로어북'과 코어를 공유한다) ────────────
 *   index.js        이 파일. 얇은 엔트리 — flavor+core+jev를 물리고, 훅을 등록하고, 부팅한다
 *   src/flavor.js   배포본마다 다른 유일한 JS (표시명·모듈 네임스페이스·템플릿 경로)
 *   src/hooks.js    훅 레지스트리 (양쪽 바이트 동일)
 *   src/core.js     공용 코어 — 변환 파이프라인·되돌리기·스플릿·패널 공용부 (양쪽 바이트 동일)
 *   src/jev.js      제브 전용 — Jev 판정·벡터/임베딩·랜덤 주입·파라미터 오버라이드
 *   src/keeper.js   논제브 전용 — 이 배포본에서는 **import하지 않는다**(빌드 시 제외)
 *
 * 왜 이렇게 쪼갰나: 변환 파이프라인 버그를 한 번 고치면 양쪽 배포본에 같이 반영돼야 한다.
 * 그 성립 근거가 `src/core.js`의 **바이트 동일**이다 — core를 고치는 순간 양쪽이 같이 바뀐다.
 * 한쪽에만 필요한 동작은 core에 `if (flavor === …)`를 넣지 말고 훅으로 뺀다.
 *
 * 폴백 없음: Jev 키 없음/호출 실패 = toastr 1회 + 이번 턴 주입 0.
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
} from './src/core.js';
import {
    indexLorebook,
    populateEmbeddingSourceSelect,
    populateWorldSelect,
    renderDetectionSummary,
    renderLayerList,
    resetRandomCooldown,
    updateEmbeddingSourceUi,
    indexWorld,
    vectorInsert,
    vectorList,
    getBudgetTokens,
    renderPanelJudgment,
    renderSummaryJevRows,
    openInjectionSettingsPopup,
    lastReport,
    lastError,
    lastRandomKeys,
} from './src/jev.js';

// ── 훅 등록 ─────────────────────────────────────────────────────────────
// core는 이 표에 실린 것만 부를 수 있다. 미등록 훅은 '그 기능이 없는 것'으로 동작한다.
// 상태 3개(lastReport·lastError·lastRandomKeys)는 ESM 라이브 바인딩이라 jev.js가 재대입해도
// 여기 화살표 함수가 항상 최신 값을 돌려준다 — 별도 setter가 필요 없다.
registerHooks({
    indexWorld,
    onEntryDemoted: vectorInsert,   // 코어 → 검색층 강등 시 그 항목만 단건 삽입 (임베딩 1회)
    vectorList,
    budgetTokens: getBudgetTokens,
    renderPanelJudgment,
    summaryRows: renderSummaryJevRows,
    openInjectionSettings: openInjectionSettingsPopup,
    lastReport: () => lastReport,
    lastError: () => lastError,
    randomKeys: () => lastRandomKeys,
});

// 런타임 로드 마커 — 상대 확장(논제브 로어북)이 '켜져 있는지'를 판정할 때 AND 조건으로 쓴다.
// extension_settings 단독 판정은 확장을 지운 뒤 남은 설정으로 오탐한다.
globalThis[SELF_GLOBAL_MARKER] = true;

jQuery(async () => {
    const settings = getSettings();

    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    $('#extensions_settings2').append(html);
    $('#jev_lorebook_title').text(DISPLAY_NAME);

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
            invalidateWorldLayerCache(); // 캐시 무효화 지점 ① — 감지 대상은 채팅에 딸려 바뀐다
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
            invalidateWorldLayerCache(); // 캐시 무효화 지점 ② — 로어북 목록·연결이 바뀜
            populateWorldSelect();
            void renderLayerList();
            void renderDetectionSummary();
        });
    }

    // 이번 턴 실제 주입 관측 (v0.9.0) — world-info.js:902 emit, isDryRun 턴에는 안 온다.
    // 인자는 활성화된 전체 엔트리 배열. 최신 1턴만 스냅샷으로 들고 있는다(패널 표시 전용).
    if (event_types.WORLD_INFO_ACTIVATED) {
        eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
            recordActivatedEntries(entries);
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
                <span></span>
            </div>
        </div>`;
    $('#extensionsMenu').append(wandHtml);
    $('#jev_lorebook_wand_item').find('span').text(DISPLAY_NAME);
    $('#jev_lorebook_wand_item').on('click', openDetailPanel);

    console.log(`${LOG} 로드 완료 v0.19.0 — flavor=jev, core=src/core.js`);
});
