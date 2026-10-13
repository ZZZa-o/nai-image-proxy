import { UPSTREAM, routeRequest, hopByHopHeaders, addCors, forwardHeaders } from './common.mjs';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const { reply, cors } = routeRequest(url, request.method, request.headers, env.ALLOWED_ORIGINS);
        if (reply) return new Response(reply.body, reply);

        const headers = forwardHeaders(request.headers);

        try {
            const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
                method: request.method,
                headers,
                body: request.body,
                redirect: 'manual',
                signal: request.signal,
                cache: 'no-store',
            });
            const responseHeaders = new Headers(upstream.headers);
            for (const name of hopByHopHeaders(responseHeaders.get('connection') || '')) {
                if (name) responseHeaders.delete(name);
            }
            // Do not read the body: Cloudflare passes through its original encoding/stream.
            return new Response(upstream.body, {
                status: upstream.status,
                statusText: upstream.statusText,
                headers: addCors(responseHeaders, cors),
            });
        } catch {
            // Never include request URLs, headers, bodies or exception details in logs/errors.
            return new Response('NovelAI upstream connection failed.\n', {
                status: 502,
                headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...cors },
            });
        }
    },
};
