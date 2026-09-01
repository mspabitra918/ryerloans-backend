import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Object storage for borrower documents.
 *
 * Two drivers behind one interface:
 *
 *  - `supabase` — Supabase Storage over its REST API. This is the production
 *    driver: the backend runs on Vercel, where the filesystem is per-invocation
 *    scratch space and anything written to it is gone before the underwriter
 *    opens the file.
 *  - `local` — a directory on disk, used only when Supabase is not configured
 *    so the flow is runnable against a laptop without credentials.
 *
 * The driver is chosen from the environment rather than injected, because the
 * choice is deployment configuration, not a runtime decision: a request must
 * never be able to pick where a borrower's ID lands.
 *
 * Nothing here talks to the database. Keys are opaque strings the caller
 * generates and stores in `documents.s3_key`.
 */

export type StorageDriver = 'supabase' | 'local';

/** Default bucket name; must be a *private* bucket. */
const DEFAULT_BUCKET = 'loan-documents';

const DEFAULT_LOCAL_DIR = '.storage/documents';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  private readonly supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(
    /\/$/,
    '',
  );
  private readonly supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY ?? '';
  private readonly bucket = process.env.SUPABASE_DOCS_BUCKET ?? DEFAULT_BUCKET;
  private readonly localDir = path.resolve(
    process.env.STORAGE_LOCAL_DIR ?? DEFAULT_LOCAL_DIR,
  );

  /** Resolved once: the driver cannot change while the process is alive. */
  readonly driver: StorageDriver;

  /** Guards the best-effort bucket bootstrap so it runs at most once. */
  private bucketReady: Promise<void> | null = null;

  constructor() {
    const requested = process.env.STORAGE_DRIVER as StorageDriver | undefined;
    const supabaseConfigured = Boolean(this.supabaseUrl && this.supabaseKey);

    if (requested === 'local') {
      this.driver = 'local';
    } else if (requested === 'supabase' || supabaseConfigured) {
      this.driver = 'supabase';
    } else {
      this.driver = 'local';
    }

    if (this.driver === 'supabase' && !supabaseConfigured) {
      /*
       * Fail loudly at boot rather than at the first upload. A borrower who
       * has already picked a file off their phone should not be the one to
       * discover the bucket credentials are missing.
       */
      this.logger.error(
        'STORAGE_DRIVER=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — uploads will fail',
      );
    }

    if (this.driver === 'local') {
      this.logger.warn(
        `Document storage is using the local-disk driver (${this.localDir}). ` +
          'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before deploying — ' +
          'a serverless filesystem does not survive between requests.',
      );
    }
  }

  /* --------------------------------------------------------------- public */

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.driver === 'supabase'
      ? this.supabasePut(key, body, contentType)
      : this.localPut(key, body);
  }

  /**
   * The raw bytes. Callers already hold the document row, so the content type
   * comes from `documents.mime_type` rather than from storage — one source of
   * truth, and the one that was validated on the way in.
   */
  async get(key: string): Promise<Buffer> {
    return this.driver === 'supabase'
      ? this.supabaseGet(key)
      : this.localGet(key);
  }

  /**
   * Removal is best-effort by design. The document row is the record of what
   * exists; an object that outlives its row is billing waste, but a row that
   * outlives its object is a download button that 500s.
   */
  async remove(key: string): Promise<void> {
    try {
      if (this.driver === 'supabase') await this.supabaseRemove(key);
      else await this.localRemove(key);
    } catch (error) {
      this.logger.warn(
        `Could not delete stored object ${key}: ${(error as Error).message}`,
      );
    }
  }

  /* ------------------------------------------------------------- supabase */

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.supabaseKey}`,
      apikey: this.supabaseKey,
    };
  }

  /**
   * Creates the bucket if it is missing, once per process and best-effort.
   *
   * Private, and with the same size ceiling the API enforces — a bucket left
   * public by accident is the whole confidentiality story of this feature
   * going out at once.
   */
  private async ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      try {
        const response = await fetch(
          `${this.supabaseUrl}/storage/v1/bucket/${this.bucket}`,
          { headers: this.authHeaders() },
        );

        if (response.ok) return;

        const created = await fetch(`${this.supabaseUrl}/storage/v1/bucket`, {
          method: 'POST',
          headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: this.bucket,
            name: this.bucket,
            public: false,
          }),
        });

        if (!created.ok) {
          this.logger.warn(
            `Could not create Supabase bucket "${this.bucket}" ` +
              `(${created.status}). Create it manually as a PRIVATE bucket.`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Bucket check for "${this.bucket}" failed: ${(error as Error).message}`,
        );
      }
    })();

    return this.bucketReady;
  }

  private async supabasePut(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.ensureBucket();

    const response = await fetch(
      `${this.supabaseUrl}/storage/v1/object/${this.bucket}/${encodeKey(key)}`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': contentType,
          // Keys carry a fresh UUID, so a collision means something is wrong.
          // Overwriting silently would destroy the earlier upload.
          'x-upsert': 'false',
          'cache-control': 'private, max-age=0, no-store',
        },
        body: new Uint8Array(body),
      },
    );

    if (!response.ok) {
      const detail = await safeText(response);
      this.logger.error(
        `Supabase upload failed for ${key}: ${response.status} ${detail}`,
      );
      throw new InternalServerErrorException(
        'We could not save that file. Please try again.',
      );
    }
  }

  private async supabaseGet(key: string): Promise<Buffer> {
    const response = await fetch(
      `${this.supabaseUrl}/storage/v1/object/${this.bucket}/${encodeKey(key)}`,
      { headers: this.authHeaders() },
    );

    if (response.status === 404) {
      throw new NotFoundException('Document not found');
    }

    if (!response.ok) {
      this.logger.error(
        `Supabase download failed for ${key}: ${response.status} ${await safeText(response)}`,
      );
      throw new InternalServerErrorException('Could not read that document');
    }

    return Buffer.from(await response.arrayBuffer());
  }

  private async supabaseRemove(key: string): Promise<void> {
    const response = await fetch(
      `${this.supabaseUrl}/storage/v1/object/${this.bucket}/${encodeKey(key)}`,
      { method: 'DELETE', headers: this.authHeaders() },
    );

    if (!response.ok && response.status !== 404) {
      throw new Error(`${response.status} ${await safeText(response)}`);
    }
  }

  /* ---------------------------------------------------------------- local */

  /**
   * Keys are generated server-side from a UUID, but this still resolves and
   * re-checks the path: "the caller is trusted" is exactly the assumption path
   * traversal bugs are built on.
   */
  private localPath(key: string): string {
    const resolved = path.resolve(this.localDir, key);

    if (
      resolved !== this.localDir &&
      !resolved.startsWith(this.localDir + path.sep)
    ) {
      throw new InternalServerErrorException('Invalid storage key');
    }

    return resolved;
  }

  private async localPut(key: string, body: Buffer): Promise<void> {
    const target = this.localPath(key);

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, { mode: 0o600 });
  }

  private async localGet(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.localPath(key));
    } catch {
      throw new NotFoundException('Document not found');
    }
  }

  private async localRemove(key: string): Promise<void> {
    await fs.rm(this.localPath(key), { force: true });
  }
}

/** Percent-encode each path segment but keep the slashes that structure the key. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
