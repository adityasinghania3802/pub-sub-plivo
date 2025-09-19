import { Server as SocketIOServer, Socket } from "socket.io";
import type {
    AckMessage,
    EventMessage,
    ErrorMessage,
    InfoMessage,
    PublishPayload,
    UUID,
} from "./types.js";

export interface BrokerOptions {
    ringBufferSize: number; // per-topic retained messages for replay
    subscriberQueueSize: number; // per-subscriber outbound queue bound
    heartbeatIntervalMs: number; // info ping interval
}

interface QueuedEvent {
    topic: string;
    message: PublishPayload;
}

class BoundedQueue<T> {
    private items: T[] = [];
    constructor(private capacity: number) {}
    pushDropOldest(item: T): { dropped: number } {
        let dropped = 0;
        if (this.items.length >= this.capacity) {
            this.items.shift();
            dropped = 1;
        }
        this.items.push(item);
        return { dropped };
    }
    drain(max: number): T[] {
        if (max <= 0) return [];
        return this.items.splice(0, Math.min(max, this.items.length));
    }
    get length(): number {
        return this.items.length;
    }
}

class RingBuffer<T> {
    private buffer: (T | undefined)[];
    private start = 0;
    private count = 0;
    constructor(private capacity: number) {
        this.buffer = new Array<T | undefined>(capacity);
    }
    append(value: T) {
        if (this.capacity === 0) return;
        const end = (this.start + this.count) % this.capacity;
        this.buffer[end] = value;
        if (this.count < this.capacity) {
            this.count++;
        } else {
            this.start = (this.start + 1) % this.capacity;
        }
    }
    last(n: number): T[] {
        const take = Math.min(n, this.count);
        const out: T[] = [];
        for (let i = this.count - take; i < this.count; i++) {
            const idx = (this.start + i) % this.capacity;
            const v = this.buffer[idx];
            if (v !== undefined) out.push(v);
        }
        return out;
    }
}

interface Subscriber {
    socket: Socket;
    clientId: string;
    queue: BoundedQueue<QueuedEvent>;
}

interface Topic {
    name: string;
    subscribers: Map<string, Subscriber>; // key: socket.id
    ring: RingBuffer<PublishPayload>;
    stats: {
        messages: number;
        subscribers: number;
        delivered: number;
        dropped: number;
    };
}

export class InMemoryBroker {
    private topics: Map<string, Topic> = new Map();
    private io: SocketIOServer;
    private opts: BrokerOptions;
    private heartbeatTimer?: NodeJS.Timeout;

    constructor(io: SocketIOServer, opts: BrokerOptions) {
        this.io = io;
        this.opts = opts;
    }

    start() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            const msg: InfoMessage = {
                type: "info",
                msg: "ping",
                ts: new Date().toISOString(),
            };
            this.io.sockets.sockets.forEach((s) => s.emit("message", msg));
        }, this.opts.heartbeatIntervalMs);
    }

    stop() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    }

    getHealth() {
        let subscribers = 0;
        for (const t of this.topics.values()) subscribers += t.subscribers.size;
        return {
            uptime_sec: Math.floor(process.uptime()),
            topics: this.topics.size,
            subscribers,
        };
    }

    getTopics() {
        return Array.from(this.topics.values()).map((t) => ({
            name: t.name,
            subscribers: t.subscribers.size,
        }));
    }

    getStats() {
        const topics: Record<string, Topic["stats"]> = {};
        for (const [name, t] of this.topics)
            topics[name] = { ...t.stats, subscribers: t.subscribers.size };
        return { topics };
    }

    createTopic(name: string): { ok: true } | { ok: false; conflict: true } {
        if (this.topics.has(name))
            return { ok: false, conflict: true } as const;
        const topic: Topic = {
            name,
            subscribers: new Map(),
            ring: new RingBuffer<PublishPayload>(this.opts.ringBufferSize),
            stats: { messages: 0, subscribers: 0, delivered: 0, dropped: 0 },
        };
        this.topics.set(name, topic);
        return { ok: true } as const;
    }

    deleteTopic(name: string): { ok: true } | { ok: false; notFound: true } {
        const topic = this.topics.get(name);
        if (!topic) return { ok: false, notFound: true } as const;
        // inform and disconnect all subscribers
        const info: InfoMessage = {
            type: "info",
            topic: name,
            msg: "topic_deleted",
            ts: new Date().toISOString(),
        };
        for (const sub of topic.subscribers.values()) {
            sub.socket.emit("message", info);
            sub.socket.disconnect(true);
        }
        this.topics.delete(name);
        return { ok: true } as const;
    }

    private getTopic(name: string): Topic | undefined {
        return this.topics.get(name);
    }

    subscribe(
        socket: Socket,
        topicName: string,
        clientId: string,
        lastN: number | undefined,
        requestId?: UUID
    ) {
        const topic = this.getTopic(topicName);
        if (!topic) {
            const err: ErrorMessage = {
                type: "error",
                error: {
                    code: "TOPIC_NOT_FOUND",
                    message: `topic ${topicName} not found`,
                },
                ts: new Date().toISOString(),
            };
            if (requestId) err.request_id = requestId;
            socket.emit("message", err);
            return;
        }
        const sub: Subscriber = {
            socket,
            clientId,
            queue: new BoundedQueue<QueuedEvent>(this.opts.subscriberQueueSize),
        };
        topic.subscribers.set(socket.id, sub);
        topic.stats.subscribers = topic.subscribers.size;
        const ack: AckMessage = {
            type: "ack",
            topic: topicName,
            status: "ok",
            ts: new Date().toISOString(),
        };
        if (requestId) ack.request_id = requestId;
        socket.emit("message", ack);
        // replay
        if (lastN && lastN > 0) {
            const toSend = topic.ring.last(lastN);
            for (const m of toSend) {
                const { dropped } = sub.queue.pushDropOldest({
                    topic: topicName,
                    message: m,
                });
                if (dropped > 0) topic.stats.dropped += dropped;
                this.flush(sub, topic);
            }
        }
    }

    unsubscribe(
        socket: Socket,
        topicName: string,
        _clientId: string,
        requestId?: UUID
    ) {
        const topic = this.getTopic(topicName);
        if (!topic) {
            const err: ErrorMessage = {
                type: "error",
                error: {
                    code: "TOPIC_NOT_FOUND",
                    message: `topic ${topicName} not found`,
                },
                ts: new Date().toISOString(),
            };
            if (requestId) err.request_id = requestId;
            socket.emit("message", err);
            return;
        }
        topic.subscribers.delete(socket.id);
        topic.stats.subscribers = topic.subscribers.size;
        const ack: AckMessage = {
            type: "ack",
            topic: topicName,
            status: "ok",
            ts: new Date().toISOString(),
        };
        if (requestId) ack.request_id = requestId;
        socket.emit("message", ack);
    }

    publish(topicName: string, message: PublishPayload, requestId?: UUID) {
        const topic = this.getTopic(topicName);
        const ts = new Date().toISOString();
        if (!topic) {
            // broadcast error? only to initiator; handled by caller via socket
            return { ok: false as const, notFound: true as const };
        }
        topic.stats.messages++;
        topic.ring.append(message);
        for (const sub of topic.subscribers.values()) {
            const { dropped } = sub.queue.pushDropOldest({
                topic: topicName,
                message,
            });
            if (dropped > 0) topic.stats.dropped += dropped;
            this.flush(sub, topic);
        }
        return { ok: true as const, ts };
    }

    handleSocketDisconnect(socket: Socket) {
        for (const topic of this.topics.values()) {
            if (topic.subscribers.delete(socket.id))
                topic.stats.subscribers = topic.subscribers.size;
        }
    }

    private flush(sub: Subscriber, topic: Topic) {
        const batch = sub.queue.drain(100);
        for (const ev of batch) {
            const out: EventMessage = {
                type: "event",
                topic: ev.topic,
                message: ev.message,
                ts: new Date().toISOString(),
            };
            sub.socket.emit("message", out);
            topic.stats.delivered++;
        }
    }
}
