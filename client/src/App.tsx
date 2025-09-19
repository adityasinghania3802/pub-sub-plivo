import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import "./App.css";

const WS_URL = import.meta.env.VITE_WS_URL || "http://localhost:4000";
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

type EventMsg = {
    type: "event";
    topic: string;
    message: { id: string; payload: any };
    ts?: string;
};

type ServerMsg =
    | {
          type: "ack";
          topic?: string;
          status: "ok";
          request_id?: string;
          ts?: string;
      }
    | {
          type: "error";
          request_id?: string;
          error: { code: string; message: string };
          ts?: string;
      }
    | { type: "pong"; request_id?: string; ts?: string }
    | { type: "info"; msg: string; topic?: string; ts?: string }
    | EventMsg;

function App() {
    const [connected, setConnected] = useState(false);
    const [topic, setTopic] = useState("orders");
    const [clientId, setClientId] = useState("c-" + uuidv4().slice(0, 8));
    const [topics, setTopics] = useState<
        { name: string; subscribers: number }[]
    >([]);
    const [lastN, setLastN] = useState(0);
    const [payload, setPayload] = useState(
        '{\n  "order_id": "ORD-123",\n  "amount": 99.5,\n  "currency": "USD"\n}'
    );
    const [log, setLog] = useState<string[]>([]);
    const socketRef = useRef<Socket | null>(null);

    useEffect(() => {
        const socket = io(WS_URL, { path: "/ws", transports: ["websocket"] });
        socketRef.current = socket;
        socket.on("connect", () => setConnected(true));
        socket.on("disconnect", () => setConnected(false));
        socket.on("message", (msg: ServerMsg) => {
            setLog((l) => [JSON.stringify(msg), ...l].slice(0, 200));
        });
        return () => {
            socket.disconnect();
        };
    }, []);

    const refreshTopics = async () => {
        const res = await axios.get(`${API_URL}/topics`);
        setTopics(res.data.topics || []);
    };

    useEffect(() => {
        refreshTopics();
        const id = setInterval(refreshTopics, 5000);
        return () => clearInterval(id);
    }, []);

    const createTopic = async () => {
        await axios.post(`${API_URL}/topics`, { name: topic });
        refreshTopics();
    };

    const deleteTopic = async () => {
        await axios.delete(`${API_URL}/topics/${encodeURIComponent(topic)}`);
        refreshTopics();
    };

    const sendSubscribe = () => {
        const reqId = uuidv4();
        socketRef.current?.emit("message", {
            type: "subscribe",
            topic,
            client_id: clientId,
            last_n: lastN,
            request_id: reqId,
        });
    };

    const sendUnsubscribe = () => {
        const reqId = uuidv4();
        socketRef.current?.emit("message", {
            type: "unsubscribe",
            topic,
            client_id: clientId,
            request_id: reqId,
        });
    };

    const sendPublish = () => {
        const reqId = uuidv4();
        let parsed: any;
        try {
            parsed = JSON.parse(payload);
        } catch {
            alert("Payload must be valid JSON");
            return;
        }
        socketRef.current?.emit("message", {
            type: "publish",
            topic,
            message: { id: uuidv4(), payload: parsed },
            request_id: reqId,
        });
    };

    const sendPing = () => {
        const reqId = uuidv4();
        socketRef.current?.emit("message", { type: "ping", request_id: reqId });
    };

    return (
        <div
            className="container"
            style={{ padding: 16, display: "grid", gap: 12 }}
        >
            <h2>Pub/Sub Demo</h2>

            <div
                style={{
                    display: "grid",
                    gap: 8,
                    gridTemplateColumns: "1fr 1fr",
                }}
            >
                <div style={{ display: "grid", gap: 8 }}>
                    <label>
                        Topic
                        <input
                            value={topic}
                            onChange={(e) => setTopic(e.target.value)}
                        />
                    </label>
                    <label>
                        Client ID
                        <input
                            value={clientId}
                            onChange={(e) => setClientId(e.target.value)}
                        />
                    </label>
                    <label>
                        last_n
                        <input
                            type="number"
                            value={lastN}
                            onChange={(e) =>
                                setLastN(parseInt(e.target.value || "0", 10))
                            }
                        />
                    </label>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button onClick={createTopic}>Create topic</button>
                        <button onClick={deleteTopic}>Delete topic</button>
                        <button onClick={refreshTopics}>Refresh topics</button>
                    </div>
                    <div>
                        <strong>Topics</strong>
                        <ul>
                            {topics.map((t) => (
                                <li key={t.name}>
                                    {t.name} — subscribers: {t.subscribers}
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                    <label>
                        Publish payload (JSON)
                        <textarea
                            rows={10}
                            value={payload}
                            onChange={(e) => setPayload(e.target.value)}
                        />
                    </label>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button onClick={sendSubscribe} disabled={!connected}>
                            Subscribe
                        </button>
                        <button onClick={sendUnsubscribe} disabled={!connected}>
                            Unsubscribe
                        </button>
                        <button onClick={sendPublish} disabled={!connected}>
                            Publish
                        </button>
                        <button onClick={sendPing} disabled={!connected}>
                            Ping
                        </button>
                        <span>
                            Status: {connected ? "connected" : "disconnected"}
                        </span>
                    </div>
                </div>
            </div>

            <div>
                <strong>Events</strong>
                <pre
                    style={{
                        height: 260,
                        overflow: "auto",
                        background: "#111",
                        color: "#0f0",
                        padding: 8,
                    }}
                >
                    {log.join("\n")}
                </pre>
            </div>
        </div>
    );
}

export default App;
