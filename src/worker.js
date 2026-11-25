import { handleApiRequest } from './sheets.js';
import { STATIC_ASSETS } from './assets-bundle.js';

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    if (env?.ASSETS?.fetch) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      const asset = STATIC_ASSETS[url.pathname];
      if (asset) {
        return new Response(request.method === 'HEAD' ? null : asset.body, {
          status: 200,
          headers: {
            'Content-Type': asset.contentType,
            'Cache-Control': 'public, max-age=300'
          }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
