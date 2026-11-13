-- Goes up with every password change; a session signed in under an older value is over.
ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
