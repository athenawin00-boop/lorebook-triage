/**
 * 훅 레지스트리 — 제브 로어북 / 논제브 로어북 **양쪽 배포본에서 바이트 동일**한 파일이다 (v0.19.0).
 *
 * 왜 있나: `src/core.js`는 양쪽이 공유하는 파일이라 flavor 전용부(src/jev.js·src/keeper.js)를
 * 직접 import할 수 없다 — import하면 core가 배포본마다 달라지고 순환 의존도 생긴다.
 * core는 `hooks.foo?.()`로만 저쪽을 부르고, 등록은 루트 index.js가 부팅 때 한 번 한다.
 *
 * 방향 규칙: core → flavor는 **훅만**, flavor → core는 **import 허용**.
 * 훅이 등록되지 않으면 그 기능은 그냥 없는 것으로 동작해야 한다(조용한 오작동 금지).
 *
 * 등록되는 훅 (전부 선택):
 *   indexWorld(world, onProgress) -> Promise<number>   로어북 1개 색인 (제브 전용)
 *   onEntryDemoted(world, items)  -> Promise           코어→검색층 강등 시 단건 벡터 삽입 (제브 전용)
 *   vectorList(world)             -> Promise<Set|null> 색인 대조용 저장 해시 (제브 전용)
 *   budgetTokens(world, layer)    -> number            북별 유효 주입 예산 (제브 전용)
 *   renderPanelJudgment($box, rejected)                Jev 탈락 후보 표
 *   summaryRows($summary, row, worlds, settings)       패널 상태 요약의 제브 전용 3행
 *   lastReport() / lastError() / randomKeys()          직전 턴 판정 상태 조회
 *   openInjectionSettings()                            주입 세부 설정 팝업
 *   beforeConvert()               -> Promise<boolean>  변환 시작 전 게이트 (논제브 팝업 3옵션)
 *   decorateNewEntry(entry, inc)                       변환이 만든 항목에 flavor 후처리 (키·constant)
 *   guardEnable(action)           -> Promise<boolean>  상호 배제 검사 (양쪽 공용부에서 호출)
 */

/** 변경 가능한 단일 객체. core는 이 객체만 본다 — 재할당하지 말고 registerHooks로 채운다. */
export const hooks = {};

/** flavor 부팅부가 자기 구현을 얹는다. 여러 번 불러도 되지만 같은 키는 마지막 것이 이긴다. */
export function registerHooks(obj) {
    Object.assign(hooks, obj ?? {});
    return hooks;
}
