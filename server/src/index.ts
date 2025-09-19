import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import pino from "pino";
import { z } from "zod";
import { InMemoryBroker } from "./broker.js";
import type { ClientMessage } from "./types.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { path: "/ws", cors: { origin: "*" } });
const logger = pino({ transport: { target: "pino-pretty" } });

app.use(cors());
app.use(express.json());

// Broker and options
const broker = new InMemoryBroker(io, {
    ringBufferSize: 100,
    subscriberQueueSize: 512,
    heartbeatIntervalMs: 30000,
});
broker.start();

// REST endpoints
const topicNameSchema = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9._-]+$/);

app.post("/topics", (req, res) => {
    const name = topicNameSchema.safeParse(req.body?.name);
    if (!name.success)
        return res
            .status(400)
            .json({ error: "BAD_REQUEST", message: "invalid topic name" });
    const result = broker.createTopic(name.data);
    if (!result.ok)
        return res.status(409).json({ status: "conflict", topic: name.data });
    res.status(201).json({ status: "created", topic: name.data });
});

app.delete("/topics/:name", (req, res) => {
    const name = topicNameSchema.safeParse(req.params.name);
    if (!name.success)
        return res
            .status(400)
            .json({ error: "BAD_REQUEST", message: "invalid topic name" });
    const result = broker.deleteTopic(name.data);
    if (!result.ok)
        return res.status(404).json({ status: "not_found", topic: name.data });
    res.json({ status: "deleted", topic: name.data });
});

app.get("/topics", (_req, res) => {
    res.json({ topics: broker.getTopics() });
});

app.get("/health", (_req, res) => {
    res.json(broker.getHealth());
});

app.get("/stats", (_req, res) => {
    res.json(broker.getStats());
});

io.on("connection", (socket) => {
    logger.info({ id: socket.id }, "socket connected");

    socket.on("message", (msg: ClientMessage) => {
        const now = new Date().toISOString();
        try {
            switch (msg.type) {
                case "subscribe": {
                    broker.subscribe(
                        socket,
                        msg.topic,
                        msg.client_id,
                        msg.last_n,
                        msg.request_id
                    );
                    break;
                }
                case "unsubscribe": {
                    broker.unsubscribe(
                        socket,
                        msg.topic,
                        msg.client_id,
                        msg.request_id
                    );
                    break;
                }
                case "publish": {
                    const result = broker.publish(
                        msg.topic,
                        msg.message,
                        msg.request_id
                    );
                    if (!result.ok) {
                        socket.emit("message", {
                            type: "error",
                            request_id: msg.request_id,
                            error: {
                                code: "TOPIC_NOT_FOUND",
                                message: `topic ${msg.topic} not found`,
                            },
                            ts: now,
                        });
                    } else {
                        socket.emit("message", {
                            type: "ack",
                            request_id: msg.request_id,
                            topic: msg.topic,
                            status: "ok",
                            ts: result.ts,
                        });
                    }
                    break;
                }
                case "ping": {
                    socket.emit("message", {
                        type: "pong",
                        request_id: msg.request_id,
                        ts: now,
                    });
                    break;
                }
                default: {
                    socket.emit("message", {
                        type: "error",
                        request_id: (msg as any).request_id,
                        error: { code: "BAD_REQUEST", message: "unknown type" },
                        ts: now,
                    });
                }
            }
        } catch (err) {
            socket.emit("message", {
                type: "error",
                request_id: (msg as any).request_id,
                error: { code: "INTERNAL", message: "internal error" },
                ts: now,
            });
        }
    });

    socket.on("disconnect", (reason) => {
        broker.handleSocketDisconnect(socket);
        logger.info({ id: socket.id, reason }, "socket disconnected");
    });
});

server.listen(PORT, () => {
    logger.info(`server listening on :${PORT}`);
});
