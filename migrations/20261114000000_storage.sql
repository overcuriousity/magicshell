CREATE TABLE setups (
    id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
) STRICT;

CREATE TABLE history (
    id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
) STRICT;

CREATE INDEX history_by_time ON history (user_id, at DESC, id DESC);
