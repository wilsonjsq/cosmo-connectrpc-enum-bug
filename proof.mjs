// Wire-level proof. Hits three surfaces with the same logical request and
// prints what each one carries for the enum field `status` (expected:
// "active" / int 1 / proto value name "DOCUMENT_STATUS_active").
//
//   (a) /3002/graphql                GraphQL
//   (b) /5026 Connect JSON wire      what the router serializes onto JSON
//   (c) /5026 Connect binary wire    what the router emits as protobuf bytes
//
// No SDK / no codegen / no deps. Run on host once `docker compose up` is
// healthy.

import { request as httpRequest } from "node:http";

const ID = "1";

function postRaw(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `http://localhost:${port}${path}`,
      { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) } },
      (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode, buf: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Walk one len-delim proto message body looking for `targetField`. Returns
// human-readable status — "varint = N" / `LEN-DELIM "..."` / "ABSENT".
function findField(buf, start, end, targetField) {
  let i = start;
  while (i < end) {
    const tag = buf[i++];
    const fno = tag >> 3;
    const wt = tag & 7;
    if (wt === 0) {
      let v = 0, s = 0;
      while (true) { const b = buf[i++]; v |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; }
      if (fno === targetField) return `varint = ${v}`;
    } else if (wt === 2) {
      let ln = 0, s = 0;
      while (true) { const b = buf[i++]; ln |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; }
      if (fno === targetField) return `LEN-DELIM "${buf.slice(i, i + ln).toString("utf8")}"`;
      i += ln;
    } else if (wt === 5) i += 4;
    else if (wt === 1) i += 8;
    else break;
  }
  return `field ${targetField} ABSENT (proto3 default 0 = DOCUMENT_STATUS_UNSPECIFIED)`;
}

const gql = await postRaw(3002, "/graphql", { "content-type": "application/json" },
  JSON.stringify({ query: `query($id:ID!){document(id:$id){id title status}}`, variables: { id: ID } }));
const cj  = await postRaw(5026, "/repro.v1.DocumentService/GetDocument",
  { "content-type": "application/json", "connect-protocol-version": "1" },
  JSON.stringify({ id: ID }));

// Connect-binary request: GetDocumentRequest { string id = 1 } = tag 0x0a, varint len, bytes.
const idBytes = Buffer.from(ID, "utf8");
const reqBuf = Buffer.concat([Buffer.from([0x0a, idBytes.length]), idBytes]);
const cb = await postRaw(5026, "/repro.v1.DocumentService/GetDocument",
  { "content-type": "application/proto", "connect-protocol-version": "1" }, reqBuf);

// Outer GetDocumentResponse: field 1 (document) is len-delim. Walk INTO the
// Document message and look for field 3 (status).
let statusBytes = "could not parse outer envelope";
if (cb.buf[0] === 0x0a) {
  let i = 1, outerLen = 0, shift = 0;
  while (true) { const b = cb.buf[i++]; outerLen |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  statusBytes = findField(cb.buf, i, i + outerLen, 3);
}

console.log("=== wire-level reproduction =====================================");
console.log(`Proto enum: DOCUMENT_STATUS_UNSPECIFIED=0  DOCUMENT_STATUS_active=1  DOCUMENT_STATUS_archived=2\n`);
console.log(`(a) /3002/graphql body:        ${gql.buf.toString("utf8")}`);
console.log(`(b) /5026 Connect-JSON body:   ${cj.buf.toString("utf8")}`);
console.log(`(c) /5026 Connect-binary (${cb.buf.length} bytes) field 3 of Document:`);
console.log(`    ${statusBytes}\n`);

const gqlVal = JSON.parse(gql.buf.toString("utf8")).data.document.status;
const cjVal  = JSON.parse(cj.buf.toString("utf8")).document.status;
const bug = gqlVal === "active" && cjVal !== "DOCUMENT_STATUS_active" && /ABSENT/.test(statusBytes);
console.log(`GraphQL:                       "${gqlVal}"   (expected: "active")`);
console.log(`Connect-JSON enum:             "${cjVal}"   (proto3-JSON expects "DOCUMENT_STATUS_active")`);
console.log(`Connect-binary enum tag:       ${statusBytes}`);
console.log(`\ndefect reproduced:             ${bug ? "YES" : "NO"}`);
