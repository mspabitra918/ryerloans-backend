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
 * Every admin touch, immutable (§3).
 *
 * Values are stored as SHA-256 hashes rather than plaintext: the log has to
 * prove *that* a field changed and survive a regulator reading it, without
 * becoming a second copy of the borrower's SSN and bank details.
 *
 * Column types mirror the create-audit-log migration: UUID keys, INET address,
 * created_at only (rows are never updated).
 */
@Table({
  tableName: 'audit_log',
  timestamps: true,
  updatedAt: false,
  createdAt: 'created_at',
  underscored: true,
})
export class AuditLog extends Model<
  InferAttributes<AuditLog>,
  InferCreationAttributes<AuditLog>
> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: CreationOptional<string>;

  /** FK to applications.id (the UUID), not the 6-digit application_id. */
  @ForeignKey(() => Application)
  @Column({ type: DataType.UUID, allowNull: false })
  declare application_id: string;

  /*
   * Null for an action the borrower took themselves — a §6.1 e-signature or
   * micro-deposit confirmation. Inventing an admin id for those (reusing the
   * agent who last touched the file, say) would put a name against an action
   * that person did not take, which is worse than no name at all.
   */
  @ForeignKey(() => AdminUser)
  @Column({ type: DataType.UUID, allowNull: true })
  declare admin_user_id: CreationOptional<string | null>;

  /** Who acted: 'admin', 'borrower', or 'system' (queue jobs, webhooks). */
  @Default('admin')
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare actor_type: CreationOptional<string>;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare action: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare field_changed: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare old_value_hash: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare new_value_hash: CreationOptional<string | null>;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare note: CreationOptional<string | null>;

  @Column({ type: DataType.INET, allowNull: false })
  declare ip_address: string;

  @Column(DataType.DATE)
  declare created_at: CreationOptional<Date>;
}
