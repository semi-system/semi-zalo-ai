-- Standalone schema. Use a dedicated database; existing n8n tables are not mutated.
CREATE TABLE IF NOT EXISTS app_admins (
 id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_users (
 thread_id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, is_group BOOLEAN NOT NULL DEFAULT false,
 enabled BOOLEAN NOT NULL DEFAULT false, role TEXT NOT NULL DEFAULT 'pending' CHECK(role IN ('pending','user','blocked')),
 first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_messages (
 id BIGSERIAL PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES app_users(thread_id),
 sender_id TEXT NOT NULL, message_id TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'in',
 message_text TEXT NOT NULL DEFAULT '', attachment_type TEXT, attachment_url TEXT,
 status TEXT NOT NULL DEFAULT 'received', reply_text TEXT, error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), replied_at TIMESTAMPTZ,
 UNIQUE(thread_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_app_messages_thread_created ON app_messages(thread_id,created_at DESC);
CREATE TABLE IF NOT EXISTS app_chat_history (
 id BIGSERIAL PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES app_users(thread_id),
 role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_chat_history_thread_id ON app_chat_history(thread_id,id DESC);
CREATE TABLE IF NOT EXISTS app_settings (
 key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_audit (
 id BIGSERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
 target TEXT, metadata JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_connections (
 provider TEXT PRIMARY KEY CHECK(provider IN ('ollama','searxng')),
 url TEXT NOT NULL, auth_type TEXT NOT NULL DEFAULT 'none' CHECK(auth_type IN ('none','bearer','basic')),
 model TEXT, vision_model TEXT, results INTEGER, credential_ciphertext TEXT,
 tested_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
