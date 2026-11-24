import html from './public/index.html';
import css from './public/style.css';
import app from './public/app.bundle.txt';
import licenses from './public/THIRD-PARTY-LICENSES.txt';
import { handleApi, responseHeaders } from './api.mjs';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path.startsWith('/smart-cube/api/')) return await handleApi(request, env);
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: responseHeaders });
      let body;
      let contentType;
      if (['/smart-cube', '/smart-cube/'].includes(path) || /^\/smart-cube\/report\/[a-f0-9]{32}$/.test(path)) {
        body = html;
        contentType = 'text/html; charset=utf-8';
      } else if (path === '/smart-cube/app.js') {
        body = app;
        contentType = 'text/javascript; charset=utf-8';
      } else if (path === '/smart-cube/style.css') {
        body = css;
        contentType = 'text/css; charset=utf-8';
      } else if (path === '/smart-cube/licenses.txt') {
        body = licenses;
        contentType = 'text/plain; charset=utf-8';
      } else return new Response('Not found', { status: 404, headers: responseHeaders });
      return new Response(request.method === 'HEAD' ? null : body, { headers: { ...responseHeaders, 'Content-Type': contentType } });
    } catch {
      return Response.json({ error: 'Cloud storage could not complete the request. Your browser report is still available to download.' }, { status: 503, headers: responseHeaders });
    }
  },
};
