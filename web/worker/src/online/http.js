// The online host's web pages, port 80 of 10.77.0.1 (crates/online/src/http.rs): NEWSURL and TOSURL, as EA's
// "web offer" pages.  One GET per connection, at most 4 KB of request, answered and closed.

import { latin1Decode, latin1Bytes } from './jsx.js';

const NEWS = {
  title: 'NFSU2 Online',
  text: 'Welcome to Online play on this server: open the Lobby, create a game or join one, ready up and race.\r\n' +
    '\r\n' +
    'Changes from the original game:\r\n' +
    "- Online works again, on this server instead of EA's. You play under your own name, with no EA account.\r\n" +
    '- Up to 6 players in every race type (the original had 4, and 6 only in Street X). Drag keeps one car per lane.\r\n' +
    '- Every track is open, whatever your career has unlocked, and a new game starts at 2 laps.\r\n' +
    "- The Lobby lists every open game, the Filter's first, until you set the Filter: then only its games (its defaults list all).\r\n" +
    '- Free roam with other players: their cars drive in your city, with their names over them.\r\n' +
    '- A horn: N, in races and in free roam, eight to pick from in Settings. The others hear it from your car.\r\n' +
    '- Widescreen, and up to 120 fps on a 120 Hz screen.',
};

const TOS = {
  title: 'Terms of Service',
  text: 'This server is a stand-in for the online service of the original game, run by whoever runs this server. ' +
    'Play fair and be kind in the chat.',
};

/** a web-offer page: the script header, then the text */
export function offerPage(p) {
  const q = p.title.replace(/["%{}\r\n]/g, ' ');
  return '%{ CMD=news TITLE="' + q + '" BTN1="OK" BTN1-GOTO="$quit" %}\r\n' + p.text + '\r\n';
}

/** /^(GET|HEAD) (\/[^ ?#]*)[^ ]* HTTP\/1\.[01]$/ on the request line: [method, path] or null */
export function requestLine(line) {
  const sp = line.indexOf(' ');
  if (sp < 0) return null;
  const method = line.slice(0, sp), rest = line.slice(sp + 1);
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (!(rest.endsWith(' HTTP/1.0') || rest.endsWith(' HTTP/1.1'))) return null;
  const target = rest.slice(0, -9);
  if (!target.startsWith('/') || target.includes(' ')) return null;
  let end = target.length;
  for (let i = 0; i < target.length; i++) {
    if (target[i] === '?' || target[i] === '#') {
      end = i;
      break;
    }
  }
  return [method, target.slice(0, end)];
}

function find(buf, pat) {
  for (let i = 0; i + pat.length <= buf.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (buf[i + j] !== pat[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

export const httpMethods = {
  httpConnect(c) {
    const t = this.setTimeout(15000, { k: 'HttpIdle', c });
    this.vh.https.set(c, { buf: new Uint8Array(0), done: false, timer: t });
    this.setSvc(c, { k: 'http', id: 0 });
  },

  httpIdle(c) {
    if (this.vh.https.has(c)) this.connDestroy(c, 'http: no request');
  },

  httpData(c, chunk) {
    const hc = this.vh.https.get(c);
    if (!hc || hc.done) return;
    const nb = new Uint8Array(hc.buf.length + chunk.length);
    nb.set(hc.buf, 0);
    nb.set(chunk, hc.buf.length);
    hc.buf = nb;
    if (hc.buf.length > 4096) {
      hc.done = true;
      return this.connDestroy(c, 'http: request too large');
    }
    if (find(hc.buf, [13, 10, 13, 10]) < 0) return;
    hc.done = true;
    if (hc.timer !== null) {
      this.timers.clear(hc.timer);
      hc.timer = null;
    }
    let first = find(hc.buf, [13, 10]);
    if (first < 0) first = 0;
    const m = requestLine(latin1Decode(hc.buf, 0, first));
    let page = null;
    if (m) {
      const p = m[1].toLowerCase();
      page = p === '/news' ? NEWS : p === '/tos' ? TOS : null;
    }
    const body = latin1Bytes(page ? offerPage(page) : 'Not found\r\n');
    const status = page ? '200 OK' : m ? '404 Not Found' : '400 Bad Request';
    const head = latin1Bytes('HTTP/1.0 ' + status + '\r\nContent-Type: text/plain\r\nContent-Length: ' + body.length + '\r\nConnection: close\r\n\r\n');
    const withBody = !m || m[0] !== 'HEAD';
    const out = new Uint8Array(head.length + (withBody ? body.length : 0));
    out.set(head, 0);
    if (withBody) out.set(body, head.length);
    this.connWrite(c, out);
    this.connEnd(c);
  },
};

