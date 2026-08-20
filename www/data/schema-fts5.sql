-- IRONBOX 1.0 — FTS5 index (applied only when the SQLite build supports FTS5).
--
-- External-content table: the index stores no copy of the text, so a
-- million-row corpus costs roughly one index rather than two tables.
-- `unicode61 remove_diacritics 2` makes "olá" and "ola" match.

CREATE VIRTUAL TABLE IF NOT EXISTS dialogues_fts USING fts5(
    question,
    keywords,
    answer,
    content='dialogues',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS dialogues_ai AFTER INSERT ON dialogues BEGIN
    INSERT INTO dialogues_fts (rowid, question, keywords, answer)
    VALUES (new.id, new.question, COALESCE(new.keywords, ''), new.answer);
END;

CREATE TRIGGER IF NOT EXISTS dialogues_ad AFTER DELETE ON dialogues BEGIN
    INSERT INTO dialogues_fts (dialogues_fts, rowid, question, keywords, answer)
    VALUES ('delete', old.id, old.question, COALESCE(old.keywords, ''), old.answer);
END;

CREATE TRIGGER IF NOT EXISTS dialogues_au AFTER UPDATE ON dialogues BEGIN
    INSERT INTO dialogues_fts (dialogues_fts, rowid, question, keywords, answer)
    VALUES ('delete', old.id, old.question, COALESCE(old.keywords, ''), old.answer);
    INSERT INTO dialogues_fts (rowid, question, keywords, answer)
    VALUES (new.id, new.question, COALESCE(new.keywords, ''), new.answer);
END;
