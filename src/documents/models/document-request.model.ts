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
import { AdminUser } from '../../admin-users/models/admin-user.model';

/**
 * One §8.4 "Request Documents" checklist and the upload link it generated.
 *
 * `token_hash` holds SHA-256 of the link token, never the token itself: the
 * borrower's email is the only place the plaintext exists, so a leaked database
 * dump does not hand out upload access to every open request.
 */
@Table({
  tableName: 'document_requests',
  timestamps: true,
  underscored: true,
})
export class DocumentRequest extends Model<
  InferAttributes<DocumentRequest>,
  InferCreationAttributes<DocumentRequest>
> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: CreationOptional<string>;

  @ForeignKey(() => Application)
  @Column({ type: DataType.UUID, allowNull: false })
  declare application_id: string;

  @ForeignKey(() => AdminUser)
  @Column({ type: DataType.UUID, allowNull: false })
  declare requested_by: string;

  @Column({ type: DataType.ARRAY(DataType.TEXT), allowNull: false })
  declare doc_types: string[];

  @Column({ type: DataType.STRING(64), allowNull: false })
  declare token_hash: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expires_at: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare completed_at: CreationOptional<Date | null>;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare note: CreationOptional<string | null>;

  @Column(DataType.DATE)
  declare created_at: CreationOptional<Date>;

  @Column(DataType.DATE)
  declare updated_at: CreationOptional<Date>;
}
