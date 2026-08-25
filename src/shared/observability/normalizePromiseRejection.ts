export type NormalizedPromiseRejection = {
  message: string;
  stack: string | null;
};

function readStringField(value: object, field: string): string | null {
  try {
    const candidate = Reflect.get(value, field);
    return typeof candidate === "string" && candidate.trim()
      ? candidate.trim()
      : null;
  } catch {
    return null;
  }
}

function rejectionKind(value: object): string {
  try {
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    return tag && tag !== "Object" ? tag : "object";
  } catch {
    return "object";
  }
}

/**
 * Browser SDKs can reject with cross-realm errors or plain objects. Those do
 * not pass `instanceof Error`, which previously collapsed useful provider
 * evidence into the generic "Unhandled promise rejection" alert. Read only
 * non-sensitive diagnostic fields; never stringify the full rejection because
 * payment SDK objects may contain customer or token data.
 */
export function normalizePromiseRejection(
  reason: unknown,
): NormalizedPromiseRejection {
  if (reason instanceof Error) {
    return {
      message: reason.message || reason.name || "Unhandled promise rejection",
      stack: reason.stack ?? null,
    };
  }

  if (typeof reason === "string") {
    return {
      message: reason.trim() || "Unhandled promise rejection",
      stack: null,
    };
  }

  if ((typeof reason === "object" && reason !== null) || typeof reason === "function") {
    const value = reason as object;
    const message = readStringField(value, "message");
    const name = readStringField(value, "name");
    const code = readStringField(value, "code");
    const status = readStringField(value, "status");
    const stack = readStringField(value, "stack");
    const diagnostic = [
      name && name !== "Error" ? name : null,
      code ? `code=${code}` : null,
      status ? `status=${status}` : null,
    ].filter(Boolean);

    return {
      message:
        message ??
        (diagnostic.length > 0
          ? `Unhandled promise rejection (${diagnostic.join(", ")})`
          : `Unhandled promise rejection (${rejectionKind(value)})`),
      stack,
    };
  }

  return {
    message:
      reason === null
        ? "Unhandled promise rejection (null)"
        : reason === undefined
          ? "Unhandled promise rejection (undefined)"
          : `Unhandled promise rejection (${typeof reason})`,
    stack: null,
  };
}
