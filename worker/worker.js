// The Worker: rooms at /room/<CODE> (one Durable Object each), Tempo fuel at /mpp/*, the game's files otherwise.
import { Room } from './room.js';
import { Pump } from './pump.js';

export { Room, Pump };

const ROOM_PATH = /^\/room\/([A-Z]{4,6})$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/room/')) {
      const m = ROOM_PATH.exec(url.pathname);
      if (!m) return new Response('room codes are 4-6 letters A-Z', { status: 400 });
      if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return new Response('WebSocket only', { status: 426 });
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(request);
    }
    if (url.pathname.startsWith('/mpp/')) return env.PUMP.get(env.PUMP.idFromName('pump')).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
