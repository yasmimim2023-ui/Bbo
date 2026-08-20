/**
 * IRONBOX 1.0 — VideoStorageAdapter (Android storage adapter).
 *
 * This is the ONLY module that knows about Android filesystem paths, the
 * Capacitor Filesystem plugin or `convertFileSrc`. VideoManager and
 * AnimationManager talk to this adapter, never to the platform.
 *
 * Storage location (Android)
 * --------------------------
 *   Directory.External  →  /storage/emulated/0/Android/data/
 *                          com.ironbox.virtualassistant/files/
 *
 * IRONBOX therefore owns:
 *
 *   …/files/IRONBOX/videos/            user-replaceable MP4 assets
 *   …/files/IRONBOX/animation-manifest.json
 *   …/files/IRONBOX/ironbox-config.json
 *   …/files/IRONBOX/characters/<pack>/ optional character packs
 *
 * This is *app-specific* external storage: no runtime permission is required,
 * it survives app updates, and it is removed when the app is uninstalled.
 * Visibility from a desktop file manager over USB/MTP is normal; visibility
 * from a third-party Android file manager depends on the Android version
 * (Android 11+ restricts browsing of Android/data). The in-app "Import
 * Videos" picker exists precisely for that case.
 */

import { ASSISTANT_CONFIG, VIDEO_CONFIG } from './config.js';
import {
  blobToBase64,
  convertFileSrc,
  getPlugin,
  isNativePlatform,
  logger,
} from './utils.js';

const CHUNK_BYTES = 3 * 1024 * 1024;

export class VideoStorageAdapter {
  constructor({ config = VIDEO_CONFIG, log = logger } = {}) {
    this.config = config;
    this.log = log;
    this.filesystem = null;
    this.native = false;
    this.ready = false;
    this.directory = 'EXTERNAL';
    this.rootPath = config.rootDirName;
    this.videosPath = `${config.rootDirName}/${config.videosDirName}`;
    this.charactersPath = `${config.rootDirName}/${config.charactersDirName}`;
    this.rootUri = null;
    this.videosUri = null;
    this.lastError = null;
    /** Browser-only fallback so video replacement is demoable without Android. */
    this.memoryVideos = new Map();
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  async initialize() {
    this.native = isNativePlatform();
    this.filesystem = getPlugin('Filesystem');

    if (!this.native || !this.filesystem) {
      this.ready = false;
      this.log.warn(
        'storage',
        this.native
          ? 'Filesystem plugin unavailable; external videos disabled'
          : 'Running in a browser; packaged videos only',
      );
      return this.describe();
    }

    try {
      await this.#ensureDirectory(this.rootPath);
      await this.#ensureDirectory(this.videosPath);
      await this.#ensureDirectory(this.charactersPath);
      this.rootUri = await this.#uriOf(this.rootPath);
      this.videosUri = await this.#uriOf(this.videosPath);
      this.ready = true;
      this.lastError = null;
      this.log.info('storage', `External video directory ready: ${this.videosUri}`);
    } catch (error) {
      this.ready = false;
      this.lastError = error?.message ?? String(error);
      this.log.error('storage', 'Could not prepare external directory', this.lastError);
    }

    return this.describe();
  }

  async reload() {
    // Browser-mode imports are deliberately kept: reloading the registry must
    // not throw away videos the user just imported. On a device this map is
    // unused — the files live on disk and survive regardless.
    return this.initialize();
  }

  describe() {
    return {
      native: this.native,
      ready: this.ready,
      directory: this.directory,
      rootPath: this.rootPath,
      videosPath: this.videosPath,
      rootUri: this.rootUri,
      videosUri: this.videosUri,
      error: this.lastError,
    };
  }

  getExternalVideoDirectory() {
    return {
      available: this.ready,
      directory: this.directory,
      path: this.videosPath,
      uri: this.videosUri,
      /** Human-readable location for the README/admin panel. */
      hint: this.ready
        ? this.videosUri
        : `Android/data/${ASSISTANT_CONFIG.packageId}/files/${this.videosPath}`,
    };
  }

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  /** @returns {Promise<Array<{name,size,uri,mtime,source}>>} */
  async listVideos(subPath = this.videosPath) {
    if (!this.ready) {
      return [...this.memoryVideos.entries()].map(([name, entry]) => ({
        name,
        size: entry.size,
        uri: entry.url,
        mtime: entry.mtime,
        source: 'memory',
      }));
    }

    try {
      const result = await this.filesystem.readdir({
        path: subPath,
        directory: this.directory,
      });
      return (result.files ?? [])
        .filter((file) => (file.type ?? 'file') === 'file')
        .filter((file) => this.#hasAllowedExtension(file.name))
        .map((file) => ({
          name: file.name,
          size: file.size ?? 0,
          uri: file.uri,
          mtime: file.mtime ?? 0,
          source: 'external',
        }));
    } catch (error) {
      this.log.warn('storage', `readdir failed for ${subPath}`, error?.message);
      return [];
    }
  }

  /** Character packs found under IRONBOX/characters/. */
  async listCharacterPacks() {
    if (!this.ready) return [];
    try {
      const result = await this.filesystem.readdir({
        path: this.charactersPath,
        directory: this.directory,
      });
      return (result.files ?? [])
        .filter((file) => file.type === 'directory')
        .map((file) => file.name);
    } catch {
      return [];
    }
  }

  async videoExists(filename, subPath = this.videosPath) {
    if (!this.ready) return this.memoryVideos.has(filename);
    try {
      await this.filesystem.stat({
        path: `${subPath}/${filename}`,
        directory: this.directory,
      });
      return true;
    } catch {
      return false;
    }
  }

  async statVideo(filename, subPath = this.videosPath) {
    if (!this.ready) {
      const entry = this.memoryVideos.get(filename);
      return entry ? { size: entry.size, mtime: entry.mtime } : null;
    }
    try {
      const stat = await this.filesystem.stat({
        path: `${subPath}/${filename}`,
        directory: this.directory,
      });
      return { size: stat.size ?? 0, mtime: stat.mtime ?? 0, uri: stat.uri };
    } catch {
      return null;
    }
  }

  /**
   * Playable URL for an external video. Returns null when the external layer
   * is unavailable — callers then fall back to packaged assets.
   */
  getVideoPath(filename, subPath = this.videosPath) {
    if (!this.ready) {
      const entry = this.memoryVideos.get(filename);
      return entry ? entry.url : null;
    }
    if (!this.rootUri) return null;
    // Every managed path lives under rootPath, so the URI is rootUri + remainder.
    const relative = subPath.startsWith(`${this.rootPath}/`)
      ? subPath.slice(this.rootPath.length + 1)
      : '';
    const base = relative ? `${this.rootUri}/${relative}` : this.rootUri;
    return convertFileSrc(`${base}/${filename}`);
  }

  /* ---------------------------------------------------------------- *
   * Manifest & config overrides
   * ---------------------------------------------------------------- */

  async loadManifest() {
    return this.#readJson(`${this.rootPath}/${this.config.manifestFileName}`);
  }

  async saveManifest(manifest) {
    return this.#writeJson(
      `${this.rootPath}/${this.config.manifestFileName}`,
      manifest,
    );
  }

  async loadConfigOverrides() {
    return this.#readJson(`${this.rootPath}/${this.config.configFileName}`);
  }

  /* ---------------------------------------------------------------- *
   * Writing / importing
   * ---------------------------------------------------------------- */

  /**
   * Copy a picked File/Blob into the external videos directory in bounded
   * chunks, so importing a 200 MB video never materialises 260 MB of base64.
   */
  async importVideo(file, targetName = file.name) {
    const name = this.#sanitizeName(targetName);
    if (!this.#hasAllowedExtension(name)) {
      throw new Error(`Unsupported extension: ${name}`);
    }

    if (!this.ready) {
      const url = URL.createObjectURL(file);
      const previous = this.memoryVideos.get(name);
      if (previous) URL.revokeObjectURL(previous.url);
      this.memoryVideos.set(name, { url, size: file.size, mtime: Date.now() });
      this.log.info('storage', `Imported ${name} into memory (browser mode)`);
      return { name, bytes: file.size, source: 'memory' };
    }

    const path = `${this.videosPath}/${name}`;
    let offset = 0;
    let first = true;

    while (offset < file.size) {
      const slice = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size));
      const data = await blobToBase64(slice);
      if (first) {
        await this.filesystem.writeFile({
          path,
          directory: this.directory,
          data,
          recursive: true,
        });
        first = false;
      } else {
        await this.filesystem.appendFile({ path, directory: this.directory, data });
      }
      offset += CHUNK_BYTES;
    }

    if (first) {
      // Zero-byte input: still create the file so validation reports it.
      await this.filesystem.writeFile({
        path,
        directory: this.directory,
        data: '',
        recursive: true,
      });
    }

    this.log.info('storage', `Imported ${name} (${file.size} bytes)`);
    return { name, bytes: file.size, source: 'external' };
  }

  /**
   * Copy packaged defaults into the external directory on first run, so the
   * user immediately has files to replace. Existing files are never
   * overwritten — a user's customised video always wins.
   */
  async seedFromPackaged(filenames = []) {
    if (!this.ready || filenames.length === 0) return { copied: 0, skipped: 0 };
    let copied = 0;
    let skipped = 0;

    for (const filename of filenames) {
      if (await this.videoExists(filename)) {
        skipped += 1;
        continue;
      }
      try {
        const response = await fetch(
          `${this.config.packagedVideosPath}/${filename}`,
        );
        if (!response.ok) {
          skipped += 1;
          continue;
        }
        const blob = await response.blob();
        await this.importVideo(blob, filename);
        copied += 1;
      } catch (error) {
        skipped += 1;
        this.log.warn('storage', `Could not seed ${filename}`, error?.message);
      }
    }

    this.log.info('storage', `Seeded external videos: ${copied} copied, ${skipped} kept`);
    return { copied, skipped };
  }

  async deleteVideo(filename) {
    const name = this.#sanitizeName(filename);
    if (!this.ready) {
      const entry = this.memoryVideos.get(name);
      if (entry) URL.revokeObjectURL(entry.url);
      return this.memoryVideos.delete(name);
    }
    try {
      await this.filesystem.deleteFile({
        path: `${this.videosPath}/${name}`,
        directory: this.directory,
      });
      return true;
    } catch (error) {
      this.log.warn('storage', `Could not delete ${name}`, error?.message);
      return false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  async #ensureDirectory(path) {
    try {
      await this.filesystem.mkdir({
        path,
        directory: this.directory,
        recursive: true,
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      // mkdir throws when the directory already exists; that is success.
      if (!/exist/i.test(message)) throw error;
    }
  }

  async #uriOf(path) {
    const result = await this.filesystem.getUri({
      path,
      directory: this.directory,
    });
    return result.uri;
  }

  async #readJson(path) {
    if (!this.ready) return null;
    try {
      const result = await this.filesystem.readFile({
        path,
        directory: this.directory,
        encoding: 'utf8',
      });
      const text = typeof result.data === 'string' ? result.data : '';
      return text ? JSON.parse(text) : null;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not exist|not found|ENOENT/i.test(message)) {
        this.log.warn('storage', `Could not read ${path}`, message);
      }
      return null;
    }
  }

  async #writeJson(path, value) {
    if (!this.ready) return false;
    try {
      await this.filesystem.writeFile({
        path,
        directory: this.directory,
        data: JSON.stringify(value, null, 2),
        encoding: 'utf8',
        recursive: true,
      });
      return true;
    } catch (error) {
      this.log.error('storage', `Could not write ${path}`, error?.message);
      return false;
    }
  }

  #hasAllowedExtension(name) {
    const lower = String(name).toLowerCase();
    return this.config.allowedExtensions.some((ext) => lower.endsWith(ext));
  }

  #sanitizeName(name) {
    return String(name).replace(/[\\/]/g, '_').replace(/\.\./g, '_').trim();
  }
}

export default VideoStorageAdapter;
