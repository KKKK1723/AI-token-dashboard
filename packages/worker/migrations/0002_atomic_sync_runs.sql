PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sync_runs (
    device_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    window_start_date TEXT NOT NULL,
    window_end_date TEXT NOT NULL,
    bucket_count INTEGER NOT NULL CHECK (bucket_count >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (device_id, snapshot_id),
    UNIQUE (device_id, sequence),
    FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_created_at ON sync_runs(created_at);
