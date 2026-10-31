// Ephemeral fixture-server helper for the exploration fixture sites (Phase-1
// engine test fixtures). Each site is a plain { name, entry, handle } object;
// startFixtureServer binds it to an OS-picked port on 127.0.0.1 and the runner
// closes it after its exploration job. Nothing is written to disk — every page
// is an inline HTML string.
import http from "node:http";
import zlib from "node:zlib";

// ---- minimal PNG encoder (solid-color truecolor image, zero deps) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// valid PNG (8-bit truecolor, no alpha) filled with one RGB color
export function solidPng(r, g, b, w = 8, h = 6) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  const row = Buffer.alloc(1 + w * 3); // filter byte 0 + RGB pixels
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// bind a fixture site to an ephemeral localhost port
export async function startFixtureServer(site) {
  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => site.handle(req, res))
      .catch(() => {
        try {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("fixture handler error");
        } catch {}
      });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    base: "http://127.0.0.1:" + port,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function sendHtml(res, html, status = 200) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

export function sendJson(res, obj, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

export function reqUrl(req) {
  return new URL(req.url, "http://127.0.0.1");
}
