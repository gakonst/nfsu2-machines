// The Worker's fetch: the HTTP routes (http/routes.js) and the /lan WebSocket, whose checks are http/lan.js's and
// whose connection is the Switch Durable Object's (switch/do.js).  Port of web/server-rs/src/app/mod.rs's dispatch: a
// request that asks for an upgrade goes to lan.rs on_upgrade, any other to the router.

import { handle, isUpgrade } from './http/routes.js';
import { lanUpgrade } from './http/lan.js';

export default {
  /** an upgrade's checks (refused: Rust's raw answer for the code), then the Switch DO with the checks' {key, site, opts} in
   * x-lan-opts (docs/INTERNAL.md); anything else, the routes */
  async fetch(request, env, ctx) {
    if (isUpgrade(request)) {
      const r = await lanUpgrade(request, env);
      if (r instanceof Response) return r;
      const stub = env.SWITCH.get(env.SWITCH.idFromName('switch'));
      const headers = new Headers(request.headers);
      headers.set('x-lan-opts', JSON.stringify({ key: r.key, site: r.site, opts: r.opts }));
      return stub.fetch(new Request(request, { headers }));
    }
    return handle(request, env, { nowMs: Date.now(), ctx });
  },
};
