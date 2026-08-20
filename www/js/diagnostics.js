/**
 * IRONBOX 1.0 — diagnostics.
 *
 * Collects the truth about every subsystem so the admin panel can show what is
 * actually happening — in particular whether the running APK is using external
 * videos or the packaged fallbacks.
 */

import { ASSISTANT_CONFIG, LANGUAGE_CONFIG } from './config.js';
import { getPlatform, isNativePlatform, logger } from './utils.js';

export class Diagnostics {
  constructor({ app, log = logger } = {}) {
    this.app = app;
    this.log = log;
  }

  async collect() {
    const { videos, database, speech, tts, states, animations, dialogue, storage } = this.app;

    const [databaseInfo] = await Promise.all([database.getDiagnostics()]);
    const videoInfo = videos.getDiagnostics();
    const current = animations.getCurrent();

    return {
      assistant: {
        name: ASSISTANT_CONFIG.name,
        version: ASSISTANT_CONFIG.version,
        packageId: ASSISTANT_CONFIG.packageId,
        platform: getPlatform(),
        native: isNativePlatform(),
        language: dialogue.language,
        supportedLanguages: LANGUAGE_CONFIG.supported,
      },
      storage: storage.describe(),
      video: {
        ...videoInfo,
        currentAnimation: current?.category ?? null,
        currentRequested: current?.requested ?? null,
        currentVideo: current?.file ?? null,
        currentSource: current?.source ?? null,
      },
      database: databaseInfo,
      dialogue: dialogue.getStats(),
      speech: speech.getStatus(),
      tts: tts.getStatus(),
      state: states.getStatus(),
    };
  }

  /** Compact text block, the shape asked for in the spec's §38. */
  async render() {
    const report = await this.collect();
    const video = report.video;
    const lines = [
      `${report.assistant.name} ${report.assistant.version} — ${report.assistant.platform}`,
      '',
      'VIDEO',
      `  Video Directory:        ${video.directory.hint}`,
      `  External Override:      ${video.externalOverride ? 'ENABLED' : 'DISABLED (no app-specific external storage here)'}`,
      `  External Files Found:   ${video.externalFilesFound}`,
      `  External Manifest:      ${video.externalManifest ? 'YES' : 'no'}`,
      `  Videos Registered:      ${video.videosFound}`,
      `    external storage:     ${video.bySource.external}`,
      `    imported this session: ${video.bySource.memory}`,
      `    packaged (APK):       ${video.bySource.packaged}`,
      `    missing:              ${video.bySource.missing}`,
      `  Validated Valid:        ${video.valid}`,
      `  Validated Invalid:      ${video.invalid}`,
      `  Categories:             ${video.manifest.categories}`,
      `  Cached (warm):          ${video.cached}`,
      `  Current Animation:      ${video.currentAnimation ?? '—'}`,
      `  Current Video:          ${video.currentVideo ?? '—'}`,
      `  Source:                 ${this.#sourceLabel(video.currentSource)}`,
      '',
      'DATABASE',
      `  Engine:                 ${report.database.engine}`,
      `  Mode:                   ${report.database.mode}`,
      `  FTS5:                   ${report.database.fts5 ? 'ENABLED' : 'not available (LIKE fallback)'}`,
      `  Rows:                   ${report.database.total}`,
      `  Search limit:           ${report.database.searchLimit} rows per query`,
      '',
      'DIALOGUE',
      `  Queries:                ${report.dialogue.queries}`,
      `  Answered:               ${report.dialogue.answered}`,
      `  Fallbacks:              ${report.dialogue.fallbacks}`,
      `  Average latency:        ${report.dialogue.averageMs} ms`,
      `  Context memory:         ${report.dialogue.memoryTurns}/${report.dialogue.memoryLimit} turns`,
      '',
      'SPEECH',
      `  Recognition:            ${report.speech.available ? 'available' : 'unavailable'}`,
      `  Engine:                 ${report.speech.engine}`,
      `  Offline capable:        ${report.speech.offlineCapable}`,
      `  Permission:             ${report.speech.permission}`,
      '',
      'TTS',
      `  Available:              ${report.tts.available ? 'yes' : 'no'}`,
      `  Engine:                 ${report.tts.engine}`,
      `  Pause strategy:         ${report.tts.pauseStrategy}`,
      '',
      'STATE',
      `  Current:                ${report.state.current}`,
      `  Animation category:     ${report.state.animation}`,
    ];

    if (video.invalidDetails.length > 0) {
      lines.push('', 'INVALID VIDEOS');
      for (const entry of video.invalidDetails.slice(0, 20)) {
        lines.push(`  ${entry.file} [${entry.source}] — ${entry.reason}`);
      }
    }

    return lines.join('\n');
  }

  #sourceLabel(source) {
    switch (source) {
      case 'external':
        return 'External Storage';
      case 'packaged':
        return 'Packaged (APK default)';
      case 'memory':
        return 'Imported in browser session';
      case 'canvas':
        return 'Procedural fallback (no video)';
      default:
        return '—';
    }
  }

  /* ---------------- self-tests used by the admin panel -------------- */

  async testAnimation(category) {
    const resolved = this.app.videos.resolve(category);
    if (!resolved) return { ok: false, message: `No playable asset for "${category}"` };
    await this.app.animations.playAnimation(category, { returnToIdle: true });
    return {
      ok: true,
      message: `Playing ${resolved.file} (${resolved.source})${
        resolved.fallbackUsed ? ` via fallback from "${category}"` : ''
      }`,
    };
  }

  async testDialogue(text) {
    const started = performance.now();
    const response = await this.app.dialogue.respond(text);
    return {
      ok: true,
      elapsedMs: Math.round(performance.now() - started),
      response,
    };
  }

  async testTts(text) {
    if (!this.app.tts.available) return { ok: false, message: 'TTS unavailable on this platform' };
    await this.app.tts.speak(text);
    return { ok: true, message: 'Spoken' };
  }

  async testVoice() {
    const status = this.app.speech.getStatus();
    if (!status.available) return { ok: false, message: 'Speech recognition unavailable' };
    const granted = await this.app.speech.requestPermission();
    return {
      ok: granted,
      message: granted
        ? `Microphone permission granted (${status.engine})`
        : 'Microphone permission denied',
    };
  }

  async validateVideos(onProgress) {
    return this.app.videos.validateAll({ onProgress });
  }
}

export default Diagnostics;
