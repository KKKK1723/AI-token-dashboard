PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    timezone TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_sequence INTEGER NOT NULL DEFAULT 0,
    collector_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_usage (
    device_id TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    source TEXT NOT NULL,
    model TEXT NOT NULL,
    requests INTEGER NOT NULL CHECK (requests >= 0),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    cache_creation_tokens INTEGER NOT NULL CHECK (cache_creation_tokens >= 0),
    cost_picos TEXT NOT NULL,
    data_through TEXT,
    sequence INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (device_id, usage_date, source, model),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(usage_date);
