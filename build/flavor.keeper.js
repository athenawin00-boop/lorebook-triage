/**
 * flavor 상수 — **논제브 로어북(lorebook-keeper) 배포본용.**
 * 빌드 시 `scripts/build-keeper.mjs`가 이 파일을 `src/flavor.js` 자리에 갈아끼운다.
 *
 * ⚠️ 여기 있는 것은 **표시 문자열과 모듈 네임스페이스**뿐이다.
 * DOM id(`jev_lorebook_*`)와 설정 필드명은 절대 flavor화하지 않는다 — 바꾸면 기존 사용자의
 * 저장된 설정이 증발한다. chat_metadata 키 상수도 core.js에 `jevLorebook*` 값으로 고정이다:
 * 두 확장이 변환 지점·작중 앵커·되돌리기 스냅샷을 **공유**해서, 제브에서 논제브로 갈아타도
 * 이력이 끊기지 않고 이어지는 게 사양이다.
 */

/** 'jev' | 'keeper' — 분기용 태그. 가능하면 이 값 대신 훅 등록 여부로 갈라라. */
export const FLAVOR = 'keeper';

/** extension_settings 네임스페이스. 두 확장은 설정을 공유하지 않는다. */
export const MODULE = 'lorebookKeeper';

/** renderExtensionTemplateAsync 경로 = 깃허브 레포명 = 설치 폴더명. 어긋나면 패널이 조용히 안 열린다. */
export const TEMPLATE_PATH = 'third-party/lorebook-keeper';

/** console 프리픽스 */
export const LOG = '[논제브 로어북]';

/** 화면에 나가는 제품명 (toastr 제목·패널 머리글) */
export const DISPLAY_NAME = '논제브 로어북';

/** 상대 확장(자매 배포본) — 상호 배제 감지 대상 */
export const PEER_MODULE = 'jevLorebook';
export const PEER_DISPLAY_NAME = '제브 로어북';

/** 런타임 로드 마커. extension_settings 단독 판정은 미설치 잔존 설정으로 오탐한다 → 마커와 AND. */
export const SELF_GLOBAL_MARKER = 'lorebookKeeperLoaded';
export const PEER_GLOBAL_MARKER = 'jevLorebookLoaded';
