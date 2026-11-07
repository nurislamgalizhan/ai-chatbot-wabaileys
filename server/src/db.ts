import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/**
 * SQLite (WAL) through the built-in node:sqlite driver: zero native
 * dependencies, one file to back up. Every query in the codebase goes
 * through prepared statements with bound parameters — never string
 * interpolation of values.
 */
export type Row = Record<string, SQLInputValue>;
export type Params = SQLInputValue[] | [Record<string, SQLInputValue>];

const MIGRATIONS: string[] = [
  /* 1: core schema */ `
  CREATE TABLE users (
    id                  INTEGER PRIMARY KEY,
    phone               TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    company             TEXT NOT NULL DEFAULT '',
    password_hash       TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id_hash     TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    touched_at  INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE admin_sessions (
    id_hash     TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    mfa_pending INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE otp_codes (
    id          INTEGER PRIMARY KEY,
    phone       TEXT NOT NULL,
    purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'reset', 'admin')),
    code_hash   TEXT NOT NULL,
    payload     TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    ip          TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX otp_lookup ON otp_codes(phone, purpose, created_at);
  CREATE INDEX otp_ip ON otp_codes(ip, created_at);

  CREATE TABLE wa_auth (
    session_id  TEXT NOT NULL,
    kind        TEXT NOT NULL,
    key_id      TEXT NOT NULL,
    value       BLOB NOT NULL,
    PRIMARY KEY (session_id, kind, key_id)
  ) WITHOUT ROWID;

  CREATE TABLE wa_connections (
    session_id   TEXT PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    enabled      INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'disconnected',
    phone        TEXT,
    wa_name      TEXT,
    connected_at INTEGER,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE agent_settings (
    user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ai_enabled         INTEGER NOT NULL DEFAULT 1,
    bot_name           TEXT NOT NULL DEFAULT 'Алма',
    business_name      TEXT NOT NULL DEFAULT '',
    business_about     TEXT NOT NULL DEFAULT '',
    instructions       TEXT NOT NULL DEFAULT '',
    tone               TEXT NOT NULL DEFAULT 'friendly',
    verbosity          TEXT NOT NULL DEFAULT 'medium',
    quality            TEXT NOT NULL DEFAULT 'balanced',
    reply_delay_sec    INTEGER NOT NULL DEFAULT 4,
    operator_pause_min INTEGER NOT NULL DEFAULT 30,
    handoff_enabled    INTEGER NOT NULL DEFAULT 1,
    handoff_message    TEXT NOT NULL DEFAULT '',
    schedule_mode      TEXT NOT NULL DEFAULT 'always',
    work_start         TEXT NOT NULL DEFAULT '09:00',
    work_end           TEXT NOT NULL DEFAULT '19:00',
    voice_enabled      INTEGER NOT NULL DEFAULT 1,
    updated_at         INTEGER NOT NULL
  );

  CREATE TABLE kb_entries (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('faq', 'doc')),
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1,
    index_state TEXT NOT NULL DEFAULT 'pending',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX kb_entries_user ON kb_entries(user_id, updated_at);

  CREATE TABLE kb_chunks (
    id         INTEGER PRIMARY KEY,
    entry_id   INTEGER NOT NULL REFERENCES kb_entries(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL,
    idx        INTEGER NOT NULL,
    content    TEXT NOT NULL,
    embedding  BLOB
  );
  CREATE INDEX kb_chunks_user ON kb_chunks(user_id);
  CREATE INDEX kb_chunks_entry ON kb_chunks(entry_id);

  CREATE TABLE chats (
    id                   INTEGER PRIMARY KEY,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jid                  TEXT NOT NULL,
    lid                  TEXT,
    phone                TEXT,
    name                 TEXT,
    mode                 TEXT NOT NULL DEFAULT 'auto'
                         CHECK (mode IN ('auto', 'paused', 'human', 'off')),
    paused_until         INTEGER,
    needs_attention      INTEGER NOT NULL DEFAULT 0,
    is_resolved          INTEGER NOT NULL DEFAULT 0,
    unread_count         INTEGER NOT NULL DEFAULT 0,
    last_message_at      INTEGER NOT NULL,
    last_message_preview TEXT,
    created_at           INTEGER NOT NULL,
    UNIQUE (user_id, jid)
  );
  CREATE INDEX chats_user_last ON chats(user_id, last_message_at DESC, id DESC);
  CREATE INDEX chats_user_lid ON chats(user_id, lid);

  CREATE TABLE messages (
    id          INTEGER PRIMARY KEY,
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL,
    wa_id       TEXT,
    direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    source      TEXT NOT NULL
                CHECK (source IN ('customer', 'ai', 'operator_panel', 'operator_phone', 'system')),
    kind        TEXT NOT NULL DEFAULT 'text',
    body        TEXT,
    transcript  TEXT,
    status      TEXT NOT NULL DEFAULT 'ok',
    error       TEXT,
    handoff     INTEGER NOT NULL DEFAULT 0,
    model       TEXT,
    tokens_in   INTEGER,
    tokens_out  INTEGER,
    created_at  INTEGER NOT NULL,
    UNIQUE (user_id, wa_id)
  );
  CREATE INDEX messages_chat ON messages(chat_id, id);
  CREATE INDEX messages_user_created ON messages(user_id, created_at);

  CREATE TABLE audit_log (
    id      INTEGER PRIMARY KEY,
    at      INTEGER NOT NULL,
    actor   TEXT NOT NULL,
    action  TEXT NOT NULL,
    target  TEXT,
    result  TEXT NOT NULL,
    ip      TEXT,
    meta    TEXT
  );
  CREATE INDEX audit_action_target ON audit_log(action, target, at);

  -- The audit trail is append-only, even for the application itself.
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,
  /* 2: AI access by date, media in chats, hardened admin sessions */ `
  ALTER TABLE users ADD COLUMN ai_access_until INTEGER;
  ALTER TABLE users ADD COLUMN ai_access_notice TEXT;

  ALTER TABLE messages ADD COLUMN wa_jid TEXT;
  ALTER TABLE messages ADD COLUMN media_state TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE messages ADD COLUMN media_mime TEXT;
  ALTER TABLE messages ADD COLUMN media_name TEXT;
  ALTER TABLE messages ADD COLUMN media_size INTEGER;
  ALTER TABLE messages ADD COLUMN media_seconds INTEGER;
  ALTER TABLE messages ADD COLUMN media_file TEXT;
  ALTER TABLE messages ADD COLUMN media_ref BLOB;
  CREATE INDEX messages_media_age ON messages(media_state, created_at);
  CREATE INDEX messages_chat_time ON messages(chat_id, created_at, id);

  -- Old admin sessions predate MFA-only login: drop them all.
  DELETE FROM admin_sessions;
  ALTER TABLE admin_sessions ADD COLUMN touched_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE admin_sessions ADD COLUMN cred_fp TEXT NOT NULL DEFAULT '';
  `,
  /* 3: chief's view, kept deletions/edits, calls, full-text search */ `
  ALTER TABLE users ADD COLUMN check_until INTEGER;
  ALTER TABLE users ADD COLUMN check_token_hash TEXT;
  CREATE UNIQUE INDEX users_check_token ON users(check_token_hash) WHERE check_token_hash IS NOT NULL;

  CREATE TABLE check_sessions (
    id_hash    TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    touched_at INTEGER NOT NULL
  );
  CREATE INDEX check_sessions_user ON check_sessions(user_id);

  ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
  ALTER TABLE messages ADD COLUMN deleted_by TEXT;
  ALTER TABLE messages ADD COLUMN edited_at INTEGER;

  CREATE TABLE message_edits (
    id         INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    body       TEXT,
    at         INTEGER NOT NULL
  );
  CREATE INDEX message_edits_msg ON message_edits(message_id);

  CREATE TABLE calls (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    call_id    TEXT NOT NULL,
    chat_id    INTEGER REFERENCES chats(id) ON DELETE SET NULL,
    phone      TEXT,
    is_video   INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, call_id)
  );
  CREATE INDEX calls_user_time ON calls(user_id, started_at DESC);

  -- Full-text search over messages (Cyrillic/Kazakh case-insensitive).
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    body, transcript, content = 'messages', content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body, transcript) VALUES (new.id, new.body, new.transcript);
  END;
  CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body, transcript) VALUES ('delete', old.id, old.body, old.transcript);
  END;
  CREATE TRIGGER messages_fts_au AFTER UPDATE OF body, transcript ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body, transcript) VALUES ('delete', old.id, old.body, old.transcript);
    INSERT INTO messages_fts(rowid, body, transcript) VALUES (new.id, new.body, new.transcript);
  END;
  INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
  `,
];

export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    const row = this.raw.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
      | { v: number | null }
      | undefined;
    const current = row?.v ?? 0;
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (version <= current) return;
      this.tx(() => {
        this.raw.exec(sql);
        this.raw
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(version, Date.now());
      });
    });
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Row>(sql: string, ...params: Params): T | undefined {
    return this.stmt(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Params): T[] {
    return this.stmt(sql).all(...(params as SQLInputValue[])) as T[];
  }

  run(sql: string, ...params: Params): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Synchronous transaction. The callback must not await. */
  tx<T>(fn: () => T): T {
    if (this.raw.isTransaction) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}
