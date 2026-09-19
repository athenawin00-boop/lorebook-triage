/**
 * jev-proxy — Jev(TypeSafe System One) 순수 패스스루 ST 서버 플러그인.
 *
 * 존재 이유: api.typesafe.ai가 브라우저 오리진을 CORS로 거부한다(프리플라이트 400).
 * 브라우저 확장(jev-lorebook) → ST 서버(이 플러그인) → api.typesafe.ai 경유로 우회한다.
 *
 * 원칙:
 *  - 키를 서버에 저장하지 않는다. 확장이 보낸 X-Jev-Key 헤더를 업스트림 Authorization으로 옮겨 전달만 한다.
 *  - Authorization 헤더를 쓰지 않는 이유: ST basicAuthMode가 같은 헤더를 선점한다(Basic ...).
 *    Bearer로 덮으면 basicAuth 미들웨어가 401로 끊고, Basic을 그대로 두면 Jev가 403을 뱉는다. (2026-09-20 실측)
 *  - 목적지는 JEV_UPSTREAM 상수 하나로 고정. 오픈 프록시 아님.
 *  - 타임아웃 10초. 업스트림 에러는 상태코드 그대로 되돌린다.
 *
 * 마운트: POST /api/plugins/jev-proxy/systemone  (plugin-loader.js가 /api/plugins/<id>에 라우터 부착)
 * 활성화: config.yaml enableServerPlugins: true + ST 재시작 필요. 꺼져 있는 동안 이 폴더는 불활성.
 */
'use strict';

const JEV_UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS = 10000;

const info = {
    id: 'jev-proxy',
    name: 'Jev Proxy',
    description: 'Pure pass-through proxy to TypeSafe Jev (api.typesafe.ai/v1/systemone). Key travels per-request in the X-Jev-Key header; nothing is stored server-side.',
};

/**
 * @param {import('express').Router} router
 */
async function init(router) {
    router.post('/systemone', async (req, res) => {
        const key = req.headers['x-jev-key'];
        if (!key) {
            return res.status(401).json({ error: 'Missing X-Jev-Key header (<Jev API key>)' });
        }

        try {
            const upstream = await fetch(JEV_UPSTREAM, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(req.body ?? {}),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });

            const text = await upstream.text();
            res.status(upstream.status);
            const contentType = upstream.headers.get('content-type');
            if (contentType) {
                res.set('Content-Type', contentType);
            }
            return res.send(text);
        } catch (error) {
            const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
            console.error('[jev-proxy] upstream error:', error?.message ?? error);
            return res.status(isTimeout ? 504 : 502).json({
                error: isTimeout
                    ? `Jev upstream timeout (${TIMEOUT_MS / 1000}s)`
                    : `Jev upstream error: ${error?.message ?? error}`,
            });
        }
    });

    console.log('[jev-proxy] route registered: POST /api/plugins/jev-proxy/systemone →', JEV_UPSTREAM);
}

async function exit() {
    // 정리할 리소스 없음 (상태 없는 패스스루)
}

module.exports = { info, init, exit };
