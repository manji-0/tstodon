// A stand-in for Cloudflare Access's edge in front of the e2e Worker. After a
// login, Access keeps the JWT in the browser's `CF_Authorization` cookie and
// sends it to the origin as `Cf-Access-Jwt-Assertion` on every request. This
// proxy does the same: it replaces whatever `Cf-Access-Jwt-Assertion` the
// browser sent with the cookie's value (none without the cookie) and forwards
// the request, WebSocket upgrades included, to the Worker. It checks nothing;
// the Worker verifies the JWT. The Host header is kept, so the Worker sees the
// public origin.
//
// A header set by Playwright (`extraHTTPHeaders`, `route`) misses requests the
// browser makes outside the page, such as an `<a download>` link; a cookie,
// like Access's own, goes with all of them.
import http from "node:http";
import net from "node:net";

const ACCESS_COOKIE = "CF_Authorization";
const ASSERTION_HEADER = "cf-access-jwt-assertion";

/** `CF_Authorization` from a Cookie header, or undefined. */
const accessCookie = (cookieHeader) => {
  for (const pair of (cookieHeader ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === ACCESS_COOKIE) {
      const value = pair.slice(separator + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
};

/** The request headers the Worker gets: the browser's, with Access's assertion. */
const originHeaders = (request) => {
  const headers = { ...request.headers };
  delete headers[ASSERTION_HEADER];
  const assertion = accessCookie(request.headers.cookie);
  if (assertion !== undefined) {
    headers[ASSERTION_HEADER] = assertion;
  }
  return headers;
};

/**
 * Listen on `listenPort` (`host`) and forward to the Worker on `originPort`.
 * Resolves once listening.
 */
export const startAccessEdge = ({ host, listenPort, originPort }) => {
  const server = http.createServer((request, response) => {
    const upstream = http.request(
      {
        host,
        port: originPort,
        method: request.method,
        path: request.url,
        headers: originHeaders(request),
      },
      (origin) => {
        response.writeHead(origin.statusCode ?? 502, origin.statusMessage, origin.rawHeaders);
        origin.pipe(response);
      },
    );
    upstream.on("error", () => {
      // The Worker is not up yet (Playwright polls /healthz), or it went away.
      if (!response.headersSent) {
        response.writeHead(502, { "Content-Type": "text/plain" });
      }
      response.end("The e2e Worker is not answering.\n");
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request, socket, head) => {
    const upstream = net.connect(originPort, host, () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (const [name, value] of Object.entries(originHeaders(request))) {
        for (const item of Array.isArray(value) ? value : [value]) {
          lines.push(`${name}: ${item}`);
        }
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", close);
    socket.on("error", close);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, host, () => resolve(server));
  });
};
