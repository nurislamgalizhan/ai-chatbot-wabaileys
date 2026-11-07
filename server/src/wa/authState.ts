import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataTypeMap,
} from "baileys";
import type { Db } from "../db.ts";
import type { Sealer } from "../security/crypto.ts";

/**
 * Baileys auth state stored in SQLite instead of loose JSON files.
 * Values are AES-256-GCM sealed: these keys grant full access to the
 * linked WhatsApp account, so they never sit on disk in plain text.
 */
export function useDbAuthState(db: Db, sealer: Sealer, sessionId: string) {
  const read = (kind: string, keyId: string): unknown => {
    const row = db.get<{ value: Uint8Array }>(
      "SELECT value FROM wa_auth WHERE session_id = ? AND kind = ? AND key_id = ?",
      sessionId,
      kind,
      keyId,
    );
    if (!row) return null;
    try {
      return JSON.parse(sealer.open(row.value).toString("utf8"), BufferJSON.reviver);
    } catch {
      return null; // undecryptable (APP_SECRET changed) = treat as missing
    }
  };

  const write = (kind: string, keyId: string, value: unknown) => {
    const sealed = sealer.seal(Buffer.from(JSON.stringify(value, BufferJSON.replacer), "utf8"));
    db.run(
      `INSERT INTO wa_auth (session_id, kind, key_id, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, kind, key_id) DO UPDATE SET value = excluded.value`,
      sessionId,
      kind,
      keyId,
      sealed,
    );
  };

  const remove = (kind: string, keyId: string) => {
    db.run(
      "DELETE FROM wa_auth WHERE session_id = ? AND kind = ? AND key_id = ?",
      sessionId,
      kind,
      keyId,
    );
  };

  const creds: AuthenticationCreds =
    (read("creds", "") as AuthenticationCreds | null) ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = read(type, id);
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          }
          if (value !== null && value !== undefined) {
            out[id] = value as SignalDataTypeMap[T];
          }
        }
        return out;
      },
      set: async (data) => {
        db.tx(() => {
          for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            const bucket = data[type];
            if (!bucket) continue;
            for (const [id, value] of Object.entries(bucket)) {
              if (value) write(type, id, value);
              else remove(type, id);
            }
          }
        });
      },
      clear: async () => {
        db.run("DELETE FROM wa_auth WHERE session_id = ? AND kind <> 'creds'", sessionId);
      },
    },
  };

  return {
    state,
    saveCreds: async () => write("creds", "", creds),
  };
}

export function hasRegisteredCreds(db: Db, sealer: Sealer, sessionId: string): boolean {
  const row = db.get<{ value: Uint8Array }>(
    "SELECT value FROM wa_auth WHERE session_id = ? AND kind = 'creds' AND key_id = ''",
    sessionId,
  );
  if (!row) return false;
  try {
    const creds = JSON.parse(sealer.open(row.value).toString("utf8"), BufferJSON.reviver) as
      | AuthenticationCreds
      | undefined;
    return Boolean(creds?.registered || creds?.me?.id);
  } catch {
    return false;
  }
}

export function wipeAuthState(db: Db, sessionId: string): void {
  db.run("DELETE FROM wa_auth WHERE session_id = ?", sessionId);
}
