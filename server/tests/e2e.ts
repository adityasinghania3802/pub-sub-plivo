/// <reference types="node" />
import axios from "axios";
import { io, Socket } from "socket.io-client";

const API = process.env.API_URL || "http://localhost:4000";
const WS = process.env.WS_URL || "http://localhost:4000";

function delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
}

async function withSocket<T>(fn: (s: Socket) => Promise<T>): Promise<T> {
    const s = io(WS, { path: "/ws", transports: ["websocket"] });
    await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("connect timeout")), 5000);
        s.on("connect", () => {
            clearTimeout(t);
            resolve();
        });
        s.on("connect_error", reject);
    });
    try {
        return await fn(s);
    } finally {
        s.disconnect();
    }
}

async function expectStatus<T>(p: Promise<T>, code: number) {
    try {
        await p;
        throw new Error("expected HTTP " + code);
    } catch (e: any) {
        if (e.response?.status !== code) throw e;
    }
}

async function run() {
    console.log("E2E start");

    // Clean: delete topic if exists
    try {
        await axios.delete(`${API}/topics/e2e`);
    } catch {}

    // Create topic
    const create = await axios.post(`${API}/topics`, { name: "e2e" });
    if (create.status !== 201) throw new Error("create topic failed");
    await expectStatus(axios.post(`${API}/topics`, { name: "e2e" }), 409);

    // Health
    const health = await axios.get(`${API}/health`);
    if (typeof health.data.uptime_sec !== "number")
        throw new Error("health bad");

    // Stats initial
    const stats0 = await axios.get(`${API}/stats`);

    // Isolation + fanout
    const s1Msgs: any[] = [];
    const s2Msgs: any[] = [];
    await withSocket(async (s1) => {
        s1.on("message", (m: any) => {
            if (m.type === "event") s1Msgs.push(m);
        });
        s1.emit("message", {
            type: "subscribe",
            topic: "e2e",
            client_id: "s1",
            last_n: 0,
            request_id: "r1",
        });

        await withSocket(async (s2) => {
            s2.on("message", (m: any) => {
                if (m.type === "event") s2Msgs.push(m);
            });
            s2.emit("message", {
                type: "subscribe",
                topic: "e2e",
                client_id: "s2",
                last_n: 0,
                request_id: "r2",
            });

            // Publish 3
            for (let i = 0; i < 3; i++) {
                s1.emit("message", {
                    type: "publish",
                    topic: "e2e",
                    message: { id: `m${i}`, payload: { seq: i } },
                    request_id: `p${i}`,
                });
            }

            await delay(500);
            if (s1Msgs.length !== 3 || s2Msgs.length !== 3)
                throw new Error("fanout failed");

            // Unsubscribe idempotent
            s2.emit("message", {
                type: "unsubscribe",
                topic: "e2e",
                client_id: "s2",
                request_id: "u1",
            });
            await delay(100);
            s2.emit("message", {
                type: "unsubscribe",
                topic: "e2e",
                client_id: "s2",
                request_id: "u2",
            });
            await delay(100);

            // Ping/pong
            s1.emit("message", { type: "ping", request_id: "ping-1" });
        });
    });

    // Replay last_n
    const replay: any[] = [];
    await withSocket(async (sr) => {
        sr.on("message", (m: any) => {
            if (m.type === "event") replay.push(m);
        });
        sr.emit("message", {
            type: "subscribe",
            topic: "e2e",
            client_id: "r1",
            last_n: 2,
            request_id: "rr",
        });
        await delay(300);
        if (replay.length !== 2) throw new Error("replay failed");
    });

    // Publish to missing topic -> error
    const errors: any[] = [];
    await withSocket(async (se) => {
        se.on("message", (m: any) => {
            if (m.type === "error") errors.push(m);
        });
        se.emit("message", {
            type: "publish",
            topic: "missing",
            message: { id: "x", payload: {} },
            request_id: "ee",
        });
        await delay(200);
        if (!errors.find((e) => e.error?.code === "TOPIC_NOT_FOUND"))
            throw new Error("missing topic error not seen");
    });

    // Isolation: subscribe to another topic e2e2, publish to e2e, ensure no events
    try {
        await axios.post(`${API}/topics`, { name: "e2e2" });
    } catch {}
    const iso: any[] = [];
    await withSocket(async (si) => {
        si.on("message", (m: any) => {
            if (m.type === "event") iso.push(m);
        });
        si.emit("message", {
            type: "subscribe",
            topic: "e2e2",
            client_id: "iso",
            last_n: 0,
        });
        await withSocket(async (sp) => {
            sp.emit("message", {
                type: "publish",
                topic: "e2e",
                message: { id: "z1", payload: { ok: true } },
            });
            await delay(200);
        });
        if (iso.length !== 0) throw new Error("isolation failed");
    });

    // Delete topic disconnects subscribers
    const info: any[] = [];
    await withSocket(async (sd) => {
        sd.on("message", (m: any) => {
            if (m.type === "info") info.push(m);
        });
        sd.emit("message", {
            type: "subscribe",
            topic: "e2e",
            client_id: "d1",
        });
        await delay(100);
        await axios.delete(`${API}/topics/e2e`);
        await delay(200);
        if (!info.find((i) => i.msg === "topic_deleted"))
            throw new Error("no topic_deleted info");
    });

    // Backpressure: publish many; expect drops >= 0 (best-effort)
    await axios.post(`${API}/topics`, { name: "bp" }).catch(() => {});
    const hold: any[] = [];
    await withSocket(async (sbp) => {
        sbp.on("message", (m: any) => {
            if (m.type === "event") hold.push(m);
        });
        sbp.emit("message", {
            type: "subscribe",
            topic: "bp",
            client_id: "bp1",
        });
        await withSocket(async (sp) => {
            for (let i = 0; i < 1200; i++) {
                sp.emit("message", {
                    type: "publish",
                    topic: "bp",
                    message: { id: `bp-${i}`, payload: { seq: i } },
                });
            }
        });
        await delay(500);
    });
    const stats = await axios.get(`${API}/stats`);
    if (!stats.data?.topics?.bp) throw new Error("stats missing bp");
    console.log("bp dropped:", stats.data.topics.bp.dropped);

    console.log("E2E ok");
}

run().catch((e) => {
    console.error("E2E fail:", e?.message || e);
    process.exit(1);
});
