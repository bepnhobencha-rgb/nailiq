"use client";

import {
  TURNIQ_OFFLINE_SCHEMA_VERSION,
  turnIqOfflineCommandSchema,
  type TurnIqOfflineCommand,
  type TurnIqOfflineQueueRecord,
  type TurnIqOfflineSnapshot,
} from "@/shared/turniq/offlineContracts";

const DATABASE_NAME = "nailiq-turniq-offline-v1";
const DATABASE_VERSION = 1;
const COMMAND_STORE = "commands";
const META_STORE = "meta";
const KEY_STORE = "keys";
const SNAPSHOT_KEY = "snapshot";
const DEVICE_KEY = "device";
const CRYPTO_KEY = "outbox-aes-gcm";

type EncryptedRecord = {
  id: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

type MetaRecord = { id: string; value: unknown };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb_request_failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("indexeddb_transaction_aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("indexeddb_transaction_failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("turniq_offline_storage_unsupported"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(COMMAND_STORE)) {
        database.createObjectStore(COMMAND_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(KEY_STORE)) {
        database.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb_open_failed"));
  });
}

async function encryptionKey(database: IDBDatabase): Promise<CryptoKey> {
  const read = database.transaction(KEY_STORE, "readonly");
  const existing = await requestResult<{ id: string; value: CryptoKey } | undefined>(
    read.objectStore(KEY_STORE).get(CRYPTO_KEY),
  );
  await transactionDone(read);
  if (existing?.value) return existing.value;

  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const write = database.transaction(KEY_STORE, "readwrite");
  write.objectStore(KEY_STORE).put({ id: CRYPTO_KEY, value: generated });
  await transactionDone(write);
  return generated;
}

async function encryptJson(key: CryptoKey, value: unknown): Promise<Omit<EncryptedRecord, "id">> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv: iv.buffer, ciphertext };
}

async function decryptJson<T>(key: CryptoKey, record: EncryptedRecord): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(record.iv) },
    key,
    record.ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** Encrypted IndexedDB outbox. Every mutator resolves only after commit. */
export class TurnIqOfflineStore {
  async saveSnapshot<T>(snapshot: TurnIqOfflineSnapshot<T>): Promise<void> {
    const database = await openDatabase();
    try {
      const key = await encryptionKey(database);
      const encrypted = await encryptJson(key, snapshot);
      const transaction = database.transaction(META_STORE, "readwrite");
      transaction.objectStore(META_STORE).put({
        id: SNAPSHOT_KEY,
        value: { schemaVersion: TURNIQ_OFFLINE_SCHEMA_VERSION, ...encrypted },
      } satisfies MetaRecord);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async loadSnapshot<T>(): Promise<TurnIqOfflineSnapshot<T> | null> {
    const database = await openDatabase();
    try {
      const key = await encryptionKey(database);
      const transaction = database.transaction(META_STORE, "readonly");
      const row = await requestResult<MetaRecord | undefined>(
        transaction.objectStore(META_STORE).get(SNAPSHOT_KEY),
      );
      await transactionDone(transaction);
      if (!row) return null;
      const value = row.value as EncryptedRecord & { schemaVersion?: number };
      if (value.schemaVersion !== TURNIQ_OFFLINE_SCHEMA_VERSION) {
        throw new Error("turniq_offline_snapshot_version_unsupported");
      }
      return decryptJson<TurnIqOfflineSnapshot<T>>(key, { ...value, id: SNAPSHOT_KEY });
    } finally {
      database.close();
    }
  }

  async queue(command: TurnIqOfflineCommand): Promise<void> {
    const parsed = turnIqOfflineCommandSchema.parse(command);
    const database = await openDatabase();
    try {
      const key = await encryptionKey(database);
      const record: TurnIqOfflineQueueRecord = { command: parsed, status: "queued" };
      const encrypted = await encryptJson(key, record);
      const transaction = database.transaction(COMMAND_STORE, "readwrite");
      transaction.objectStore(COMMAND_STORE).add({
        id: parsed.commandId,
        ...encrypted,
      } satisfies EncryptedRecord);
      await transactionDone(transaction);
      const verify = database.transaction(COMMAND_STORE, "readonly");
      const row = await requestResult<EncryptedRecord | undefined>(
        verify.objectStore(COMMAND_STORE).get(parsed.commandId),
      );
      await transactionDone(verify);
      const persisted = row ? await decryptJson<TurnIqOfflineQueueRecord>(key, row) : null;
      if (!persisted || persisted.command.requestFingerprint !== parsed.requestFingerprint) {
        throw new Error("turniq_offline_persist_verification_failed");
      }
    } finally {
      database.close();
    }
  }

  async list(): Promise<TurnIqOfflineQueueRecord[]> {
    const database = await openDatabase();
    try {
      const key = await encryptionKey(database);
      const transaction = database.transaction(COMMAND_STORE, "readonly");
      const rows = await requestResult<EncryptedRecord[]>(
        transaction.objectStore(COMMAND_STORE).getAll(),
      );
      await transactionDone(transaction);
      const decoded = await Promise.all(rows.map((row) => decryptJson<TurnIqOfflineQueueRecord>(key, row)));
      return decoded.sort((left, right) => left.command.localSequence - right.command.localSequence);
    } finally {
      database.close();
    }
  }

  async get(commandId: string): Promise<TurnIqOfflineQueueRecord | null> {
    const database = await openDatabase();
    try {
      const key = await encryptionKey(database);
      const transaction = database.transaction(COMMAND_STORE, "readonly");
      const row = await requestResult<EncryptedRecord | undefined>(
        transaction.objectStore(COMMAND_STORE).get(commandId),
      );
      await transactionDone(transaction);
      return row ? decryptJson<TurnIqOfflineQueueRecord>(key, row) : null;
    } finally {
      database.close();
    }
  }

  async update(record: TurnIqOfflineQueueRecord): Promise<void> {
    const database = await openDatabase();
    try {
      const key = await encryptionKey(database);
      const encrypted = await encryptJson(key, record);
      const transaction = database.transaction(COMMAND_STORE, "readwrite");
      transaction.objectStore(COMMAND_STORE).put({
        id: record.command.commandId,
        ...encrypted,
      } satisfies EncryptedRecord);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async removeCommitted(commandId: string): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(COMMAND_STORE, "readwrite");
      transaction.objectStore(COMMAND_STORE).delete(commandId);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async saveDeviceIdentity(value: { deviceId: string; label: string }): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(META_STORE, "readwrite");
      transaction.objectStore(META_STORE).put({ id: DEVICE_KEY, value } satisfies MetaRecord);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async loadDeviceIdentity(): Promise<{ deviceId: string; label: string } | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(META_STORE, "readonly");
      const row = await requestResult<MetaRecord | undefined>(
        transaction.objectStore(META_STORE).get(DEVICE_KEY),
      );
      await transactionDone(transaction);
      const value = row?.value as { deviceId?: unknown; label?: unknown } | undefined;
      return typeof value?.deviceId === "string" && typeof value.label === "string"
        ? { deviceId: value.deviceId, label: value.label }
        : null;
    } finally {
      database.close();
    }
  }
}
