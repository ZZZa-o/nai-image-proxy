export const UPSTREAM = 'https://image.novelai.net';

export const ENDPOINTS = new Map([
    ['/ai/generate-image', 'POST'],
    ['/ai/generate-image-stream', 'POST'],
    ['/ai/upscale', 'POST'],
    ['/ai/augment-image', 'POST'],
    ['/ai/generate-image/suggest-tags', 'GET'],
]);

// These describe one transport connection and cannot be forwarded end to end.
export function hopByHopHeaders(connection = '') {
    return new Set([
        'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
        'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
        ...connection.toLowerCase().split(',').map(value => value.trim()),
    ]);
}

// Per-request client metadata: proxy hops, real client address, and the
// Cloudflare edge fields that carry the caller's IP and country.
export const CLIENT_METADATA_HEADERS = [
    'host', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
    'x-forwarded-port', 'x-real-ip', 'true-client-ip',
];

export function forwardHeaders(source) {
    const headers = new Headers(source);
    for (const name of hopByHopHeaders(headers.get('connection') || '')) headers.delete(name);
    for (const name of CLIENT_METADATA_HEADERS) headers.delete(name);
    for (const name of [...headers.keys()]) if (name.startsWith('cf-')) headers.delete(name);
    return headers;
}

export function routeRequest(url, method, headers, allowedOrigins = '*') {
    const origin = headers.get('origin');
    const allowed = allowedOrigins.split(',').map(value => value.trim());
    const wildcard = allowed.includes('*');
    const cors = {};
    const vary = names => { cors.vary = cors.vary ? `${cors.vary}, ${names}` : names; };
    const reply = (status, body, extra = {}) => ({
        cors,
        reply: {
            status, body,
            headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...cors, ...extra },
        },
    });

    if (!wildcard) vary('Origin');
    if (origin) {
        if (!wildcard && !allowed.includes(origin)) {
            return reply(403, 'Browser origin is not allowed.\n');
        }
        cors['access-control-allow-origin'] = wildcard ? '*' : origin;
        cors['access-control-expose-headers'] = '*';
    }

    if (url.pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) {
        return reply(200, method === 'HEAD' ? null : 'ok\n');
    }
    const expected = ENDPOINTS.get(url.pathname);
    if (!expected) return reply(404, 'Unknown image API endpoint.\n');
    if (method === 'OPTIONS') {
        // Allow-Headers echoes the request, so the preflight also varies on it.
        vary('Access-Control-Request-Method, Access-Control-Request-Headers');
        return reply(204, null, {
            'access-control-allow-methods': `${expected}, OPTIONS`,
            'access-control-allow-headers': headers.get('access-control-request-headers') || 'Authorization, Content-Type, Accept',
            'access-control-max-age': '86400',
        });
    }
    if (method !== expected) {
        return reply(405, 'Method not allowed.\n', { allow: `${expected}, OPTIONS` });
    }
    return { cors };
}

export function addCors(headers, cors) {
    for (const [name, value] of Object.entries(cors)) {
        if (name === 'vary' && headers.get(name)) headers.append(name, value);
        else headers.set(name, value);
    }
    return headers;
}
