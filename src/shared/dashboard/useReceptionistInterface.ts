"use client";

import { useCallback, useSyncExternalStore } from "react";

export type ReceptionistInterface = "classic" | "preview";

export const RECEPTIONIST_INTERFACE_STORAGE_KEY =
  "nailiq-receptionist-interface";

const listeners = new Set<() => void>();
let snapshot: ReceptionistInterface | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function readStored(): ReceptionistInterface {
  if (snapshot !== null) return snapshot;

  try {
    snapshot =
      window.localStorage.getItem(RECEPTIONIST_INTERFACE_STORAGE_KEY) ===
      "preview"
        ? "preview"
        : "classic";
  } catch {
    snapshot = "classic";
  }

  return snapshot;
}

function onStorage(): void {
  snapshot = null;
  emit();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function writeStored(next: ReceptionistInterface): void {
  try {
    window.localStorage.setItem(RECEPTIONIST_INTERFACE_STORAGE_KEY, next);
  } catch {
    // Private browsing or storage quota failure: keep the in-memory choice.
  }

  snapshot = next;
  emit();
}

const getServerSnapshot = (): ReceptionistInterface => "classic";
const noopSubscribe = () => () => {};
const getMountedSnapshot = () => true;

export function useReceptionistInterface(): {
  receptionistInterface: ReceptionistInterface;
  setReceptionistInterface: (next: ReceptionistInterface) => void;
  hydrated: boolean;
} {
  const receptionistInterface = useSyncExternalStore(
    subscribe,
    readStored,
    getServerSnapshot,
  );
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    getMountedSnapshot,
    () => false,
  );
  const setReceptionistInterface = useCallback(
    (next: ReceptionistInterface) => writeStored(next),
    [],
  );

  return {
    receptionistInterface,
    setReceptionistInterface,
    hydrated,
  };
}
