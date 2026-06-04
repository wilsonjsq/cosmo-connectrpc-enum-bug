// Minimal federation v2 subgraph mock. No deps. Returns one Document
// whose enum field `status` is "active" — the value the Cosmo router
// fails to round-trip through its ConnectRPC transcoder.
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDL = readFileSync(join(__dirname, "subgraph.graphql"), "utf8");

const PORT = Number(process.env.PORT ?? 4001);
const DOCUMENT = { id: "1", title: "Quarterly Report", status: "active" };

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "invalid JSON" }] }));
      return;
    }
    const { query } = parsed;
    let data;
    if (typeof query === "string" && /_service[\s\S]*sdl/.test(query)) {
      data = { _service: { sdl: SDL } };
    } else if (typeof query === "string" && /document\s*\(/.test(query)) {
      data = { document: DOCUMENT };
    } else {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "unknown query" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data }));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`subgraph listening on :${PORT}`);
});
