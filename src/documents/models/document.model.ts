import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  ForeignKey,
} from 'sequelize-typescript';
import type {
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

import { Application } from '../../applications/models/application.model';
import { DocumentRequest } from './document-request.model';

/**
 * Virus-scan verdict (§8.3 "uploaded files, virus-scan status, presigned
 * download links").
 *
 * A three-state verdict rather than the boolean this table started with: with
 * one flag, "not scanned yet" and "scanned and infected" are the same value,
 * and the download-link rule cannot tell them apart.
 */
export type DocumentScanStatus = 'pending' | 'clean' | 'infected' | 'error';

/**
 * The id is a UUID, matching the create-documents migration. The model
 * previously declared an auto-increment INTEGER, which meant every write went
 * to a column the database had defined as UUID.
 */
@Table({
  tableName: 'documents',
  timestamps: true,
  updatedAt: false,
  createdAt: 'created_at',
  underscored: true,
})
export class Document extends Model<
  InferAttributes<Document>,
  InferCreationAttributes<Document>
> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: CreationOptional<string>;

  /** FK to applications.id (the UUID), not the 6-digit application_id. */
  @ForeignKey(() => Application)
  @Column({ type: DataType.UUID, allowNull: false })
  declare application_id: string;

  /**
   * The §8.4 checklist this upload answers, when there is one.
   *
   * Nullable because an admin can attach a document to a file nobody asked
   * for. Present, it is what lets the borrower's own page show them only the
   * files they just added rather than every document on the application.
   */
  @ForeignKey(() => DocumentRequest)
  @Column({ type: DataType.UUID, allowNull: true })
  declare document_request_id: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(50), allowNull: false })
  declare doc_type: string;

  @Column({ type: DataType.STRING(500), allowNull: false })
  declare s3_key: string;

  /** 'borrower' or an admin user id. */
  @Column({ type: DataType.STRING(50), allowNull: false })
  declare uploaded_by: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare original_filename: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare mime_type: string;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare size_bytes: number;

  /** Retained for backward compatibility; scan_status is authoritative. */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare virus_scanned: CreationOptional<boolean>;

  @Default('pending')
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare scan_status: CreationOptional<DocumentScanStatus>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare scanned_at: CreationOptional<Date | null>;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare scan_detail: CreationOptional<string | null>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare deleted_at: CreationOptional<Date | null>;

  @Column(DataType.DATE)
  declare created_at: CreationOptional<Date>;
}
