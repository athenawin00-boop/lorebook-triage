/**
 * ST 없이 돌리는 단위검증 — src/core.js의 판단 로직만 떼어 돌린다 (v0.19.0).
 *
 *   node tests/core-logic.test.mjs
 *
 * ⚠️ 복붙하지 않는다. 대상 파일을 읽어 **프로그램으로 함수 본문을 잘라내고** `new Function`에
 * 스텁을 주입한다 — 복붙본은 원본과 어긋나는 순간 검증이 거짓말을 한다.
 * 덮는 것: 순수 로직(키 정제·파서·상태 순환·발동 판정·상대 감지).
 * 안 덮는 것: 실제 생성 호출·실DOM·이벤트·업그레이드 첫 로드 → 그건 E2E다.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const CORE = path.join(HERE, '..', 'src', 'core.js');
const src = fs.readFileSync(CORE, 'utf8');

// ── 커터 ────────────────────────────────────────────────────────────────
function cutFn(header) {
    const i = src.indexOf(header);
    if (i < 0) throw new Error('헤더 없음: ' + header);
    const j = src.indexOf('\n}\n', i);
    if (j < 0) throw new Error('함수 끝 못 찾음: ' + header);
    return src.slice(i, j + 3);
}
function cutBlock(header, tail) {
    const i = src.indexOf(header);
    if (i < 0) throw new Error('헤더 없음: ' + header);
    const j = src.indexOf(tail, i);
    if (j < 0) throw new Error('블록 끝 못 찾음: ' + header);
    return src.slice(i, j + tail.length);
}
function cutConst(name) {
    // ⚠️ `;$` 앵커 금지 — 이 레포는 상수 뒤에 한 줄 주석이 붙는다. 첫 세미콜론까지만 잡는다.
    const re = new RegExp('^(?:export )?const ' + name + " = [^\\n;]*;", 'm');
    const m = src.match(re);
    if (!m) throw new Error('상수 없음: ' + name);
    return m[0];
}

const pieces = [
    cutConst('ENTRY_KEY_RE'),
    cutConst('ENTRY_KEY_MAX'),
    cutBlock('const ENTRY_KEY_STOPWORDS = new Set([', '\n]);'),
    cutFn('export function sanitizeEntryKeys(raw) {'),
    cutFn('export function parseConversionOutput(text) {'),
    cutConst('ENTRY_STATE_CORE'),
    cutConst('ENTRY_STATE_SEARCH'),
    cutConst('ENTRY_STATE_OFF'),
    cutConst('NORMAL_ORDER'),
    cutConst('CORE_RULES_ORDER'),
    cutFn('export function getEntryState(entry) {'),
    cutFn('export function planEntryStateCycle(entry) {'),
    'let lastActivated = null;',
    cutFn('export function recordActivatedEntries(entries) {'),
    cutFn('export function isRecentlyActivated(world, uid) {'),
    cutFn('export function isPeerActive() {'),
].map(s => s.replace(/^export /gm, ''));

const joined = pieces.join('\n');
// 잘라낸 범위 단언 — indexOf('\n}\n')가 중간 괄호에 먼저 걸릴 수 있다
for (const need of [
    'ENTRY_KEY_STOPWORDS.has(key)', 'out.length >= ENTRY_KEY_MAX',
    'current.keys = sanitizeEntryKeys(current.keywords)',
    'order: CORE_RULES_ORDER', 'globalThis[PEER_GLOBAL_MARKER]',
]) {
    if (!joined.includes(need)) throw new Error('잘라낸 범위에 없음: ' + need);
}

function build(env = {}) {
    const f = new Function(
        'extension_settings', 'PEER_MODULE', 'PEER_GLOBAL_MARKER', 'globalThis', 'console',
        joined + '\nreturn { sanitizeEntryKeys, parseConversionOutput, planEntryStateCycle,'
               + ' getEntryState, recordActivatedEntries, isRecentlyActivated, isPeerActive };',
    );
    return f(
        env.extension_settings ?? {},
        env.PEER_MODULE ?? 'lorebookKeeper',
        env.PEER_GLOBAL_MARKER ?? 'lorebookKeeperLoaded',
        env.globalThis ?? {},
        { log() {}, warn() {}, error() {} },   // 진단 로그가 케이스 출력을 덮지 않게
    );
}

// ── 러너 ────────────────────────────────────────────────────────────────
let pass = 0; const fails = [];
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; } else { fails.push({ name, got: g, want: w }); }
}

const m = build();

// ── 1. sanitizeEntryKeys 경계 케이스 ────────────────────────────────────
eq('정상 3개 통과', m.sanitizeEntryKeys(['Baron', 'voodoo', 'Zion']), ['baron', 'voodoo', 'zion']);
eq('대문자 → 소문자 정규화', m.sanitizeEntryKeys(['BARON']), ['baron']);
eq('한글 키워드 탈락', m.sanitizeEntryKeys(['바론', '클럽']), []);
eq('한글+영문 혼합 탈락', m.sanitizeEntryKeys(['클럽zion']), []);
eq('두 단어 구절 탈락', m.sanitizeEntryKeys(['club zion', "baron's club"]), []);
eq('아포스트로피·하이픈 단일어는 통과', m.sanitizeEntryKeys(["o'brien", 'mid-town']), ["o'brien", 'mid-town']);
eq('중복 제거(대소문자 무시)', m.sanitizeEntryKeys(['Baron', 'baron', 'BARON']), ['baron']);
eq('6개 초과 → 상한 5', m.sanitizeEntryKeys(['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg']), ['aa', 'bb', 'cc', 'dd', 'ee']);
eq('스톱워드만 → 빈 배열', m.sanitizeEntryKeys(['love', 'night', 'he', 'the', 'people']), []);
eq('스톱워드 섞임 → 나머지만', m.sanitizeEntryKeys(['love', 'Tucker', 'night', 'Laurie']), ['tucker', 'laurie']);
eq('빈 값·공백·null 탈락', m.sanitizeEntryKeys(['', '   ', null, undefined, 'ok']), ['ok']);
eq('숫자·날짜 탈락', m.sanitizeEntryKeys(['2025-08-26', '42']), []);
eq('배열 아님 → 빈 배열', m.sanitizeEntryKeys('baron'), []);
eq('null 입력 → 빈 배열', m.sanitizeEntryKeys(null), []);
eq('undefined 입력 → 빈 배열', m.sanitizeEntryKeys(undefined), []);
// 상한은 '정제 후 5개'다 — 탈락분이 자리를 먹으면 안 된다
eq('탈락분이 상한을 먹지 않는다',
    m.sanitizeEntryKeys(['love', 'night', 'the', 'aa', 'bb', 'cc', 'dd', 'ee', 'ff']),
    ['aa', 'bb', 'cc', 'dd', 'ee']);

// ── 2. parseConversionOutput — Keywords 배관 부활 ────────────────────────
const OUT_OK = [
    '### 2026-05-12 — Tucker Reads the File',
    'Keywords: Tucker, Laurie, file',
    'Tucker opened the folder and read it aloud.',
    '',
    '### 2026-05-13 — Night at the Club',
    'Keywords: club zion, 바론, love, Baron, Baron',
    'They went to the club.',
].join('\n');
const p1 = m.parseConversionOutput(OUT_OK);
eq('사건 2건 파싱', p1.incidents.length, 2);
eq('keys 정제 결과 #1', p1.incidents[0].keys, ['tucker', 'laurie', 'file']);
eq('keys 정제 결과 #2 (구절·한글·스톱워드·중복 제거)', p1.incidents[1].keys, ['baron']);
eq('본문 보존', p1.incidents[0].body, 'Tucker opened the folder and read it aloud.');
eq('Keywords 줄은 본문에 안 남는다', p1.incidents[0].body.includes('Keywords'), false);

const p2 = m.parseConversionOutput('### 2026-05-12 — No Keywords Line\nJust a body line.');
eq('Keywords 줄 없음 → keys 빈 배열', p2.incidents[0].keys, []);
eq('Keywords 줄 없어도 사건은 살아남는다', p2.incidents.length, 1);

const p3 = m.parseConversionOutput('### 2026-05-12 — Empty Keywords\nKeywords:\nBody here.');
eq('빈 Keywords 값 → keys 빈 배열', p3.incidents[0].keys, []);

eq('빈 입력 → 사건 0', m.parseConversionOutput('').incidents.length, 0);
eq('null 입력 → 사건 0', m.parseConversionOutput(null).incidents.length, 0);

const p4 = m.parseConversionOutput([
    '### 2026-05-12 — With Core',
    'Keywords: Tucker',
    'Body.',
    '### CORE STATE',
    'Keywords: ShouldBeDropped',
    '- rule line',
].join('\n'));
eq('코어 섹션 분리', p4.core, '- rule line');
eq('코어 섹션의 Keywords 줄은 버린다', p4.core.includes('ShouldBeDropped'), false);
eq('코어 앞 사건은 정상', p4.incidents[0].keys, ['tucker']);

// ── 3. 3상태 순환 회귀 (리팩터로 안 깨졌나) ─────────────────────────────
eq('🔵 → 🟢 강등 (벡터 삽입 필요)',
    m.planEntryStateCycle({ constant: true }),
    { from: 'core', to: 'search', patch: { constant: false, order: 100 }, needsIndex: true });
eq('🟢 → ⚫ 끄기 (임베딩 0회)',
    m.planEntryStateCycle({ constant: false }),
    { from: 'search', to: 'off', patch: { disable: true }, needsIndex: false });
eq('⚫ → 🔵 승격 (order 같이 올림)',
    m.planEntryStateCycle({ disable: true, constant: false }),
    { from: 'off', to: 'core', patch: { disable: false, constant: true, order: 1000 }, needsIndex: false });
eq('꺼진 파랑도 ⚫로 본다', m.getEntryState({ disable: true, constant: true }), 'off');
eq('꺼진 파랑 → 🔵 복귀 (도달 가능성 유지)',
    m.planEntryStateCycle({ disable: true, constant: true }).to, 'core');

// ── 4. 발동 배지 판정 ───────────────────────────────────────────────────
const a = build();
eq('스냅샷 없으면 발동 아님', a.isRecentlyActivated('카마엘', 2), false);
a.recordActivatedEntries([{ world: '카마엘', uid: 2, comment: 'x', content: 'y', constant: false, key: ['Tucker'] }]);
eq('스냅샷에 있으면 발동됨', a.isRecentlyActivated('카마엘', 2), true);
eq('uid 문자열/숫자 혼용 허용', a.isRecentlyActivated('카마엘', '2'), true);
eq('다른 북은 발동 아님', a.isRecentlyActivated('노엘', 2), false);
eq('다른 uid는 발동 아님', a.isRecentlyActivated('카마엘', 3), false);
a.recordActivatedEntries(null);
eq('비배열 입력 → 빈 스냅샷', a.isRecentlyActivated('카마엘', 2), false);
const a2 = build();
a2.recordActivatedEntries([{ world: 'w', uid: 1 }]);
eq('key 없는 엔트리도 빈 배열로 착지', a2.isRecentlyActivated('w', 1), true);

// ── 5. 상대 확장 감지 — 런타임 마커 AND 설정 ────────────────────────────
eq('마커 없고 설정 없음 → 비활성', build().isPeerActive(), false);
eq('설정만 있고 마커 없음 → 비활성 (미설치 잔존 설정 오탐 차단)',
    build({ extension_settings: { lorebookKeeper: { enabled: true } }, globalThis: {} }).isPeerActive(), false);
eq('마커만 있고 설정 꺼짐 → 비활성',
    build({ extension_settings: { lorebookKeeper: { enabled: false } }, globalThis: { lorebookKeeperLoaded: true } }).isPeerActive(), false);
eq('마커 + 설정 켜짐 → 활성',
    build({ extension_settings: { lorebookKeeper: { enabled: true } }, globalThis: { lorebookKeeperLoaded: true } }).isPeerActive(), true);
eq('마커 있고 설정 레코드 자체가 없음 → 비활성',
    build({ extension_settings: {}, globalThis: { lorebookKeeperLoaded: true } }).isPeerActive(), false);
eq('enabled가 truthy 문자열이어도 === true가 아니면 비활성',
    build({ extension_settings: { lorebookKeeper: { enabled: 'yes' } }, globalThis: { lorebookKeeperLoaded: true } }).isPeerActive(), false);

// ── 결과 ────────────────────────────────────────────────────────────────
for (const f of fails) console.log(`FAIL  ${f.name}\n      got  ${f.got}\n      want ${f.want}`);
console.log(`\npass ${pass} / fail ${fails.length}`);
process.exit(fails.length ? 1 : 0);
