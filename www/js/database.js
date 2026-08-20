/**
 * IRONBOX 1.0 — offline dialogue database.
 *
 * Android  : real SQLite through @capacitor-community/sqlite, with an FTS5
 *            index when the bundled SQLite build provides one. Support is
 *            *probed at runtime*, never assumed — if FTS5 is missing the
 *            engine degrades to indexed normalized/prefix matching and says so
 *            in diagnostics.
 * Browser  : an in-memory index built from data/seed-dialogues.json so the app
 *            is usable during development. This is a development fallback and
 *            is reported as such; it is not SQLite.
 *
 * Scale rules that apply to every query here:
 *   • never SELECT without a LIMIT
 *   • never pull the corpus into JavaScript — ranking sees ≤ searchLimit rows
 *   • bulk import runs in batched transactions
 */

import { DATABASE_CONFIG, LANGUAGE_CONFIG, MATCHING_CONFIG } from './config.js';
import { getPlugin, isNativePlatform, logger, normalizeText, toFtsQuery } from './utils.js';

const SELECT_COLUMNS = `
  d.id, d.question, d.answer, d.category, d.emotion, d.animation,
  d.priority, d.language, d.intent, d.keywords`;

export const SQL = {
  exact: `SELECT ${SELECT_COLUMNS}, 0 AS rank
          FROM dialogues d
          WHERE d.question_norm = ? AND d.language = ?
          ORDER BY d.priority DESC
          LIMIT ?`,

  /**
   * Deliberately no `ORDER BY bm25(...)`.
   *
   * Measured on a 1,000,000-row corpus (tools/validate-database.js --bench):
   *   OR  + ORDER BY bm25   ~1030 ms/query   ← ranks every match, unusable
   *   AND + ORDER BY bm25     ~66 ms/query
   *   AND, no ORDER BY        ~0.2 ms/query  ← early termination at LIMIT
   * Even selecting bm25() as a column costs ~70 ms because it needs global
   * term statistics. IRONBOX therefore lets SQLite do candidate *retrieval*
   * only and ranks the bounded result set in matching.js.
   */
  fts: `SELECT ${SELECT_COLUMNS}
        FROM dialogues_fts
        JOIN dialogues d ON d.id = dialogues_fts.rowid
        WHERE dialogues_fts MATCH ? AND d.language = ?
        LIMIT ?`,

  prefix: `SELECT ${SELECT_COLUMNS}, 1 AS rank
           FROM dialogues d
           WHERE d.language = ? AND d.question_norm LIKE ?
           ORDER BY d.priority DESC
           LIMIT ?`,

  keyword: `SELECT ${SELECT_COLUMNS}, 1 AS rank
            FROM dialogues d
            WHERE d.language = ? AND d.keywords LIKE ?
            ORDER BY d.priority DESC
            LIMIT ?`,

  intent: `SELECT ${SELECT_COLUMNS}, 0.5 AS rank
           FROM dialogues d
           WHERE d.intent = ? AND d.language = ?
           ORDER BY d.priority DESC
           LIMIT ?`,

  fallbacks: `SELECT text, emotion, animation
              FROM fallbacks
              WHERE language = ?
              LIMIT 50`,

  count: 'SELECT COUNT(*) AS total FROM dialogues',
  countByLanguage:
    'SELECT language, COUNT(*) AS total FROM dialogues GROUP BY language',
  sample: `SELECT ${SELECT_COLUMNS} FROM dialogues d ORDER BY d.id LIMIT ?`,
};

export class DialogueDatabase {
  constructor({ config = DATABASE_CONFIG, log = logger } = {}) {
    this.config = config;
    this.log = log;
    this.plugin = null;
    this.native = false;
    this.ready = false;
    this.fts5 = false;
    this.mode = 'uninitialized';
    this.lastError = null;
    this.dbArgs = { database: config.name, readonly: false };
    /** Browser-mode store. */
    this.memory = { rows: [], byToken: new Map(), fallbacks: [] };
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  async initialize() {
    this.native = isNativePlatform();
    this.plugin = getPlugin('CapacitorSQLite');

    if (this.native && this.plugin) {
      try {
        await this.#initializeNative();
        this.mode = 'sqlite';
        this.ready = true;
      } catch (error) {
        this.lastError = error?.message ?? String(error);
        this.log.error('database', 'SQLite init failed; using memory mode', this.lastError);
        await this.#initializeMemory();
        this.mode = 'memory-fallback';
        this.ready = true;
      }
    } else {
      await this.#initializeMemory();
      this.mode = this.native ? 'memory-fallback' : 'memory-browser';
      this.ready = true;
    }

    const total = await this.countDialogues();
    this.log.info(
      'database',
      `Ready — mode=${this.mode} fts5=${this.fts5} rows=${total}`,
    );
    return this.getStatus();
  }

  async #initializeNative() {
    // Order matters: copyFromAssets skips any database that already exists, and
    // opening a connection creates an empty file. Copying first is what makes a
    // packaged corpus actually reach the device.
    try {
      await this.plugin.copyFromAssets({ overwrite: false });
      this.log.info('database', 'Copied packaged database from assets');
    } catch (error) {
      // Expected when no database is packaged, and on every launch after the
      // first, when the file already exists.
      this.log.info('database', 'No packaged database copied (already present or not shipped)');
    }

    await this.plugin.createConnection({
      database: this.config.name,
      encrypted: false,
      mode: 'no-encryption',
      version: this.config.version,
      readonly: false,
    });
    await this.plugin.open(this.dbArgs);

    const schema = await this.#fetchText('data/schema.sql');
    await this.plugin.execute({ ...this.dbArgs, statements: schema, transaction: false });

    this.fts5 = await this.#tryEnableFts5();
    await this.#seedIfEmpty();
  }

  /** Runtime FTS5 probe: create the index, or record that it is unavailable. */
  async #tryEnableFts5() {
    try {
      const ftsSchema = await this.#fetchText('data/schema-fts5.sql');
      await this.plugin.execute({
        ...this.dbArgs,
        statements: ftsSchema,
        transaction: false,
      });
      await this.plugin.query({
        ...this.dbArgs,
        statement: 'SELECT count(*) AS n FROM dialogues_fts LIMIT 1',
        values: [],
      });
      this.log.info('database', 'FTS5 index available');
      return true;
    } catch (error) {
      this.log.warn(
        'database',
        'FTS5 unavailable in this SQLite build; using indexed LIKE matching',
        error?.message,
      );
      return false;
    }
  }

  /** Populate an empty database from the packaged seed. */
  async #seedIfEmpty() {
    const total = await this.countDialogues();
    if (total > 0) return total;

    const seed = await this.#fetchJson('data/seed-dialogues.json');
    if (!seed) return 0;

    const imported = await this.importDialogues(seed.dialogues ?? []);
    await this.importFallbacks(seed.fallbacks ?? []);
    this.log.info('database', `Seeded ${imported} starter dialogues`);
    return imported;
  }

  async #initializeMemory() {
    const seed = await this.#fetchJson('data/seed-dialogues.json');
    this.memory.rows = (seed?.dialogues ?? []).map((row, index) => ({
      id: index + 1,
      question: row.question,
      question_norm: normalizeText(row.question),
      answer: row.answer,
      category: row.category ?? null,
      emotion: row.emotion ?? 'neutral',
      animation: row.animation ?? row.emotion ?? 'speaking',
      priority: row.priority ?? 0,
      language: row.language ?? LANGUAGE_CONFIG.primary,
      intent: row.intent ?? null,
      keywords: row.keywords ?? '',
    }));
    this.memory.fallbacks = seed?.fallbacks ?? [];
    this.#buildMemoryIndex();
    this.fts5 = false;
  }

  #buildMemoryIndex() {
    this.memory.byToken.clear();
    for (const row of this.memory.rows) {
      const tokens = new Set(
        `${row.question_norm} ${normalizeText(row.keywords)}`.split(' ').filter(Boolean),
      );
      for (const token of tokens) {
        if (!this.memory.byToken.has(token)) this.memory.byToken.set(token, []);
        this.memory.byToken.get(token).push(row.id);
      }
    }
  }

  async close() {
    if (this.mode === 'sqlite' && this.plugin) {
      try {
        await this.plugin.closeConnection({ database: this.config.name, readonly: false });
      } catch (error) {
        this.log.warn('database', 'closeConnection failed', error?.message);
      }
    }
    this.ready = false;
  }

  /* ---------------------------------------------------------------- *
   * Queries — every one bounded by LIMIT
   * ---------------------------------------------------------------- */

  async searchExact(text, language, limit = 3) {
    const norm = normalizeText(text);
    if (!norm) return [];
    if (this.mode !== 'sqlite') {
      return this.memory.rows
        .filter((row) => row.language === language && row.question_norm === norm)
        .sort((a, b) => b.priority - a.priority)
        .slice(0, limit)
        .map((row) => ({ ...row, rank: 0, matchType: 'exact' }));
    }
    const rows = await this.#query(SQL.exact, [norm, language, limit]);
    return rows.map((row) => ({ ...row, matchType: 'exact' }));
  }

  /**
   * Two-phase full-text search:
   *   1. AND — every token present. High precision, tiny candidate set.
   *   2. OR  — only when phase 1 returned too little. Broad recall.
   * Both are LIMITed and unranked; matching.js scores the result.
   */
  async searchFts(text, language, limit = this.config.searchLimit) {
    if (this.mode !== 'sqlite' || !this.fts5) return this.searchTokens(text, language, limit);

    const stopWords = MATCHING_CONFIG.stopWords;
    const strict = toFtsQuery(text, { join: 'AND', stopWords });
    if (!strict) return [];

    try {
      const rows = await this.#query(SQL.fts, [strict, language, limit]);
      const results = rows.map((row) => ({ ...row, matchType: 'fts', rank: null }));

      if (results.length < this.config.ftsRecallThreshold) {
        const loose = toFtsQuery(text, { join: 'OR', stopWords });
        const extra = await this.#query(SQL.fts, [loose, language, limit]);
        const seen = new Set(results.map((row) => row.id));
        for (const row of extra) {
          if (!seen.has(row.id)) results.push({ ...row, matchType: 'fts', rank: null });
        }
      }
      return results;
    } catch (error) {
      this.log.warn('database', 'FTS query failed; falling back', error?.message);
      return this.searchTokens(text, language, limit);
    }
  }

  /** Indexed prefix/keyword matching — the no-FTS5 path and the memory path. */
  async searchTokens(text, language, limit = this.config.searchLimit) {
    const norm = normalizeText(text);
    if (!norm) return [];
    const tokens = norm.split(' ').filter((token) => token.length > 2);

    if (this.mode !== 'sqlite') {
      const scores = new Map();
      for (const token of tokens.length > 0 ? tokens : [norm]) {
        for (const id of this.memory.byToken.get(token) ?? []) {
          scores.set(id, (scores.get(id) ?? 0) + 1);
        }
      }
      return [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id, hits]) => ({
          ...this.memory.rows[id - 1],
          rank: -hits,
          matchType: 'keyword',
        }))
        .filter((row) => row.language === language);
    }

    const seen = new Map();
    for (const token of tokens.length > 0 ? tokens : [norm]) {
      const like = `%${token}%`;
      const rows = [
        ...(await this.#query(SQL.prefix, [language, like, limit])),
        ...(await this.#query(SQL.keyword, [language, like, limit])),
      ];
      for (const row of rows) {
        const existing = seen.get(row.id);
        if (existing) existing.rank -= 1;
        else seen.set(row.id, { ...row, rank: 0, matchType: 'keyword' });
      }
      if (seen.size >= limit * 2) break;
    }
    return [...seen.values()].slice(0, limit);
  }

  async searchIntent(intent, language, limit = 5) {
    if (!intent) return [];
    if (this.mode !== 'sqlite') {
      return this.memory.rows
        .filter((row) => row.intent === intent && row.language === language)
        .slice(0, limit)
        .map((row) => ({ ...row, rank: 0.5, matchType: 'intent' }));
    }
    const rows = await this.#query(SQL.intent, [intent, language, limit]);
    return rows.map((row) => ({ ...row, matchType: 'intent' }));
  }

  async getFallbacks(language) {
    if (this.mode !== 'sqlite') {
      return this.memory.fallbacks.filter(
        (row) => (row.language ?? LANGUAGE_CONFIG.primary) === language,
      );
    }
    return this.#query(SQL.fallbacks, [language]);
  }

  async countDialogues() {
    if (this.mode !== 'sqlite') return this.memory.rows.length;
    const rows = await this.#query(SQL.count, []);
    return rows[0]?.total ?? 0;
  }

  async countByLanguage() {
    if (this.mode !== 'sqlite') {
      const counts = {};
      for (const row of this.memory.rows) {
        counts[row.language] = (counts[row.language] ?? 0) + 1;
      }
      return Object.entries(counts).map(([language, total]) => ({ language, total }));
    }
    return this.#query(SQL.countByLanguage, []);
  }

  async sample(limit = 10) {
    if (this.mode !== 'sqlite') return this.memory.rows.slice(0, limit);
    return this.#query(SQL.sample, [limit]);
  }

  /* ---------------------------------------------------------------- *
   * Bulk import / export
   * ---------------------------------------------------------------- */

  /**
   * Insert rows in batched transactions. Used by the admin panel's import and
   * by first-run seeding; sized so a million-row file streams through without
   * ever holding more than `importBatchSize` rows in memory.
   */
  async importDialogues(rows, { onProgress = null } = {}) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    if (this.mode !== 'sqlite') {
      let nextId = this.memory.rows.length;
      for (const row of rows) {
        nextId += 1;
        this.memory.rows.push({
          id: nextId,
          question: row.question,
          question_norm: normalizeText(row.question),
          answer: row.answer,
          category: row.category ?? null,
          emotion: row.emotion ?? 'neutral',
          animation: row.animation ?? row.emotion ?? 'speaking',
          priority: row.priority ?? 0,
          language: row.language ?? LANGUAGE_CONFIG.primary,
          intent: row.intent ?? null,
          keywords: row.keywords ?? '',
        });
      }
      this.#buildMemoryIndex();
      onProgress?.(rows.length, rows.length);
      return rows.length;
    }

    const statement = `INSERT INTO dialogues
      (question, question_norm, answer, category, emotion, animation,
       priority, language, intent, keywords)
      VALUES (?,?,?,?,?,?,?,?,?,?)`;

    let inserted = 0;
    for (let start = 0; start < rows.length; start += this.config.importBatchSize) {
      const batch = rows.slice(start, start + this.config.importBatchSize);
      const values = batch.map((row) => [
        row.question,
        normalizeText(row.question),
        row.answer,
        row.category ?? null,
        row.emotion ?? 'neutral',
        row.animation ?? row.emotion ?? 'speaking',
        row.priority ?? 0,
        row.language ?? LANGUAGE_CONFIG.primary,
        row.intent ?? null,
        row.keywords ?? '',
      ]);

      await this.plugin.executeSet({
        ...this.dbArgs,
        set: [{ statement, values }],
        transaction: true,
      });
      inserted += batch.length;
      onProgress?.(inserted, rows.length);
    }
    return inserted;
  }

  async importFallbacks(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    if (this.mode !== 'sqlite') {
      this.memory.fallbacks.push(...rows);
      return rows.length;
    }
    await this.plugin.executeSet({
      ...this.dbArgs,
      set: [
        {
          statement:
            'INSERT INTO fallbacks (text, emotion, animation, language) VALUES (?,?,?,?)',
          values: rows.map((row) => [
            row.text,
            row.emotion ?? 'confused',
            row.animation ?? 'confused',
            row.language ?? LANGUAGE_CONFIG.primary,
          ]),
        },
      ],
      transaction: true,
    });
    return rows.length;
  }

  /** Export a bounded page of rows — never the whole corpus at once. */
  async exportDialogues({ offset = 0, limit = 5000 } = {}) {
    if (this.mode !== 'sqlite') {
      return this.memory.rows.slice(offset, offset + limit);
    }
    return this.#query(
      `SELECT ${SELECT_COLUMNS} FROM dialogues d ORDER BY d.id LIMIT ? OFFSET ?`,
      [limit, offset],
    );
  }

  async clearDialogues() {
    if (this.mode !== 'sqlite') {
      this.memory.rows = [];
      this.#buildMemoryIndex();
      return true;
    }
    await this.plugin.execute({
      ...this.dbArgs,
      statements: 'DELETE FROM dialogues;',
      transaction: true,
    });
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Diagnostics
   * ---------------------------------------------------------------- */

  getStatus() {
    return {
      ready: this.ready,
      mode: this.mode,
      engine: this.mode === 'sqlite' ? 'SQLite (@capacitor-community/sqlite)' : 'in-memory index',
      fts5: this.fts5,
      searchLimit: this.config.searchLimit,
      error: this.lastError,
    };
  }

  async getDiagnostics() {
    const [total, byLanguage] = await Promise.all([
      this.countDialogues(),
      this.countByLanguage(),
    ]);
    return { ...this.getStatus(), total, byLanguage };
  }

  /** Admin-only raw SELECT, hard-capped. */
  async runSelect(statement, values = [], limit = 50) {
    if (!/^\s*select\b/i.test(statement)) {
      throw new Error('Only SELECT statements are allowed here');
    }
    const bounded = /\blimit\b/i.test(statement)
      ? statement
      : `${statement.replace(/;\s*$/, '')} LIMIT ${limit}`;
    if (this.mode !== 'sqlite') {
      throw new Error('Raw SQL requires the SQLite engine (device build)');
    }
    return this.#query(bounded, values);
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  async #query(statement, values) {
    const result = await this.plugin.query({ ...this.dbArgs, statement, values });
    return result?.values ?? [];
  }

  async #fetchText(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read ${path} (HTTP ${response.status})`);
    return response.text();
  }

  async #fetchJson(path) {
    try {
      const response = await fetch(path, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      this.log.warn('database', `Could not read ${path}`, error?.message);
      return null;
    }
  }
}

export default DialogueDatabase;
