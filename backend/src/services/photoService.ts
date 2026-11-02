/**
 * Plate photos served by the backend (PHOTO_CACHE_DIR), for the public site.
 *
 * Presigned storage links change on every request and last 10 minutes, so a
 * browser can never reuse a photo it already downloaded, and the raw camera
 * photo is ~3.5 MB. Here each image object gets stable URLs:
 *
 *   /api/photos/<objectId>.thumb.jpg     ≤ 480 px, for gallery tiles
 *   /api/photos/<objectId>.display.jpg   ≤ 1600 px, for the plate view
 *   /api/photos/<objectId>.full.png      PNG masks and other non-JPEG images, as stored
 *
 * The bytes are read once from object storage (the same finalized-object
 * check as presigned links), resized with sharp, kept on disk, and answered
 * with year-long `immutable` caching: an object id never changes content.
 * Only image objects that would get a presigned link are served.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { notFound } from '../errors.js';
import type { Repository } from '../repo/repository.js';
import type { ImageService } from './imageService.js';
import type { SignedImage } from '../types.js';

export type PhotoVariant = 'thumb' | 'display' | 'full';

const OBJECT_ID = /^img_[A-Za-z0-9_-]{6,80}$/;
const FILE = /^(img_[A-Za-z0-9_-]{6,80})\.(thumb|display|full)\.(jpg|png|webp)$/;
const MAX_EDGE: Record<Exclude<PhotoVariant, 'full'>, number> = { thumb: 480, display: 1600 };
/** Far enough that the gallery never "renews" a photo link. */
const LINK_LIFETIME_MS = 365 * 24 * 3600 * 1000;
const EXT: Record<string, 'jpg' | 'png' | 'webp'> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MIME: Record<'jpg' | 'png' | 'webp', string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export interface PhotoFile {
  bytes: Buffer;
  mimeType: string;
}

export class PhotoService {
  private readonly inFlight = new Map<string, Promise<PhotoFile>>();

  constructor(
    private readonly repo: Repository,
    private readonly images: ImageService,
    private readonly cacheDir: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Stable links for an image object, or null when it is missing/unfinalized
   * (the same cases a presigned link is refused). JPEGs get a resized display
   * copy and a thumbnail; other types are served as stored.
   */
  async link(objectId: string): Promise<SignedImage | null> {
    if (!OBJECT_ID.test(objectId)) return null;
    const record = await this.repo.getImageObject(objectId);
    if (!record || record.state !== 'finalized') return null;
    const ext = EXT[record.mimeType];
    if (!ext) return null;
    const base = `/api/photos/${objectId}`;
    const expiresAt = new Date(this.now() + LINK_LIFETIME_MS).toISOString();
    if (ext !== 'jpg') return { objectId, url: `${base}.full.${ext}`, thumbUrl: `${base}.full.${ext}`, expiresAt };
    return { objectId, url: `${base}.display.jpg`, thumbUrl: `${base}.thumb.jpg`, expiresAt };
  }

  /** Bytes for `/api/photos/:file`; 404 for any name this service would not hand out. */
  async file(name: string): Promise<PhotoFile> {
    const m = FILE.exec(name);
    if (!m) throw notFound('PHOTO_NOT_FOUND', 'No photo has this name.');
    const [, objectId, variant, ext] = m as unknown as [string, string, PhotoVariant, 'jpg' | 'png' | 'webp'];
    const record = await this.repo.getImageObject(objectId);
    const stored = record ? EXT[record.mimeType] : undefined;
    // Resized copies exist only for JPEGs; everything else is served whole, under its own extension.
    const valid = stored === ext && (ext === 'jpg' ? true : variant === 'full');
    if (!record || record.state !== 'finalized' || !valid) throw notFound('PHOTO_NOT_FOUND', 'No photo has this name.');
    const key = `${objectId}.${variant}.${ext}`;
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.load(objectId, variant, ext, key).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private async load(objectId: string, variant: PhotoVariant, ext: 'jpg' | 'png' | 'webp', key: string): Promise<PhotoFile> {
    const path = join(this.cacheDir, key);
    const mimeType = MIME[ext];
    try {
      return { bytes: await readFile(path), mimeType };
    } catch {
      // Not cached yet.
    }
    const original = await this.images.readImageBytes(objectId);
    const bytes =
      variant === 'full'
        ? original.bytes
        : await sharp(original.bytes)
            .rotate() // bake in EXIF orientation, as browsers showed the original
            .resize({ width: MAX_EDGE[variant], height: MAX_EDGE[variant], fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: variant === 'thumb' ? 72 : 82, mozjpeg: true })
            .toBuffer();
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    } catch {
      // A read-only or full disk still serves the photo, just without keeping it.
    }
    return { bytes, mimeType };
  }
}
