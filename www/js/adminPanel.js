/**
 * IRONBOX 1.0 — developer/admin panel.
 *
 * Pure UI: reads from Diagnostics and calls into the managers. The important
 * control here is "Reload Videos", which rebuilds the animation registry from
 * the external directory without restarting the app or rebuilding the APK.
 */

import { LANGUAGE_CONFIG } from './config.js';
import { escapeHtml, formatBytes, logger } from './utils.js';
import { explainScore } from './matching.js';

export class AdminPanel {
  constructor({ app, diagnostics, settings, log = logger }) {
    this.app = app;
    this.diagnostics = diagnostics;
    this.settings = settings;
    this.log = log;
    this.dialog = document.getElementById('admin');
    this.bound = false;
  }

  initialize() {
    if (this.bound) return this;
    this.bound = true;

    document.getElementById('open-admin').addEventListener('click', () => this.open());
    document.getElementById('close-admin').addEventListener('click', () => this.close());

    for (const tab of document.querySelectorAll('.admin__tab')) {
      tab.addEventListener('click', () => this.#selectTab(tab.dataset.tab));
    }

    this.#bindVideoControls();
    this.#bindDatabaseControls();
    this.#bindTestControls();

    document.getElementById('btn-clear-logs').addEventListener('click', () => {
      this.log.clear();
      this.renderLogs();
    });

    this.log.onEntry(() => {
      if (this.dialog.open) this.renderLogs();
    });

    this.#populateSettings();
    return this;
  }

  async open() {
    this.dialog.showModal();
    await this.refresh();
  }

  close() {
    this.dialog.close();
  }

  async refresh() {
    await Promise.all([this.renderVideos(), this.renderDatabase()]);
    this.renderLogs();
  }

  #selectTab(name) {
    for (const tab of document.querySelectorAll('.admin__tab')) {
      tab.classList.toggle('is-active', tab.dataset.tab === name);
    }
    for (const panel of document.querySelectorAll('.admin__panel')) {
      panel.classList.toggle('is-active', panel.dataset.panel === name);
    }
  }

  /* ------------------------------ Videos --------------------------- */

  #bindVideoControls() {
    const output = document.getElementById('video-diagnostics');

    document.getElementById('btn-reload-videos').addEventListener('click', async () => {
      output.textContent = 'Reloading animations from storage…';
      await this.app.animations.reloadAnimations();
      await this.renderVideos();
    });

    document.getElementById('btn-validate-videos').addEventListener('click', async () => {
      output.textContent = 'Validating…';
      const summary = await this.diagnostics.validateVideos((done, total) => {
        output.textContent = `Validating ${done}/${total}…`;
      });
      await this.renderVideos();
      output.textContent += `\n\nValidated ${summary.total}: ${summary.valid} valid, ${summary.invalid} invalid.`;
    });

    const fileInput = document.getElementById('video-file-input');
    document.getElementById('btn-import-videos').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const files = [...(fileInput.files ?? [])];
      if (files.length === 0) return;
      output.textContent = `Importing ${files.length} file(s)…`;

      const results = [];
      for (const file of files) {
        try {
          const result = await this.app.storage.importVideo(file);
          results.push(`✓ ${result.name} (${formatBytes(result.bytes)}) → ${result.source}`);
        } catch (error) {
          results.push(`✗ ${file.name} — ${error?.message ?? 'import failed'}`);
        }
      }
      fileInput.value = '';
      await this.app.animations.reloadAnimations();
      await this.renderVideos();
      output.textContent = `${results.join('\n')}\n\n${output.textContent}`;
    });

    document.getElementById('btn-write-manifest').addEventListener('click', async () => {
      const manifest = {};
      for (const [category, entry] of Object.entries(this.app.videos.manifest)) {
        manifest[category] = {
          videos: entry.videos.map(({ file, weight, loop }) => ({ file, weight, loop })),
        };
      }
      const written = await this.app.storage.saveManifest(manifest);
      output.textContent = written
        ? `Wrote animation-manifest.json with ${Object.keys(manifest).length} categories.\nEdit it on the device to repoint categories at any filename.`
        : 'Could not write the manifest (external storage unavailable in this environment).';
    });

    document.getElementById('btn-test-animation').addEventListener('click', async () => {
      const category = document.getElementById('animation-select').value;
      const result = await this.diagnostics.testAnimation(category);
      output.textContent = `${result.ok ? '✓' : '✗'} ${result.message}\n\n${output.textContent}`;
    });
  }

  async renderVideos() {
    const report = await this.diagnostics.render();
    document.getElementById('video-diagnostics').textContent = report;

    const directory = this.app.storage.getExternalVideoDirectory();
    document.getElementById('video-directory-hint').textContent = directory.available
      ? `External videos: ${directory.hint}`
      : `External storage unavailable here — packaged videos only. On a device this is ${directory.hint}`;

    const select = document.getElementById('animation-select');
    const categories = Object.keys(this.app.videos.manifest).sort();
    const previous = select.value;
    select.innerHTML = categories
      .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
      .join('');
    if (categories.includes(previous)) select.value = previous;

    const body = document.querySelector('#video-table tbody');
    const rows = [];
    for (const [category, entry] of Object.entries(this.app.videos.manifest)) {
      for (const video of entry.videos) {
        const source = this.app.videos.getSource(video.file);
        const validation = this.app.videos.validation.get(video.file);
        const status = validation?.status ?? 'unknown';
        rows.push(
          `<tr>
            <td>${escapeHtml(category)}</td>
            <td>${escapeHtml(video.file)}</td>
            <td class="source-${escapeHtml(source)}">${escapeHtml(source)}</td>
            <td class="status-${escapeHtml(status)}">${escapeHtml(status)}${
              validation?.reason ? ` — ${escapeHtml(validation.reason)}` : ''
            }</td>
          </tr>`,
        );
      }
    }
    body.innerHTML = rows.join('') ||
      '<tr><td colspan="4">No videos registered. Add MP4 files to the external videos directory or package defaults in www/videos/.</td></tr>';
  }

  /* ----------------------------- Database -------------------------- */

  #bindDatabaseControls() {
    const output = document.getElementById('database-diagnostics');

    document.getElementById('btn-db-refresh').addEventListener('click', () => this.renderDatabase());

    document.getElementById('btn-db-query').addEventListener('click', async () => {
      const text = document.getElementById('db-query').value.trim();
      if (!text) return;
      const result = await this.diagnostics.testDialogue(text);
      const response = result.response;
      const lines = [
        `query:      ${text}`,
        `answer:     ${response.answer}`,
        `emotion:    ${response.emotion}   animation: ${response.animation}`,
        `confidence: ${response.confidence.toFixed(3)}  (${response.matchType})`,
        `source:     ${response.source}`,
        `elapsed:    ${result.elapsedMs} ms`,
        '',
        'candidates:',
        ...response.candidates.map(
          (candidate, index) =>
            `  ${index + 1}. ${candidate.question} → ${explainScore(candidate)}`,
        ),
      ];
      document.getElementById('database-query-output').textContent = lines.join('\n');
    });

    const fileInput = document.getElementById('db-file-input');
    document.getElementById('btn-db-import').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      output.textContent = `Reading ${file.name}…`;
      try {
        const rows = await this.#parseDialogueFile(file);
        const imported = await this.app.database.importDialogues(rows, {
          onProgress: (done, total) => {
            output.textContent = `Importing ${done}/${total}…`;
          },
        });
        output.textContent = `Imported ${imported} rows from ${file.name}.`;
        await this.renderDatabase();
      } catch (error) {
        output.textContent = `Import failed: ${error?.message ?? error}`;
      } finally {
        fileInput.value = '';
      }
    });

    document.getElementById('btn-db-export').addEventListener('click', async () => {
      const rows = await this.app.database.exportDialogues({ limit: 2000 });
      const jsonl = rows.map((row) => JSON.stringify(row)).join('\n');
      output.textContent = `First ${rows.length} rows as JSONL:\n\n${jsonl.slice(0, 4000)}${
        jsonl.length > 4000 ? '\n…truncated…' : ''
      }`;
    });
  }

  /** Accepts .json ({dialogues:[…]} or […]), .jsonl and simple .csv. */
  async #parseDialogueFile(file) {
    const text = await file.text();
    const name = file.name.toLowerCase();

    if (name.endsWith('.jsonl')) {
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
    if (name.endsWith('.json')) {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : parsed.dialogues ?? [];
    }

    const [header, ...lines] = text.split('\n').filter((line) => line.trim());
    const columns = header.split(',').map((column) => column.trim());
    return lines.map((line) => {
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [];
      const row = {};
      columns.forEach((column, index) => {
        const raw = (cells[index] ?? '').replace(/,$/, '').trim();
        row[column] = raw.replace(/^"|"$/g, '').replace(/""/g, '"');
      });
      return row;
    });
  }

  async renderDatabase() {
    const info = await this.app.database.getDiagnostics();
    const stats = this.app.dialogue.getStats();
    document.getElementById('database-diagnostics').textContent = [
      `engine:      ${info.engine}`,
      `mode:        ${info.mode}`,
      `FTS5:        ${info.fts5 ? 'enabled' : 'NOT available — indexed LIKE fallback in use'}`,
      `rows:        ${info.total}`,
      `by language: ${info.byLanguage.map((row) => `${row.language}=${row.total}`).join('  ') || '—'}`,
      `search cap:  ${info.searchLimit} rows per query`,
      '',
      `queries:     ${stats.queries}   answered: ${stats.answered}   fallbacks: ${stats.fallbacks}`,
      `avg latency: ${stats.averageMs} ms`,
      `context:     ${stats.memoryTurns}/${stats.memoryLimit} turns`,
      info.error ? `\nlast error:  ${info.error}` : '',
    ].join('\n');
  }

  /* ------------------------------ Tests ---------------------------- */

  #bindTestControls() {
    const output = document.getElementById('tests-output');
    const write = (text) => {
      output.textContent = `${text}\n\n${output.textContent}`.slice(0, 6000);
    };

    document.getElementById('btn-test-voice').addEventListener('click', async () => {
      const result = await this.diagnostics.testVoice();
      write(`${result.ok ? '✓' : '✗'} voice — ${result.message}`);
    });

    document.getElementById('btn-test-tts').addEventListener('click', async () => {
      const result = await this.diagnostics.testTts(
        `${this.app.name} text to speech test. All systems nominal.`,
      );
      write(`${result.ok ? '✓' : '✗'} tts — ${result.message}`);
    });

    document.getElementById('btn-test-state').addEventListener('click', async () => {
      for (const state of ['LISTENING', 'PROCESSING', 'SPEAKING', 'IDLE']) {
        await this.app.states.transition(state, { force: true });
        write(`state → ${state} (${this.app.animations.getCurrent()?.file ?? 'canvas fallback'})`);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    });
  }

  #populateSettings() {
    const language = document.getElementById('setting-language');
    language.innerHTML = LANGUAGE_CONFIG.supported
      .map((code) => `<option value="${code}">${code}</option>`)
      .join('');
    language.value = this.settings.get('language');
    language.addEventListener('change', () => {
      const value = language.value;
      this.settings.set('language', value);
      this.app.setLanguage(value);
    });

    const rate = document.getElementById('setting-rate');
    const rateValue = document.getElementById('setting-rate-value');
    rate.value = this.settings.get('ttsRate');
    rateValue.value = rate.value;
    rate.addEventListener('input', () => {
      rateValue.value = rate.value;
      this.settings.set('ttsRate', Number(rate.value));
      this.app.tts.setRate(Number(rate.value));
    });

    const ttsToggle = document.getElementById('setting-tts');
    ttsToggle.checked = this.settings.get('ttsEnabled');
    ttsToggle.addEventListener('change', () => {
      this.settings.set('ttsEnabled', ttsToggle.checked);
    });

    const seedToggle = document.getElementById('setting-seed');
    seedToggle.checked = this.settings.get('seedExternalVideos');
    seedToggle.addEventListener('change', () => {
      this.settings.set('seedExternalVideos', seedToggle.checked);
    });
  }

  renderLogs() {
    const entries = this.log.toArray().slice(-200).reverse();
    document.getElementById('logs-output').textContent = entries
      .map((entry) => {
        const time = new Date(entry.at).toLocaleTimeString();
        const detail = entry.detail ? ` — ${JSON.stringify(entry.detail)}` : '';
        return `${time} [${entry.level}] [${entry.scope}] ${entry.message}${detail}`;
      })
      .join('\n');
  }
}

export default AdminPanel;
