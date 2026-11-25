import { handleApiRequest } from './sheets.js';

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
