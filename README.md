# In-memory Pub/Sub (Node.js + React, TypeScript)

## Quick Docker Run

Backend only (no UI in the container):

```bash
# build image
cd server
docker build -t pub-sub-server:dev .

# run container on port 4000
docker run --rm -p 4000:4000 pub-sub-server:dev
# in another terminal, verify health
curl http://localhost:4000/health
```

Run E2E tests against the Dockerized backend:

```bash
# with the container running on :4000 in another terminal
cd server
npm install
API_URL=http://localhost:4000 WS_URL=http://localhost:4000 npm run test:e2e
```

One-shot (start container, wait, run tests, stop):

```bash
cd server
docker run -d --rm --name pub-sub-srv -p 4000:4000 pub-sub-server:dev
until curl -sSf http://localhost:4000/health >/dev/null; do sleep 0.2; done
npm run test:e2e
docker stop pub-sub-srv
```

This project implements a simplified in-memory publish/subscribe system with:

-   WebSocket endpoint (`/ws`) for realtime publish/subscribe/unsubscribe/ping
-   HTTP REST APIs for topic management and observability
-   No external broker/DB; all state is in-memory

Backend: Node.js (TypeScript), Express + socket.io
Frontend: React (TypeScript), Vite + socket.io-client

## Features

-   Topic lifecycle over REST: create/delete/list
-   WebSocket protocol:
    -   Client → Server: `subscribe`, `unsubscribe`, `publish`, `ping`
    -   Server → Client: `ack`, `event`, `error`, `pong`, `info`
-   Multiple publishers/subscribers per topic
-   Fan-out: each subscriber to a topic receives each message once
-   Isolation: no cross-topic leakage
-   Replay: per-topic ring buffer (last 100 messages) with `last_n` on subscribe
-   Backpressure: bounded per-subscriber queue (default 512). Policy: drop oldest
-   Heartbeat: periodic `info` ping
-   Graceful shutdown: stop new ops, best-effort flush, close sockets

## Repo layout

-   `server/` – Backend service (Express, socket.io)
-   `client/` – React UI to manage topics and interact with the broker

## Quick start

1. Backend (dev)

```bash
cd server
npm install
npm run dev
# server on http://localhost:4000
```

2. Frontend (dev)

```bash
cd client
npm install
npm run dev
# open printed URL (e.g., http://localhost:5173)
```

The frontend uses environment variables:

-   `client/.env`:

```
VITE_API_URL=http://localhost:4000
VITE_WS_URL=http://localhost:4000
```

## Detailed specs (summary)

-   HTTP REST endpoints

    -   POST `/topics`: create topic. 201 on create; 409 if exists; 400 invalid name
    -   DELETE `/topics/{name}`: delete topic. 200 on delete; 404 if not found; notifies subscribers with `info.topic_deleted`
    -   GET `/topics`: list topics with subscriber counts
    -   GET `/health`: `{ uptime_sec, topics, subscribers }`
    -   GET `/stats`: per-topic `{ messages, subscribers, delivered, dropped }`

-   WebSocket protocol (path `/ws`)

    -   Client → Server
        -   `subscribe`: `{ type, topic, client_id, last_n?, request_id? }`
        -   `unsubscribe`: `{ type, topic, client_id, request_id? }`
        -   `publish`: `{ type, topic, message: { id, payload }, request_id? }`
        -   `ping`: `{ type, request_id? }`
    -   Server → Client
        -   `ack`: `{ type, request_id?, topic?, status: "ok", ts }`
        -   `event`: `{ type, topic, message: { id, payload }, ts }`
        -   `error`: `{ type, request_id?, error: { code, message }, ts }`
        -   `pong`: `{ type, request_id?, ts }`
        -   `info`: heartbeat `{ msg: "ping" }` or `{ topic, msg: "topic_deleted" }`
    -   Error codes: `BAD_REQUEST`, `TOPIC_NOT_FOUND`, `SLOW_CONSUMER`, `UNAUTHORIZED` (reserved), `INTERNAL`

-   Semantics

    -   Topics must exist (created via REST) before subscribe/publish; otherwise `TOPIC_NOT_FOUND`
    -   Delivery: at-most-once; per-topic FIFO best-effort; isolation across topics
    -   Replay: per-topic ring buffer (100). On `subscribe` with `last_n`, server replays up to `last_n` then live
    -   Unsubscribe: idempotent (acks even if not subscribed)
    -   Publisher echo: only if the publisher is also subscribed to the topic

-   Backpressure policy

    -   Per-subscriber bounded outbound queue (default 512). On overflow, drop oldest queued messages (increments `dropped` in `/stats`)

-   Config flags

    -   Backend (`server/src/index.ts`): `PORT` env (default 4000); broker `{ ringBufferSize: 100, subscriberQueueSize: 512, heartbeatIntervalMs: 30000 }`; WS path `/ws`
    -   Frontend (`client/.env`): `VITE_API_URL`, `VITE_WS_URL`
    -   Topic name validation: `^[a-zA-Z0-9._-]+$`

-   Observability & ops
    -   `/health`, `/stats`; heartbeat `info` every 30s
    -   Graceful shutdown: stop new ops, best-effort flush, close sockets; topic deletion notifies subscribers then disconnects

## REST API

-   POST `/topics`
    -   Request: `{ "name": "orders" }`
    -   201 Created: `{ "status": "created", "topic": "orders" }`
    -   409 Conflict if exists
-   DELETE `/topics/{name}`
    -   200 OK: `{ "status": "deleted", "topic": "orders" }`
    -   404 if not found; all subscribers are notified and disconnected
-   GET `/topics`

```json
{
    "topics": [{ "name": "orders", "subscribers": 3 }]
}
```

-   GET `/health`

```json
{
    "uptime_sec": 123,
    "topics": 2,
    "subscribers": 4
}
```

-   GET `/stats`

```json
{
    "topics": {
        "orders": {
            "messages": 42,
            "subscribers": 3,
            "delivered": 42,
            "dropped": 0
        }
    }
}
```

## WebSocket protocol (path: `/ws`)

Client → Server

```json
{
  "type": "subscribe" | "unsubscribe" | "publish" | "ping",
  "topic": "orders",
  "message": { "id": "uuid", "payload": {"...": "..."} },
  "client_id": "s1",
  "last_n": 0,
  "request_id": "uuid-optional"
}
```

Server → Client

```json
{
  "type": "ack" | "event" | "error" | "pong" | "info",
  "request_id": "uuid-optional",
  "topic": "orders",
  "message": { "id": "uuid", "payload": {"...": "..."} },
  "error": { "code": "BAD_REQUEST", "message": "..." },
  "ts": "2025-08-25T10:00:00Z"
}
```

Error codes: `BAD_REQUEST`, `TOPIC_NOT_FOUND`, `SLOW_CONSUMER`, `UNAUTHORIZED` (reserved), `INTERNAL`.

Semantics:

-   `subscribe` requires `topic`, `client_id`; optional `last_n`, `request_id`
-   `unsubscribe` requires `topic`, `client_id`
-   `publish` requires `topic`, `message.id`, `message.payload`
-   `ping` optional `request_id`
-   `ack` on success; `error` on failure
-   `event` for deliveries; publisher receives events only if also subscribed
-   `info` heartbeat (`{"msg":"ping"}`) and topic deletion notification

## Backpressure & replay

-   Per-subscriber outbound queue: default size 512
-   On overflow: drop oldest pending items (increments `dropped` in stats)
-   Replay: per-topic ring buffer retains last 100 messages; `subscribe` with `last_n` replays up to that many

## Config flags

-   Backend (`server/src/index.ts`):
    -   `PORT` (env) – default 4000
    -   Broker options:
        -   `ringBufferSize: 100`
        -   `subscriberQueueSize: 512`
        -   `heartbeatIntervalMs: 30000`
    -   WebSocket path: `/ws`
-   Frontend (`client/.env`): `VITE_API_URL`, `VITE_WS_URL`

## How to use the UI

1. Create a topic by name
2. Set `last_n` if you want historical replay
3. Click Subscribe
4. Enter JSON payload and click Publish
5. See `ack`/`event`/`error`/`info` logs in the Events panel

Replay after reload:

-   Server keeps in-memory history while it runs. After reloading the page, set `last_n` and click Subscribe again to receive replay.

## E2E tests

We provide an end-to-end test covering REST and WS flows.

Run with a live server:

```bash
# terminal 1
cd server
npm run dev

# terminal 2
cd server
npm run test:e2e
```

Or single command to auto-start/stop the server:

```bash
cd server
(npm run dev --silent & echo $! > .server.pid); \
for i in $(seq 1 50); do curl -sSf http://localhost:4000/health >/dev/null && break || sleep 0.2; done; \
npm run test:e2e; \
pkill -f "tsx src/index.ts" || true
```

## Docker

Build & run:

```bash
cd server
docker build -t pub-sub-server:dev .
docker run --rm -p 4000:4000 pub-sub-server:dev
# open http://localhost:4000/health
```

Dockerfile is multi-stage:

-   Builder installs dev deps and compiles TypeScript to `dist/`
-   Runner installs prod deps and runs `node dist/index.js`

## Design choices & assumptions

-   In-memory only: no persistence across restarts; no clustering
-   Topics are created/deleted via REST; operations on missing topics error with `TOPIC_NOT_FOUND`
-   Delivery is at-most-once; per-topic FIFO best-effort
-   Publisher receives `event` only if also subscribed to the topic
-   Backpressure policy: drop oldest pending messages in subscriber queue; increments `dropped` counter
-   Replay buffer size: 100; `last_n` capped by available history
-   Heartbeat: server emits periodic `info` with `msg: "ping"`

## Troubleshooting

-   If the UI logs are empty, ensure the backend is running on 4000 and client `.env` points to it; restart `npm run dev` in `client/`
-   To test backpressure, temporarily set `subscriberQueueSize` low (e.g., 5) in `server/src/index.ts` and publish many messages; check `/stats` for `dropped` count
-   TypeScript: if editor flags `process` in tests, ensure `server/tsconfig.json` has `"types": ["node"]` (already set)

## What’s implemented

-   Node.js TypeScript backend with Express + socket.io
-   In-memory topic broker with replay ring buffer and bounded per-subscriber queues (drop oldest)
-   REST endpoints for topic management and observability
-   WebSocket message protocol (subscribe/unsubscribe/publish/ping) with server `ack/event/error/pong/info`
-   React TypeScript client for managing topics and publishing/subscribing
-   E2E test script validating the full flow
-   Dockerfile (multi-stage) to build and run the service
