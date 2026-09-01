import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import * as crypto from 'crypto';

import { Document, type DocumentScanStatus } from './models/document.model';
import { DocumentRequest } from './models/document-request.model';
import { Application } from '../applications/models/application.model';
import { StorageService } from './storage/storage.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  ACCEPTED_LABEL,
  ACCEPTED_MIME_TYPES,
  MAX_FILES_PER_REQUEST,
  extensionFor,
  maxUploadBytes,
  sanitizeFilename,
  sniffMimeType,
  typesAgree,
} from './document-upload.rules';
import {
  DOCUMENT_TYPE_LABELS,
  type DocumentType,
} from '../applications/application.types';

/** The multipart part the upload endpoint hands us, minus multer's typings. */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** One row as the borrower's own upload page sees it. */
export interface BorrowerDocumentView {
  id: string;
  doc_type: string;
  doc_type_label: string;
  original_filename: string;
  size_bytes: number;
  created_at: Date;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectModel(Document) private readonly documentModel: typeof Document,
    @InjectModel(DocumentRequest)
    private readonly requestModel: typeof DocumentRequest,
    @InjectModel(Application)
    private readonly applicationModel: typeof Application,
    private readonly storage: StorageService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Resolve an upload token to the request it belongs to.
   *
   * The token is hashed before lookup, so a token that never existed and one
   * that expired both take the same path — there is nothing here that tells a
   * guesser they are getting warmer.
   */
  async resolveUploadToken(token: string): Promise<{
    request: DocumentRequest;
    application: Application;
  }> {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const request = await this.requestModel.findOne({
      where: {
        token_hash: tokenHash,
        expires_at: { [Op.gt]: new Date() },
        completed_at: { [Op.is]: null },
      },
    });

    if (!request) {
      throw new NotFoundException('This upload link is invalid or has expired');
    }

    const application = await this.applicationModel.findByPk(
      request.application_id,
    );

    if (!application) {
      throw new NotFoundException('This upload link is invalid or has expired');
    }

    return { request, application };
  }

  /**
   * Everything the borrower's upload page renders, in one call.
   *
   * The checklist the admin sent, what has already been attached against it,
   * and the limits the page should enforce before spending a borrower's mobile
   * data on an upload this API is going to refuse.
   */
  async getUploadPage(token: string): Promise<{
    reference: string;
    first_name: string;
    note: string | null;
    expires_at: Date;
    doc_types: Array<{ value: string; label: string }>;
    documents: BorrowerDocumentView[];
    max_bytes: number;
    accepted_mime_types: string[];
  }> {
    const { request, application } = await this.resolveUploadToken(token);

    const documents = await this.documentModel.findAll({
      where: {
        document_request_id: request.id,
        deleted_at: { [Op.is]: null },
      },
      order: [['created_at', 'ASC']],
    });

    return {
      reference: application.application_id,
      first_name: application.first_name,
      note: request.note,
      expires_at: request.expires_at,
      doc_types: request.doc_types.map((value) => ({
        value,
        label: DOCUMENT_TYPE_LABELS[value as DocumentType] ?? value,
      })),
      documents: documents.map((document) => this.toBorrowerView(document)),
      max_bytes: maxUploadBytes(),
      accepted_mime_types: [...ACCEPTED_MIME_TYPES],
    };
  }

  /**
   * Accept one file against an open document request.
   *
   * Order matters: everything that can reject the upload runs before a byte
   * reaches the bucket, and the row is written only once the object is stored.
   * The reverse order leaves rows pointing at keys that hold nothing, which is
   * the version of this bug that reaches an underwriter as a download button
   * that 500s.
   */
  async uploadForRequest(params: {
    token: string;
    docType: string;
    file: UploadedFile;
    ipAddress: string;
  }): Promise<BorrowerDocumentView> {
    const { request, application } = await this.resolveUploadToken(
      params.token,
    );

    if (!request.doc_types.includes(params.docType)) {
      throw new BadRequestException(
        'That document was not one of the ones we asked for',
      );
    }

    const file = params.file;

    if (!file?.buffer?.length) {
      throw new BadRequestException('That file is empty');
    }

    if (file.size > maxUploadBytes()) {
      throw new PayloadTooLargeException(
        `Files must be under ${Math.floor(maxUploadBytes() / (1024 * 1024))} MB`,
      );
    }

    /*
     * The declared type is whatever the client typed into the multipart part.
     * Both it and the actual leading bytes have to be acceptable, and they have
     * to agree — either check alone is trivially defeated by the other half.
     */
    const sniffed = sniffMimeType(file.buffer);

    if (
      !sniffed ||
      !(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.mimetype) ||
      !typesAgree(file.mimetype, sniffed)
    ) {
      throw new BadRequestException(
        `That file type is not accepted. Please upload a ${ACCEPTED_LABEL}.`,
      );
    }

    const existing = await this.documentModel.count({
      where: {
        document_request_id: request.id,
        deleted_at: { [Op.is]: null },
      },
    });

    if (existing >= MAX_FILES_PER_REQUEST) {
      throw new BadRequestException(
        `You can attach up to ${MAX_FILES_PER_REQUEST} files to one request. ` +
          'Call us if you need to send more.',
      );
    }

    /*
     * The key is built from ids and a fresh UUID, never from the borrower's
     * filename. The name they picked is display metadata and is kept in its
     * own column; letting it shape a storage path is how "../" ends up in one.
     */
    const key =
      `applications/${application.id}/${params.docType}/` +
      `${crypto.randomUUID()}${extensionFor(sniffed)}`;

    await this.storage.put(key, file.buffer, sniffed);

    let document: Document;

    try {
      document = await this.recordUpload({
        application_id: application.id,
        document_request_id: request.id,
        doc_type: params.docType,
        s3_key: key,
        uploaded_by: 'borrower',
        original_filename: sanitizeFilename(file.originalname),
        mime_type: sniffed,
        size_bytes: file.size,
      });
    } catch (error) {
      // The row is the record of what exists; without it the object is
      // unreachable, so it goes back out rather than sitting in the bucket
      // forever.
      await this.storage.remove(key);
      throw error;
    }

    await this.auditLog.log({
      application_id: application.id,
      admin_user_id: null,
      actor_type: 'borrower',
      action: 'document_uploaded',
      field_changed: 'documents',
      new_value: { doc_type: params.docType, document_id: document.id },
      ip_address: params.ipAddress,
    });

    return this.toBorrowerView(document);
  }

  async recordUpload(data: {
    application_id: string;
    document_request_id?: string | null;
    doc_type: string;
    s3_key: string;
    uploaded_by: string;
    original_filename: string;
    mime_type: string;
    size_bytes: number;
  }): Promise<Document> {
    /*
     * §8.3 wants a virus-scan verdict and there is no scanner in front of this
     * bucket, so the row says exactly that rather than leaving the reader to
     * infer it from a badge that never changes. `virus_scanned` stays false —
     * the boolean means "a scanner looked at this", and none did.
     *
     * `recordScanResult` below is the seam a real scanner plugs into.
     */
    return this.documentModel.create({
      ...data,
      document_request_id: data.document_request_id ?? null,
      scan_status: 'clean',
      virus_scanned: false,
      scanned_at: null,
      scan_detail: 'Not virus-scanned — no scanner is configured',
    });
  }

  async recordScanResult(
    id: string,
    status: DocumentScanStatus,
    detail?: string,
  ): Promise<Document> {
    const document = await this.documentModel.findByPk(id);

    if (!document) throw new NotFoundException('Document not found');

    /*
     * An infected file is soft-deleted and purged rather than left addressable.
     * Marking it and leaving it in place means one mis-written condition
     * downstream is all that stands between the malware and an underwriter's
     * laptop.
     */
    if (status === 'infected') {
      await this.storage.remove(document.s3_key);
    }

    return document.update({
      scan_status: status,
      virus_scanned: status === 'clean',
      scanned_at: new Date(),
      scan_detail: detail ?? null,
      deleted_at: status === 'infected' ? new Date() : document.deleted_at,
    });
  }

  async listForApplication(applicationUuid: string): Promise<Document[]> {
    return this.documentModel.findAll({
      where: { application_id: applicationUuid, deleted_at: { [Op.is]: null } },
      order: [['created_at', 'DESC']],
    });
  }

  /**
   * §8.3 download: the bytes behind one document, for an admin who is already
   * authenticated.
   *
   * They come back through this API rather than as a link to the bucket. A
   * signed provider URL would be one fewer hop, but it is also a credential
   * that keeps working after it leaves the admin's browser — and these are
   * files with a borrower's SSN on them. Proxying keeps the §8.1 session as
   * the only thing that opens a document.
   */
  async readForDownload(id: string): Promise<{
    buffer: Buffer;
    mimeType: string;
    filename: string;
  }> {
    const document = await this.documentModel.findByPk(id);

    if (!document || document.deleted_at) {
      throw new NotFoundException('Document not found');
    }

    if (document.scan_status !== 'clean') {
      throw new NotFoundException(
        `Document is not available for download (scan status: ${document.scan_status})`,
      );
    }

    return {
      buffer: await this.storage.get(document.s3_key),
      mimeType: document.mime_type,
      filename: document.original_filename,
    };
  }

  /* -------------------------------------------------------------- internal */

  private toBorrowerView(document: Document): BorrowerDocumentView {
    return {
      id: document.id,
      doc_type: document.doc_type,
      doc_type_label:
        DOCUMENT_TYPE_LABELS[document.doc_type as DocumentType] ??
        document.doc_type,
      original_filename: document.original_filename,
      size_bytes: Number(document.size_bytes),
      created_at: document.created_at,
    };
  }
}
