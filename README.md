# Minimal reproduction — Cosmo Router drops GraphQL enum values on the ConnectRPC wire

Self-contained, no JSQ-specific schema or infrastructure. Mocks one
GraphQL subgraph in ~50 lines of Node, points the **stock** Cosmo Router
image at it, and probes three surfaces to show that:

- The GraphQL endpoint at `:3002/graphql` correctly returns the enum string `"active"`.
- The Connect-JSON wire at `:5026` emits the **bare GraphQL name** (`"active"`),
  not the proto enum value name (`"DOCUMENT_STATUS_active"`). Per the proto3-JSON
  spec, conformant parsers look up the JSON string against the enum value
  names declared in the descriptor; on a miss they fall back to the index-0
  entry (`DOCUMENT_STATUS_UNSPECIFIED`).
- The Connect-binary wire at `:5026` **omits the enum field entirely** from
  the response message. Proto3-binary parsers see no tag for the field and
  leave the typed value at its declared default (`DOCUMENT_STATUS_UNSPECIFIED`).

Both observed against `ghcr.io/wundergraph/cosmo/router:latest` (router
version `0.321.0` at time of capture, image digest pinnable via
`docker images --digests`). No custom router build, no Go modules, no
controlplane, no Cosmo Cloud — just the published image with a static
execution config and a filesystem services storage provider.

## What's in this directory

```
subgraph.graphql                    # federation v2 SDL, one enum, one query
subgraph-server.mjs                 # mock subgraph, ~50 LOC, no deps
services/document/service.proto     # hand-written proto with the proto-prefixed enum
services/document/GetDocument.graphql  # the operation the router transcodes RPC -> GraphQL
supergraph-config.yaml              # input for `wgc router compose`
router.yaml                         # stock router config, connect_rpc enabled
docker-compose.yml                  # subgraph + stock router on a private bridge
proof.mjs                           # three wire probes + verdict, ~100 LOC, no deps
```

## Prerequisites

- Docker (tested with Engine 28.x).
- Node 22.x on the host (only for `proof.mjs` and `wgc`; the in-container
  subgraph also runs Node 22).
- `wgc` v0.121.x — `npm i -g wgc` if missing. Only used once, for
  `wgc router compose`. The repro itself is wgc-free.

## Run it

```bash
# 1. Compose the supergraph locally (writes execution-config.json).
wgc router compose -i supergraph-config.yaml -o execution-config.json

# 2. Bring the two-container stack up.
docker compose up -d
docker compose logs router --tail=20   # expect "Router started"

# 3. Run the wire-level probe.
node proof.mjs

# 4. Tear down.
docker compose down
```

## Expected output

```
=== wire-level reproduction =====================================
Proto enum: DOCUMENT_STATUS_UNSPECIFIED=0  DOCUMENT_STATUS_active=1  DOCUMENT_STATUS_archived=2

(a) /3002/graphql body:        {"data":{"document":{"id":"1","title":"Quarterly Report","status":"active"}}}
(b) /5026 Connect-JSON body:   {"document":{"id":"1","title":"Quarterly Report","status":"active"}}
(c) /5026 Connect-binary (23 bytes) field 3 of Document:
    field 3 ABSENT (proto3 default 0 = DOCUMENT_STATUS_UNSPECIFIED)

GraphQL:                       "active"   (expected: "active")
Connect-JSON enum:             "active"   (proto3-JSON expects "DOCUMENT_STATUS_active")
Connect-binary enum tag:       field 3 ABSENT (proto3 default 0 = DOCUMENT_STATUS_UNSPECIFIED)

defect reproduced:             YES
```

## Why both wires are broken

Two distinct encoder bugs converge on the same SDK-visible symptom
(`document.status === DOCUMENT_STATUS_UNSPECIFIED`):

1. **JSON wire** — the router serializes the bare GraphQL enum name and
   does not apply the inverse of the `SCREAMING_SNAKE_CASE(EnumName)_`
   prefix that `@wundergraph/protographic` / `wgc grpc-service generate`
   produces (per [Google's protobuf style guide](https://protobuf.dev/programming-guides/style/)).
2. **Binary wire** — the encoder omits the enum field's tag entirely
   rather than writing the integer. Working hypothesis: the binary
   encoder shares the GraphQL→proto enum mapping path with the JSON
   encoder and, on a lookup miss, elects to skip rather than error.

A fix that only restores the proto value-name prefix on the JSON path
(e.g. post-processing generated proto files to strip the enum-name
prefix from declared value names) does NOT recover the binary path —
the field stays absent — so any consumer using `application/proto` /
`application/grpc` / `application/grpc-web` still observes data loss.

The narrow root-cause surface is in `router/pkg/connectrpc/` —
`handler.go` (JSON) plus `vanguard_service.go` (binary, via the shared
GraphQL→proto translation).

## Notes on the repro

- The `services/document/service.proto` here is hand-written to match what
  `wgc grpc-service generate` would emit for the equivalent operation,
  which lets us avoid running the codegen pipeline as part of the
  reproduction. The enum block (`DOCUMENT_STATUS_UNSPECIFIED = 0; DOCUMENT_STATUS_active = 1; DOCUMENT_STATUS_archived = 2;`)
  follows the proto style guide and matches `@wundergraph/protographic`'s
  output 1:1.
- The router serves both `:3002` (GraphQL) and `:5026` (ConnectRPC). The
  `:5026` handler transcodes incoming RPCs into GraphQL POSTs against its
  own `:3002` listener (via `graphql_endpoint:
  http://localhost:3002/graphql` inside the container), so the GraphQL
  path is the GraphQL control for the ConnectRPC path under test.
- `GRAPH_API_TOKEN` is intentionally unset on the router service. The
  router logs one startup warning ("No graph token provided. ...") and
  proceeds in offline mode — `execution_config.file` short-circuits the
  CDN dependency, so no token is required for the reproduction.
- The proof script is dependency-free Node — it uses `node:http` for the
  three POSTs and walks the proto-binary response manually to detect
  the absence of field 3 in the `Document` message.
