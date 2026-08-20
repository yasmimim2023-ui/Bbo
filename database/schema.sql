-- IRONBOX 1.0 — dialogue schema.
--
-- Canonical source. tools/*.js read this file directly; tools/prepare-assets.js
-- copies it to www/data/schema.sql so the app can fetch it at runtime.
--
-- Designed for ~1,000,000+ rows: every lookup is index- or FTS-driven and
-- always bounded by LIMIT. The application never selects the whole table.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dialogues (
    id            INTEGER PRIMARY KEY,
    question      TEXT NOT NULL,
    -- Case/accent/punctuation-folded question, written by the importer.
    -- Exact lookups hit this column, never question.
    question_norm TEXT NOT NULL,
    answer        TEXT NOT NULL,
    category      TEXT,
    emotion       TEXT DEFAULT 'neutral',
    animation     TEXT,
    priority      INTEGER DEFAULT 0,
    language      TEXT DEFAULT 'en-US',
    intent        TEXT,
    keywords      TEXT
);

CREATE INDEX IF NOT EXISTS idx_dialogues_norm_lang
    ON dialogues (question_norm, language);
CREATE INDEX IF NOT EXISTS idx_dialogues_language
    ON dialogues (language);
CREATE INDEX IF NOT EXISTS idx_dialogues_intent
    ON dialogues (intent, language);
CREATE INDEX IF NOT EXISTS idx_dialogues_category
    ON dialogues (category, language);
CREATE INDEX IF NOT EXISTS idx_dialogues_priority
    ON dialogues (priority DESC);

-- Answers used when nothing clears the confidence threshold.
CREATE TABLE IF NOT EXISTS fallbacks (
    id        INTEGER PRIMARY KEY,
    text      TEXT NOT NULL,
    emotion   TEXT DEFAULT 'confused',
    animation TEXT DEFAULT 'confused',
    language  TEXT DEFAULT 'en-US'
);

CREATE INDEX IF NOT EXISTS idx_fallbacks_language ON fallbacks (language);

-- Schema/version bookkeeping and import statistics.
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
