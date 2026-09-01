import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Field-level encryption for the borrower secrets held in `applications`
 * (SSN, driver's licence, routing and account numbers).
 *
 * Wire format is `IV(16 bytes) || AES-256-CBC ciphertext`, stored in a BYTEA
 * column. That format predates this service and there are live rows in it, so
 * it is preserved exactly rather than "upgraded" — a format change here would
 * silently orphan every application already on file.
 *
 * Previously this logic lived as four private methods on ApplicationsService
 * and again, in an incompatible AES-GCM variant, in common/encryption.util.ts.
 * One implementation, one place: encryption that disagrees with itself is
 * indistinguishable from data loss.
 */
@Injectable()
export class FieldCryptoService {
  private readonly logger = new Logger(FieldCryptoService.name);

  private static readonly ALGORITHM = 'aes-256-cbc';
  private static readonly IV_LENGTH = 16;
  private static readonly KEY_LENGTH = 32;

  /** Dev-only fallback; production refuses to start without a real key. */
  private static readonly DEV_KEY = 'default_secret_key_32_bytes_long!!';

  private readonly key: Buffer;

  constructor() {
    this.key = this.resolveKey();
  }

  private resolveKey(): Buffer {
    const configured = process.env.ENCRYPTION_KEY;

    if (!configured) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('ENCRYPTION_KEY is missing in production environment');
      }

      this.logger.warn(
        'ENCRYPTION_KEY is not set — falling back to the development key. ' +
          'Data encrypted with it is NOT secure.',
      );

      return this.normalizeKey(FieldCryptoService.DEV_KEY);
    }

    return this.normalizeKey(configured);
  }

  /**
   * AES-256 needs exactly 32 bytes. The historical implementation padded with
   * spaces and truncated, so that behaviour is kept for anything that is not
   * already a 64-char hex key — otherwise existing ciphertext stops decrypting.
   */
  private normalizeKey(raw: string): Buffer {
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      return Buffer.from(raw, 'hex');
    }

    return Buffer.from(
      raw
        .padEnd(FieldCryptoService.KEY_LENGTH, ' ')
        .slice(0, FieldCryptoService.KEY_LENGTH),
      'utf8',
    );
  }

  encrypt(plaintext: string): Buffer {
    const iv = crypto.randomBytes(FieldCryptoService.IV_LENGTH);
    const cipher = crypto.createCipheriv(
      FieldCryptoService.ALGORITHM,
      this.key,
      iv,
    );

    return Buffer.concat([
      iv,
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
  }

  encryptOptional(plaintext?: string | null): Buffer | null {
    return plaintext ? this.encrypt(plaintext) : null;
  }

  decrypt(payload: Buffer): string {
    if (!payload || payload.length <= FieldCryptoService.IV_LENGTH) {
      throw new Error('Invalid encrypted payload');
    }

    const iv = payload.subarray(0, FieldCryptoService.IV_LENGTH);
    const ciphertext = payload.subarray(FieldCryptoService.IV_LENGTH);
    const decipher = crypto.createDecipheriv(
      FieldCryptoService.ALGORITHM,
      this.key,
      iv,
    );

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }

  /**
   * Decrypt without throwing.
   *
   * Used on read paths that render many rows: one row encrypted under a rotated
   * or mistyped key must not blank the whole admin screen. Returns null and
   * logs instead.
   */
  tryDecrypt(payload?: Buffer | null): string | null {
    if (!payload) return null;

    try {
      return this.decrypt(payload);
    } catch (error) {
      this.logger.error(
        'Failed to decrypt an encrypted field',
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  /** Deterministic SSN fingerprint used for duplicate and cooldown lookups. */
  hash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }
}
