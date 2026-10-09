/**
 * ST 없이 돌리는 단위검증 — src/jev.js의 증분 색인·한도 대기 로직만 떼어 돌린다 (v0.20.0).
 *
 *   node tests/index-incremental.test.mjs
 *
 * ⚠️ 복붙하지 않는다. 대상 파일을 읽어 **프로그램으로 함수 본문을 잘라내고** `new Function`에
 * 스텁을 주입한다 — 복붙본은 원본과 어긋나는 순간 검증이 거짓말을 한다.
 * 덮는 것: 증분 차집합(추가·삭제·본문변경·끄기·코어승격·중복 dedupe) / 배치 재시도·한도 대기·중단.
 * 안 덮는 것: 실제 임베딩 호출·실DOM·버튼 라벨·실제 분당 한도 재현 → 그건 E2E다.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const JEV = path.join(HERE, '..', 'src', 'jev.js');
const src = fs.readFileSync(JEV, 'utf8');

// ── 커터 ────────────────────────────────────────────────────────────────
function cutFn(header) {
    const i = src.indexOf(header);
    if (i < 0) throw new Error('헤더 없음: ' + header);
    const j = src.indexOf('\n}\n', i);
    if (j < 0) throw new Error('함수 끝 못 찾음: ' + header);
    return src.slice(i, j + 3);
}
function cutConst(name) {
    // ⚠️ `;$` 앵커 금지 — 이 레포는 상수 뒤에 한 줄 주석이 붙는다. 첫 세미콜론까지만 잡는다.
    const re = new RegExp('^(?:export )?(?:const|let) ' + name + ' = [^\\n;]*;', 'm');
    const m = src.match(re);
    if (!m) throw new Error('상수 없음: ' + name);
    return m[0];
}

const pieces = [
    cutConst('INSERT_CHUNK'),
    cutConst('RATE_LIMIT_WAIT_MS'),
    cutConst('MAX_RATE_LIMIT_RETRIES'),
    cutConst('indexRunning'),
    cutConst('indexAbortRequested'),
    cutFn('export function requestIndexAbort() {'),
    cutFn('export function isIndexing() {'),
    cutFn('function indexStopError(kind, inserted) {'),
    cutFn('async function waitForRateLimit(onProgress, label) {'),
    cutFn('async function insertInBatches(world, items, onProgress, label) {'),
    cutFn('export async function indexWorld(world, onProgress, options) {'),
].map(s => s.replace(/^export /gm, ''));

const joined = pieces.join('\n\n');
// 잘라낸 범위 단언 — indexOf('\n}\n')가 중간의 컬럼0 '}'에 먼저 걸릴 수 있다
for (const need of [
    'retriesUsed >= MAX_RATE_LIMIT_RETRIES',
    'inserted === 0 && attempt >= 2',
    'await vectorDelete(world, toDelete)',
    "options?.mode === 'full'",
    'wanted.has(hash)',
]) {
    if (!joined.includes(need)) throw new Error('잘라낸 범위에 없음: ' + need);
}

// ── 하네스 ──────────────────────────────────────────────────────────────
/** 케이스마다 새로 부른다 — 모듈 레벨 가변 상태(indexRunning·indexAbortRequested)를 클로저가 캡처한다. */
function build(env = {}) {
    const calls = { purge: [], insert: [], delete: [], list: 0, sleep: 0, progress: [], order: [] };
    const entries = env.entries ?? [];
    const stored = new Set(env.stored ?? []);
    // 임베딩 호출 결과 시나리오: 배치 순번마다 'ok' 또는 Error를 돌려준다
    let insertSeq = 0;
    const insertPlan = env.insertPlan ?? [];

    const stubs = {
        // cyrb53을 흉내 내지 않는다 — 검증 대상은 '같은 본문이면 같은 수'라는 성질뿐이다
        getStringHash: (text) => {
            let h = 0;
            for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
            return h;
        },
        loadWorldInfo: async () => (env.worldData === null ? null : { entries: entries }),
        vectorList: async () => { calls.list++; return new Set(stored); },
        vectorPurge: async (w) => { calls.purge.push(w); calls.order.push('purge'); },
        vectorDelete: async (w, hashes) => {
            if (hashes?.length) { calls.delete.push([...hashes]); calls.order.push('delete'); }
        },
        vectorInsert: async (w, batch) => {
            const plan = insertPlan[insertSeq++] ?? 'ok';
            calls.insert.push({ plan: plan, hashes: batch.map(b => b.hash) });
            calls.order.push('insert');
            if (plan !== 'ok') throw plan;
        },
        getCollectionId: (w) => 'col_' + w,
        sleep: async () => { calls.sleep++; },     // 대기는 즉시화 — 검증 대상은 산식이지 벽시계가 아니다
        console: { log() {}, warn() {}, error() {} },
        LOG: '[test]',
    };

    const f = new Function(
        'getStringHash', 'loadWorldInfo', 'vectorList', 'vectorPurge', 'vectorDelete',
        'vectorInsert', 'getCollectionId', 'sleep', 'console', 'LOG',
        joined + '\nreturn { indexWorld, insertInBatches, requestIndexAbort, isIndexing,'
               + ' setRunning: (v) => { indexRunning = v; },'
               + ' setAbort: (v) => { indexAbortRequested = v; } };');

    const api = f(stubs.getStringHash, stubs.loadWorldInfo, stubs.vectorList, stubs.vectorPurge,
        stubs.vectorDelete, stubs.vectorInsert, stubs.getCollectionId, stubs.sleep, stubs.console, stubs.LOG);
    api.calls = calls;
    api.hash = stubs.getStringHash;
    api.onProgress = (t) => calls.progress.push(t);
    return api;
}

const entry = (uid, content, extra = {}) => ({ uid: uid, content: content, ...extra });
const rate500 = () => Object.assign(
    new Error('벡터 insert 실패 (HTTP 500) — SillyTavern 서버 콘솔(터미널)에 실제 사유가 찍혀 있어요'),
    { status: 500 });
const bad400 = () => Object.assign(new Error('벡터 insert 실패 (HTTP 400)'), { status: 400 });

let pass = 0;
const fails = [];
function eq(name, got, want) {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
    fails.push({ name: name, got: JSON.stringify(got), want: JSON.stringify(want) });
}

// ── 1. 증분 차집합 ──────────────────────────────────────────────────────
{
    // 추가 — 저장된 게 하나도 없으면 전부 새로
    const a = build({ entries: [entry(1, 'A'), entry(2, 'B')] });
    const stats = { added: 0, removed: 0, kept: 0 };
    const n = await a.indexWorld('w', a.onProgress, { stats: stats });
    eq('추가: 반환값 = 색인 대상 수', n, 2);
    eq('추가: insert 1배치 2건', a.calls.insert.map(c => c.hashes.length), [2]);
    eq('추가: delete 0건', a.calls.delete, []);
    eq('추가: purge 안 함', a.calls.purge, []);
    eq('추가: stats', stats, { added: 2, removed: 0, kept: 0 });
}
{
    // 삭제 — 로어북에서 사라진 항목의 hash는 색인에서 치운다
    const h = build().hash;
    const a = build({ entries: [entry(1, 'A')], stored: [h('A'), h('지워진 항목')] });
    const stats = { added: 0, removed: 0, kept: 0 };
    await a.indexWorld('w', a.onProgress, { stats: stats });
    eq('삭제: insert 0회 (임베딩 안 부름)', a.calls.insert.length, 0);
    eq('삭제: delete 대상 1건', a.calls.delete, [[h('지워진 항목')]]);
    eq('삭제: stats', stats, { added: 0, removed: 1, kept: 1 });
}
{
    // 본문 변경 — 옛 hash를 지우고 새 hash를 넣는다
    const h = build().hash;
    const a = build({ entries: [entry(1, '고친 본문')], stored: [h('옛 본문')] });
    await a.indexWorld('w', a.onProgress);
    eq('본문변경: insert 1건', a.calls.insert.map(c => c.hashes), [[h('고친 본문')]]);
    eq('본문변경: delete 1건', a.calls.delete, [[h('옛 본문')]]);
}
{
    // 끄기(disable) · 코어 승격(constant) · 빈 본문 → 전부 색인 대상에서 빠지므로 치운다
    const h = build().hash;
    const a = build({
        entries: [entry(1, 'A'), entry(2, 'B', { disable: true }), entry(3, 'C', { constant: true }), entry(4, '  ')],
        stored: [h('A'), h('B'), h('C'), h('  ')],
    });
    const stats = { added: 0, removed: 0, kept: 0 };
    await a.indexWorld('w', a.onProgress, { stats: stats });
    eq('꺼짐·코어승격: insert 0회', a.calls.insert.length, 0);
    eq('꺼짐·코어승격: 3건 정리', a.calls.delete[0].length, 3);
    eq('꺼짐·코어승격: stats', stats, { added: 0, removed: 3, kept: 1 });
}
{
    // 본문이 똑같은 항목 2개 = hash 1개. 같은 hash를 두 번 넣지 않는다
    const a = build({ entries: [entry(7, '같은 본문'), entry(9, '같은 본문')] });
    const n = await a.indexWorld('w', a.onProgress);
    eq('본문 동일 2개: 반환 1', n, 1);
    eq('본문 동일 2개: insert 1건만', a.calls.insert[0].hashes.length, 1);
    eq('본문 동일 2개: index는 먼저 만난 uid', a.calls.insert.length, 1);
}
{
    // 변경 0 → 임베딩도 삭제도 0회
    const h = build().hash;
    const a = build({ entries: [entry(1, 'A'), entry(2, 'B')], stored: [h('A'), h('B')] });
    const stats = { added: 0, removed: 0, kept: 0 };
    const n = await a.indexWorld('w', a.onProgress, { stats: stats });
    eq('변경0: 반환 = 전체 개수', n, 2);
    eq('변경0: insert 0회', a.calls.insert.length, 0);
    eq('변경0: delete 0회', a.calls.delete.length, 0);
    eq('변경0: 진행표시도 안 띄움', a.calls.progress, []);
    eq('변경0: stats', stats, { added: 0, removed: 0, kept: 2 });
}
{
    // 진행 표시 문구 — 새로 N · 정리 N · 이미 됨 N
    const h = build().hash;
    const a = build({ entries: [entry(1, 'A'), entry(2, 'NEW')], stored: [h('A'), h('OLD')] });
    await a.indexWorld('카마엘', a.onProgress);
    eq('진행표시 첫 줄', a.calls.progress[0], '카마엘: 새로 1 · 정리 1 · 이미 됨 1');
}
{
    // 지우기 먼저, 넣기 나중 (요구 6) — 실제 호출 순서를 잰다
    const h = build().hash;
    const a = build({ entries: [entry(1, 'NEW'), entry(2, 'ALSO')], stored: [h('OLD')] });
    await a.indexWorld('w', a.onProgress);
    eq('순서: delete가 insert보다 먼저', a.calls.order, ['delete', 'insert']);
}
{
    // 지울 게 없으면 delete 호출 자체가 없다 (빈 배열로 왕복하지 않는다)
    const h = build().hash;
    const a = build({ entries: [entry(1, 'A'), entry(2, 'B')], stored: [h('A')] });
    await a.indexWorld('w', a.onProgress);
    eq('지울 게 없으면 delete 생략', a.calls.order, ['insert']);
}
{
    // 못 읽은 로어북 — purge·delete·insert 전부 0 (멀쩡한 색인을 지우지 않는다)
    const a = build({ worldData: null, stored: [1, 2, 3] });
    const n = await a.indexWorld('w', a.onProgress);
    eq('읽기 실패: 반환 0', n, 0);
    eq('읽기 실패: list 조회도 안 함', a.calls.list, 0);
    eq('읽기 실패: delete 0', a.calls.delete.length, 0);
    eq('읽기 실패: purge 0', a.calls.purge.length, 0);
}

// ── 2. 전체 재색인 ──────────────────────────────────────────────────────
{
    const entries = Array.from({ length: 45 }, (_, i) => entry(i, 'E' + i));
    const a = build({ entries: entries, stored: [] });
    const stats = { added: 0, removed: 0, kept: 0 };
    const n = await a.indexWorld('w', a.onProgress, { mode: 'full', stats: stats });
    eq('full: purge 1회', a.calls.purge, ['w']);
    eq('full: list 조회 안 함', a.calls.list, 0);
    eq('full: 20개 배치 3번 (20/20/5)', a.calls.insert.map(c => c.hashes.length), [20, 20, 5]);
    eq('full: 반환 45', n, 45);
    eq('full: stats.added 45', stats.added, 45);
}

// ── 3. 분당 한도 대기·재시도·중단 ───────────────────────────────────────
{
    // 가짜 500 → 65초 대기 → 같은 배치 재시도 성공
    const entries = Array.from({ length: 25 }, (_, i) => entry(i, 'E' + i));
    const a = build({ entries: entries, insertPlan: ['ok', rate500(), 'ok'] });
    const n = await a.indexWorld('w', a.onProgress);
    eq('500→대기→성공: 반환 25', n, 25);
    eq('500→대기→성공: insert 3회(20 / 5실패 / 5성공)', a.calls.insert.map(c => c.hashes.length), [20, 5, 5]);
    eq('500→대기→성공: 65초 카운트다운', a.calls.sleep, 65);
    const wait = a.calls.progress.find(t => t.includes('요청 한도에 걸렸어요'));
    eq('500→대기→성공: 카운트다운 문구', typeof wait === 'string' && wait.includes('65초'), true);
}
{
    // 첫 배치부터 연속 실패 → 한도가 아니라 키·모델 문제. 원본 에러(서버 콘솔 안내)를 그대로 올린다
    const a = build({ entries: [entry(1, 'A')], insertPlan: [rate500(), rate500()] });
    let err = null;
    try { await a.indexWorld('w', a.onProgress); } catch (e) { err = e; }
    eq('첫 배치 연속 실패: 중단됨', !!err, true);
    eq('첫 배치 연속 실패: indexStop 아님(진짜 에러)', err?.indexStop, undefined);
    eq('첫 배치 연속 실패: 서버 콘솔 문구 유지', String(err?.message).includes('서버 콘솔'), true);
    eq('첫 배치 연속 실패: 대기는 1회만', a.calls.sleep, 65);
}
{
    // 3회 재시도 초과 → 중단 안내 (넣은 것은 남는다)
    const entries = Array.from({ length: 100 }, (_, i) => entry(i, 'E' + i));
    const a = build({
        entries: entries,
        insertPlan: ['ok', rate500(), rate500(), rate500(), rate500()],
    });
    let err = null;
    try { await a.indexWorld('w', a.onProgress); } catch (e) { err = e; }
    eq('3회 초과: indexStop=limit', err?.indexStop, 'limit');
    eq('3회 초과: 20개까지 들어감', err?.inserted, 20);
    eq('3회 초과: 이어서 하라는 안내', String(err?.message).includes('[색인]을 다시 누르면 이어서 해요'), true);
    eq('3회 초과: 대기 3회 = 195초', a.calls.sleep, 195);
}
{
    // 4xx는 기다려도 안 풀린다 → 즉시 중단, 대기 0회
    const a = build({ entries: [entry(1, 'A')], insertPlan: [bad400()] });
    let err = null;
    try { await a.indexWorld('w', a.onProgress); } catch (e) { err = e; }
    eq('4xx: 즉시 중단', String(err?.message).includes('HTTP 400'), true);
    eq('4xx: 대기 0회', a.calls.sleep, 0);
}
{
    // 중단 요청 — 대기 중에도 먹고, 들어간 것은 남는다
    const entries = Array.from({ length: 60 }, (_, i) => entry(i, 'E' + i));
    const a = build({ entries: entries, insertPlan: ['ok', rate500()] });
    a.setRunning(true);
    let err = null;
    try {
        await a.indexWorld('w', (t) => {
            // 카운트다운이 시작되면 바로 중단을 누른 상황
            if (t.includes('요청 한도에 걸렸어요')) a.requestIndexAbort();
        });
    } catch (e) { err = e; }
    eq('중단: indexStop=abort', err?.indexStop, 'abort');
    eq('중단: 20개까지 들어감(남는다)', err?.inserted, 20);
    eq('중단: 대기 도중에 끊김(65초 미만)', a.calls.sleep < 65, true);
    eq('중단: 추가 insert 없음', a.calls.insert.length, 2);
}
{
    // 안 돌고 있을 때의 중단 요청은 무시된다 (다음 색인이 시작하자마자 죽지 않게)
    const a = build({ entries: [entry(1, 'A')] });
    a.requestIndexAbort();
    const n = await a.indexWorld('w', a.onProgress);
    eq('비실행 중 중단요청 무시: 정상 색인', n, 1);
    eq('비실행 중 중단요청 무시: isIndexing false', a.isIndexing(), false);
}

// ── 결과 ────────────────────────────────────────────────────────────────
for (const f of fails) console.log(`FAIL  ${f.name}\n      got  ${f.got}\n      want ${f.want}`);
console.log(`\npass ${pass} / fail ${fails.length}`);
process.exit(fails.length ? 1 : 0);
