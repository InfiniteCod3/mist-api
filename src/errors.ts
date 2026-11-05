/** Errors that keep their shape across IPC: thrown on the native side, rebuilt on the page from a WireError. */
import type { CallAnswer, WireError } from "./protocol.ts";
import { HttpError, isRecord } from "./util.ts";

/**
 * Thrown by a native method to give the page a code to branch on: the page's `mist.native` call
 * rejects with a MistNativeError that has the same `code` and a structured clone of `data`.
 */
export class NativeError<D = unknown> extends Error {
    constructor(readonly code: string, readonly data?: D, message: string = code) {
        super(message);
        this.name = "NativeError";
    }
}

/** A NativeError as the page gets it from `mist.native` */
export class MistNativeError<D = unknown> extends Error {
    constructor(readonly code: string, readonly data: D | undefined, message: string) {
        super(message);
        this.name = "MistNativeError";
    }
}

/** `data` must survive IPC's structured clone, or the whole answer would fail to cross; it's dropped instead */
function cloneable(data: unknown) {
    try {
        structuredClone(data);
        return true;
    } catch {
        return false;
    }
}

export function toWire(err: unknown): WireError {
    if (err instanceof NativeError) {
        const wire: WireError = { name: err.name, message: err.message, code: err.code };
        if (err.data !== undefined && cloneable(err.data)) wire.data = err.data;
        return wire;
    }
    if (err instanceof HttpError) return { name: err.name, message: err.message, status: err.status };
    if (err instanceof Error) return { name: err.name, message: err.message };
    return { name: "Error", message: String(err) };
}

export function fromWire(wire: WireError): Error {
    if (typeof wire.code === "string") return new MistNativeError(wire.code, wire.data, wire.message);
    if (wire.name === "HttpError" && typeof wire.status === "number") return new HttpError(wire.status);
    const err = new Error(wire.message);
    err.name = wire.name;
    return err;
}

export const isCallAnswer = (value: unknown): value is CallAnswer =>
    isRecord(value) && value.__mist_answer === 1 && typeof value.ok === "boolean";
