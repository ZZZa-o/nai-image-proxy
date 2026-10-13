import express from 'express';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { UPSTREAM, routeRequest, hopByHopHeaders, addCors, forwardHeaders } from './common.mjs';

export function createApp({ allowedOrigins = process.env.ALLOWED_ORIGINS || '*', requestUpstream = https.request } = {}) {
    const app = express();
    app.disable('x-powered-by');
    // No JSON/body parser, compression, access logger, or automatic POST retries.
    app.use((req, res) => {
        // A fixed base plus an allowlist prevents client-selected upstream hosts.
        const url = new URL(req.originalUrl, UPSTREAM);
        const { reply, cors } = routeRequest(url, req.method, new Headers(req.headers), allowedOrigins);
        if (reply) {
            res.writeHead(reply.status, reply.headers);
            res.end(reply.body);
            return;
        }

        const headers = Object.fromEntries(forwardHeaders(req.headers));

        let upstreamResponse;
        const upstream = requestUpstream(`${UPSTREAM}${url.pathname}${url.search}`, {
            method: req.method,
            headers,
        }, incoming => {
            upstreamResponse = incoming;
            const responseHeaders = { ...incoming.headers };
            for (const name of hopByHopHeaders(incoming.headers.connection)) delete responseHeaders[name];
            // Preserve duplicate headers such as Set-Cookie and the compressed Content-Length.
            for (const [name, value] of Object.entries(responseHeaders)) {
                if (value !== undefined) res.setHeader(name, value);
            }
            const corsHeaders = addCors(new Headers({ vary: res.getHeader('vary') || '' }), cors);
            for (const name of Object.keys(cors)) res.setHeader(name, corsHeaders.get(name));
            res.writeHead(incoming.statusCode, incoming.statusMessage);
            res.flushHeaders();
            // Backpressure keeps both large downloads and SSE incremental.
            pipeline(incoming, res, () => {});
        });

        upstream.on('error', () => {
            if (res.destroyed) return;
            if (res.headersSent) {
                res.destroy();
                return;
            }
            res.writeHead(502, {
                'content-type': 'text/plain; charset=utf-8',
                'cache-control': 'no-store',
                ...cors,
            });
            res.end('NovelAI upstream connection failed.\n');
        });
        req.on('error', () => upstream.destroy());
        req.on('aborted', () => upstream.destroy());
        res.on('close', () => {
            upstream.destroy();
            upstreamResponse?.destroy();
        });
        // pipe() is deliberate: pipeline(req, ...) would destroy the client socket
        // on connection failure before we could return the 502 response.
        req.pipe(upstream);
    });
    return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const port = Number(process.env.PORT || 3000);
    const server = createApp().listen(port, '0.0.0.0', () => {
        console.log(`NovelAI image proxy listening on port ${port}`);
    });
    // Let the hosting platform/upstream own deadlines; do not buffer or time out SSE here.
    server.requestTimeout = 0;
}
