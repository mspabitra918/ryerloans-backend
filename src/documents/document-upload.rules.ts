/**
 * What a borrower is allowed to upload, and how we decide.
 *
 * The checks here are deliberately about *shape*, not content: a paystub and a
 * bank statement are the same PDF as far as this file is concerned. Content is
 * the underwriter's problem; ours is that the thing landing in the bucket is
 * the kind of file it claims to be and small enough to survive the request.
 */

/** The one multipart field name the upload endpoint reads. */
export const UPLOAD_FIELD_NAME = 'file';

/**
 * Maximum upload size.
 *
 * The default is 4 MB rather than a round 10: this API is served through a
 * Vercel function, and Vercel caps a request body at 4.5 MB. Accepting a
 * larger file here would mean the platform rejects the request before Nest
 * ever sees it, and the borrower gets an opaque 413 from an edge node instead
 * of a sentence explaining what to do.
 *
 * Raise DOCUMENT_MAX_UPLOAD_MB only alongside a host that can carry it, or
 * move to direct-to-bucket uploads with a signed upload URL.
 */
export function maxUploadBytes(): number {
  const configured = Number(process.env.DOCUMENT_MAX_UPLOAD_MB);
  const megabytes =
    Number.isFinite(configured) && configured > 0 ? configured : 4;

  return Math.floor(megabytes * 1024 * 1024);
}

/** Ceiling on how many files one document request may accumulate. */
export const MAX_FILES_PER_REQUEST = 20;

/**
 * Accepted types, keyed by the MIME the browser sends.
 *
 * Everything a borrower can realistically produce from a phone or a bank's
 * website: a PDF statement, a photo of an ID, a screenshot. Office documents
 * are absent on purpose — a macro-bearing .docx is not something to hand an
 * underwriter, and no lender needs one to verify income.
 */
export const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number];

/** Extension used for the storage key, by MIME. Never the borrower's own. */
const EXTENSIONS: Record<AcceptedMimeType, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

export function extensionFor(mime: string): string {
  return EXTENSIONS[mime as AcceptedMimeType] ?? '.bin';
}

/** Human-readable list for the borrower-facing error message. */
export const ACCEPTED_LABEL = 'PDF, JPG, PNG, WEBP or HEIC';

/**
 * Identify a buffer from its leading bytes.
 *
 * `Content-Type` on a multipart part is whatever the client typed — a renamed
 * executable arrives labelled `image/png` and looks fine to any check that
 * trusts the header. Sniffing is not a virus scan and does not pretend to be
 * one; it is the difference between storing the file the borrower picked and
 * storing whatever a script decided to send.
 *
 * Returns null when the bytes match nothing we accept.
 */
export function sniffMimeType(buffer: Buffer): AcceptedMimeType | null {
  if (buffer.length < 12) return null;

  // %PDF
  if (buffer.subarray(0, 4).toString('latin1') === '%PDF') {
    return 'application/pdf';
  }

  // JPEG: SOI marker.
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: the 8-byte signature, including the CRLF/EOF trap bytes.
  if (
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return 'image/png';
  }

  // RIFF container; bytes 8..12 name the form type.
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  /*
   * ISO base-media (HEIC/HEIF): a `ftyp` box at offset 4, then a brand. Both
   * iPhone stills and their multi-image variants are covered — a borrower
   * photographing an ID has no idea which one their phone produced.
   */
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');

    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) {
      return 'image/heic';
    }

    if (['mif1', 'msf1', 'mif2'].includes(brand)) {
      return 'image/heif';
    }
  }

  return null;
}

/**
 * True when a sniffed type is close enough to the declared one.
 *
 * HEIC and HEIF share a container and browsers disagree about which label to
 * send, so they are treated as one family. Everything else must match exactly.
 */
export function typesAgree(declared: string, sniffed: AcceptedMimeType) {
  if (declared === sniffed) return true;

  const heif = ['image/heic', 'image/heif'];

  return heif.includes(declared) && heif.includes(sniffed);
}

/**
 * A filename safe to store and to echo back into a page.
 *
 * Only the basename survives, control characters are stripped, and the result
 * is capped to the column width. The stored name is display metadata — it
 * never becomes part of a storage key or a filesystem path.
 */
export function sanitizeFilename(raw: string): string {
  const base = (raw ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return base.slice(0, 200) || 'upload';
}
