#!/usr/bin/env node
/**
 * NonJev Lorebook(논제브 로어북, lorebook-keeper) 배포본 빌드 — v0.19.1
 *
 *   node scripts/build-keeper.mjs [--out <경로>]
 *
 * 기본 출력: ~/dev/lorebook-keeper-build
 *
 * 하는 일 세 가지뿐이다:
 *   1) 공용 파일을 **바이트 그대로 복사**한다 (src/core.js·src/hooks.js·style.css·공용 팝업·LICENSE·.gitignore)
 *   2) build/의 키퍼 전용본을 제자리에 배치한다 (index.js·src/flavor.js·manifest.json·README.md)
 *   3) panel.html·settings.html에서 `<!-- jev:start -->`~`<!-- jev:end -->` 블록을 제거한다
 *
 * 제브 전용으로 **제외**하는 것: src/jev.js · popup-injection.html · server-plugin/ · package.json · assets/
 *
 * 🔑 `src/core.js`는 제브 배포본과 **바이트 동일**해야 한다. 그게 "버그픽스 한 번 → 양쪽 반영"의
 *    성립 근거다. 말미 자기검증에서 sha256을 대조하고, 어긋나면 종료코드 1로 죽는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// ── 인자 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 && argv[outIdx + 1]
    ? path.resolve(argv[outIdx + 1])
    : path.join(os.homedir(), 'dev', 'lorebook-keeper-build');

// ── 파일 표 ─────────────────────────────────────────────────────────────
/** 양쪽이 공유하는 파일 — 바이트 그대로 복사한다 */
const SHARED = [
    'src/core.js',
    'src/hooks.js',
    'src/keeper.js',        // 소스 정본은 제브 레포에 있지만 실제로 물리는 건 이 배포본뿐이다
    'style.css',
    'popup-convert.html',
    'popup-world.html',
    'LICENSE',
    '.gitignore',
];
/** build/의 키퍼 전용본 → 배포본의 이 자리로 */
const FLAVORED = [
    ['build/index.keeper.js', 'index.js'],
    ['build/flavor.keeper.js', 'src/flavor.js'],
    ['build/manifest.keeper.json', 'manifest.json'],
    ['build/README.keeper.md', 'README.md'],
];
/** jev: 블록을 제거하고 복사할 파일 */
const STRIPPED = ['panel.html', 'settings.html'];
/** 제브 전용 — 배포본에 있으면 안 되는 것 */
const EXCLUDED = ['src/jev.js', 'popup-injection.html', 'server-plugin', 'package.json', 'assets'];

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rel = (p) => path.relative(OUT, p);

// ── 빌드 ────────────────────────────────────────────────────────────────
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'src'), { recursive: true });

for (const f of SHARED) {
    const from = path.join(SRC, f);
    if (!fs.existsSync(from)) throw new Error(`공용 파일 없음: ${f}`);
    fs.copyFileSync(from, path.join(OUT, f));
}
for (const [from, to] of FLAVORED) {
    const src = path.join(SRC, from);
    if (!fs.existsSync(src)) throw new Error(`키퍼 전용본 없음: ${from}`);
    fs.copyFileSync(src, path.join(OUT, to));
}

// jev: 블록 제거 — 블록 단위라 마크업이 반쪽만 남는 일이 없다.
// 짝이 안 맞으면(중첩·미닫힘) 조용히 넘기지 않고 죽인다: 반쪽 제거가 더 나쁘다.
const BLOCK_RE = /^[ \t]*<!-- jev:start -->[\s\S]*?<!-- jev:end -->[ \t]*\r?\n/gm;
const stripReport = [];
for (const f of STRIPPED) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    const starts = (text.match(/<!-- jev:start -->/g) ?? []).length;
    const ends = (text.match(/<!-- jev:end -->/g) ?? []).length;
    if (starts !== ends) throw new Error(`${f}: jev: 블록 짝이 안 맞는다 (start ${starts} / end ${ends})`);
    const out = text.replace(BLOCK_RE, '');
    const removed = starts - ((out.match(/<!-- jev:start -->/g) ?? []).length);
    if (removed !== starts) throw new Error(`${f}: 블록 ${starts}개 중 ${removed}개만 제거됐다 — 정규식이 형태를 못 잡았다`);
    fs.writeFileSync(path.join(OUT, f), out);
    stripReport.push({ f, blocks: starts, before: text.length, after: out.length });
}

// ── 자기검증 ────────────────────────────────────────────────────────────
const fails = [];
const ok = [];

// 1) 필수 파일 존재
const REQUIRED = ['manifest.json', 'index.js', 'style.css', 'panel.html', 'settings.html',
    'popup-convert.html', 'popup-world.html', 'README.md', 'LICENSE',
    'src/core.js', 'src/hooks.js', 'src/flavor.js', 'src/keeper.js'];
const missing = REQUIRED.filter(f => !fs.existsSync(path.join(OUT, f)));
missing.length ? fails.push(`필수 파일 누락: ${missing.join(', ')}`) : ok.push(`필수 파일 ${REQUIRED.length}개 전부 존재`);

// 2) 제브 전용 파일 미포함
const leaked = EXCLUDED.filter(f => fs.existsSync(path.join(OUT, f)));
leaked.length ? fails.push(`제브 전용이 배포본에 남았다: ${leaked.join(', ')}`) : ok.push(`제브 전용 ${EXCLUDED.length}개 전부 제외됨`);

// 3) manifest JSON 파싱 + 내용
let manifest = null;
try {
    manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
    ok.push(`manifest 파싱 OK — display_name="${manifest.display_name}" version=${manifest.version}`);
    if (manifest.generate_interceptor) fails.push('manifest에 generate_interceptor가 있다 — 논제브엔 인터셉터가 없다');
} catch (e) {
    fails.push(`manifest 파싱 실패: ${e.message}`);
}

// 4) 모든 파일 나열 (검사 대상)
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
});
const files = walk(OUT);
const textFiles = files.filter(p => /\.(js|mjs|json|html|css|md)$/.test(p));

// 5) jev: 마커 잔존 0건 (하드 실패)
const markerHits = textFiles.filter(p => /<!-- jev:(start|end) -->/.test(fs.readFileSync(p, 'utf8')));
markerHits.length ? fails.push(`jev: 마커 잔존: ${markerHits.map(rel).join(', ')}`) : ok.push('jev: 마커 잔존 0건');

// 6) 구 템플릿 경로 잔존 0건 (하드 실패 — 어긋나면 패널이 조용히 안 열린다)
const pathHits = textFiles.filter(p => fs.readFileSync(p, 'utf8').includes('third-party/lorebook-triage'));
pathHits.length ? fails.push(`구 템플릿 경로 잔존: ${pathHits.map(rel).join(', ')}`) : ok.push("'third-party/lorebook-triage' 잔존 0건");

// 7) 정체성 검사 — v0.19.1에서 **부정형에서 긍정형으로** 바꿨다 (하드 실패)
//    ⚠️ 이전 판은 "'Jev' 문자열 0건"을 요구했는데, 표시명이 'NonJev Lorebook'이 되면서 그 검사가
//    구조적으로 못 쓰게 됐다: 자기 이름에 Jev가 부분문자열로 들어 있고, README는 자매 확장을
//    'Jev Lorebook'이라는 실제 표시명으로 정당하게 소개한다. 부분문자열 금지로는 못 가른다.
//    → (a) 정체성 상수가 논제브 값으로 **있는지** 확인하고 (b) 제브가 '자기 이름 자리'에
//      쓰는 문자열만 골라 유출을 막는다.
const KEEPER_DISPLAY = 'NonJev Lorebook';
const flavorText = fs.readFileSync(path.join(OUT, 'src/flavor.js'), 'utf8');
const identity = [
    `DISPLAY_NAME = '${KEEPER_DISPLAY}'`,
    `LOG = '[${KEEPER_DISPLAY}]'`,
    "TEMPLATE_PATH = 'third-party/lorebook-keeper'",
    "MODULE = 'lorebookKeeper'",
];
const identityMiss = identity.filter(n => !flavorText.includes(n));
identityMiss.length
    ? fails.push(`src/flavor.js 정체성 상수 어긋남: ${identityMiss.join(' / ')}`)
    : ok.push('정체성 상수 4개 확인 (DISPLAY_NAME·LOG·TEMPLATE_PATH·MODULE)');

if (manifest) {
    manifest.display_name === KEEPER_DISPLAY
        ? ok.push(`manifest display_name = "${KEEPER_DISPLAY}"`)
        : fails.push(`manifest display_name이 "${manifest.display_name}" — "${KEEPER_DISPLAY}"여야 한다`);
}

// 제브가 자기 이름으로 쓰는 문자열(로그 프리픽스·설정 네임스페이스)이 남으면 화면·콘솔이 거짓말을 한다.
// src/core.js는 바이트 동일 제약이 있어 제외한다 — 거기 남은 건 주석과 미도달 문자열뿐이다
// (미도달 근거: 🧠·🎲 분류와 탈락 후보 표는 judgmentPanelActive()=hooks.lastReport 등록 여부로
//  가려지고, 논제브는 그 훅을 등록하지 않는다.)
// ⚠️ 단순 부분문자열로는 못 잡는다 — 첫 실행에서 오탐 2건이 나와 토큰을 좁혔다:
//    ① `[Jev Lorebook](url)` 은 자매 확장을 소개하는 **마크다운 링크**다 → 뒤에 `(`가 없을 때만 유출
//    ② `PEER_MODULE = 'jevLorebook'` 은 상대 네임스페이스라 정당하다 → 줄머리 `export const MODULE`만
const JEV_SELF = [
    ['제브 콘솔 프리픽스', /\[Jev Lorebook\](?!\()/],
    ['제브 설정 네임스페이스', /^export const MODULE = 'jevLorebook'/m],
];
const jevLeak = [];
for (const p of textFiles) {
    if (path.relative(OUT, p) === path.join('src', 'core.js')) continue;
    const t = fs.readFileSync(p, 'utf8');
    const hit = JEV_SELF.filter(([, re]) => re.test(t)).map(([label]) => label);
    if (hit.length) jevLeak.push(`${rel(p)}: ${hit.join(', ')}`);
}
jevLeak.length
    ? fails.push(`제브 정체성 문자열 유출: ${jevLeak.join(' / ')}`)
    : ok.push(`제브 정체성 문자열 ${JEV_SELF.length}종 유출 0건 (src/core.js 제외 — 아래 참고)`);

const coreJev = (fs.readFileSync(path.join(OUT, 'src/core.js'), 'utf8').match(/Jev/g) ?? []).length;

// 8) core.js / hooks.js 바이트 동일 (하드 실패)
for (const f of ['src/core.js', 'src/hooks.js']) {
    const a = sha(path.join(SRC, f)), b = sha(path.join(OUT, f));
    a === b ? ok.push(`${f} sha256 일치 ${a.slice(0, 16)}…`) : fails.push(`${f} sha256 불일치! ${a} != ${b}`);
}

// 9) node --check — 배포본엔 package.json이 없으므로 .js를 제자리에서 그대로 검사할 수 있다.
//    (제브 레포는 루트 package.json의 "type":"commonjs" 때문에 /tmp/*.mjs 복사가 필요하다.)
if (fs.existsSync(path.join(OUT, 'package.json'))) {
    fails.push('배포본에 package.json이 있다 — node --check가 ESM을 CJS로 읽어 깨진다');
} else {
    const js = files.filter(p => p.endsWith('.js'));
    for (const p of js) {
        try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); }
        catch (e) { fails.push(`node --check 실패 ${rel(p)}: ${String(e.stderr ?? e).split('\n')[0]}`); }
    }
    ok.push(`node --check ${js.length}개 파일 통과 (package.json 없음 → 제자리 검사 가능)`);
}

// 9b) 요술봉 항목 id 충돌 가드 (v0.19.1 회귀 방지, 하드 실패)
//    자매 확장을 둘 다 설치하면 공용 마크업 id가 같은 문서에 두 벌 생긴다. id 조회는 먼저 붙은
//    쪽 하나만 돌려주므로, 나중에 실행된 쪽의 라벨과 클릭 핸들러가 둘 다 상대 항목에 얹히고
//    자기 항목은 아이콘만 남아 무반응이 된다(v0.19.0 실측 버그). 막는 데 둘 다 필요하다:
//    ① 요술봉 id를 제브와 다르게 둔다 ② 그 항목을 전역 $('#id')로 다시 집지 않는다.
{
    const idxText = fs.readFileSync(path.join(OUT, 'index.js'), 'utf8');
    const globalWand = idxText.match(/\$\('#[\w-]*wand[\w-]*'\)/g) ?? [];
    globalWand.length
        ? fails.push(`index.js가 요술봉 항목을 전역 셀렉터로 집는다: ${globalWand.join(', ')}`)
        : ok.push('요술봉 전역 셀렉터 0건');
    const sharedWandId = idxText.includes('id="jev_lorebook_wand_');
    const ownWandId = idxText.includes('id="lorebook_keeper_wand_item"');
    if (sharedWandId) fails.push('요술봉 id가 제브와 같다(jev_lorebook_wand_*) — 같은 문서에 두 벌 생긴다');
    if (!ownWandId) fails.push('요술봉 id lorebook_keeper_wand_item이 없다');
    if (!sharedWandId && ownWandId) ok.push('요술봉 id 제브와 분리됨 (lorebook_keeper_wand_*)');
}

// 10) 키 유출 스캔
const keyHits = [];
for (const p of textFiles) {
    const m = fs.readFileSync(p, 'utf8').match(/AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{20,}/g);
    if (m) keyHits.push(`${rel(p)}: ${m.length}건`);
}
keyHits.length ? fails.push(`API 키 형태 문자열 발견(눈으로 확인 필요): ${keyHits.join(' / ')}`) : ok.push('API 키 형태 문자열 0건');

// ── 출력 ────────────────────────────────────────────────────────────────
console.log(`\n논제브 로어북 빌드 → ${OUT}`);
console.log(`소스: ${SRC}\n`);
for (const s of stripReport) {
    console.log(`  jev: 블록 제거  ${s.f.padEnd(15)} ${s.blocks}개  ${s.before} → ${s.after} bytes`);
}
console.log(`  파일 ${files.length}개 / 텍스트 ${textFiles.length}개\n`);
console.log('자기검증');
for (const s of ok) console.log(`  ✓ ${s}`);
console.log(`  · 참고: src/core.js 안의 'Jev' ${coreJev}건은 주석과 제브 경로 전용 문자열이다.`);
console.log("           core.js는 양쪽 배포본에서 바이트 동일해야 해서 지울 수 없고(그게 공유의 근거다),");
console.log('           논제브에서는 해당 훅이 미등록이라 화면에 닿지 않는다.');
for (const s of fails) console.log(`  ✗ ${s}`);
console.log(fails.length ? `\n실패 ${fails.length}건\n` : '\n전부 통과\n');
process.exit(fails.length ? 1 : 0);
