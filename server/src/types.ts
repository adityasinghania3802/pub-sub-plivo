export type UUID = string;

export type ClientMessageType =
    | "subscribe"
    | "unsubscribe"
    | "publish"
    | "ping";
export type ServerMessageType = "ack" | "event" | "error" | "pong" | "info";

export interface PublishPayload {
    id: UUID;
    payload: unknown;
}

export interface ClientMessageBase {
    type: ClientMessageType;
    request_id?: UUID;
}

export interface SubscribeMessage extends ClientMessageBase {
    type: "subscribe";
    topic: string;
    client_id: string;
    last_n?: number;
}

export interface UnsubscribeMessage extends ClientMessageBase {
    type: "unsubscribe";
    topic: string;
    client_id: string;
}

export interface PublishMessage extends ClientMessageBase {
    type: "publish";
    topic: string;
    message: PublishPayload;
}

export interface PingMessage extends ClientMessageBase {
    type: "ping";
}

export type ClientMessage =
    | SubscribeMessage
    | UnsubscribeMessage
    | PublishMessage
    | PingMessage;

export interface ServerMessageBase {
    type: ServerMessageType;
    request_id?: UUID;
    ts?: string;
}

export interface AckMessage extends ServerMessageBase {
    type: "ack";
    topic?: string;
    status: "ok";
}

export interface EventMessage extends ServerMessageBase {
    type: "event";
    topic: string;
    message: PublishPayload;
}

export type ErrorCode =
    | "BAD_REQUEST"
    | "TOPIC_NOT_FOUND"
    | "SLOW_CONSUMER"
    | "UNAUTHORIZED"
    | "INTERNAL";

export interface ErrorMessage extends ServerMessageBase {
    type: "error";
    error: {
        code: ErrorCode;
        message: string;
    };
}

export interface PongMessage extends ServerMessageBase {
    type: "pong";
}

export interface InfoMessage extends ServerMessageBase {
    type: "info";
    topic?: string;
    msg: string;
}

export type ServerMessage =
    | AckMessage
    | EventMessage
    | ErrorMessage
    | PongMessage
    | InfoMessage;

export interface TopicStats {
    messages: number;
    subscribers: number;
    delivered: number;
    dropped: number;
}

export interface HealthStats {
    uptime_sec: number;
    topics: number;
    subscribers: number;
}
