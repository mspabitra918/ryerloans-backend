import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
} from 'sequelize-typescript';
import type {
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type EmailStatus =
  'queued' | 'sent' | 'failed' | 'bounced' | 'cancelled';

/**
 * Every email queued or sent (§3). Column types mirror
 * database/migrations/*-create-email-log.js exactly — the table uses UUID keys
 * and snake_case timestamps.
 */
@Table({
  tableName: 'email_log',
  timestamps: true,
  underscored: true,
})
export class EmailLog extends Model<
  InferAttributes<EmailLog>,
  InferCreationAttributes<EmailLog>
> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: CreationOptional<string>;

  /**
   * FK to applications.id (the UUID), not the 6-digit business application_id.
   * Nullable so operational mail with no borrower attached still gets logged.
   */
  @Column({ type: DataType.UUID, allowNull: true })
  declare application_id: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare template_key: string;

  @Column({ type: DataType.CITEXT, allowNull: false })
  declare to_email: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare subject: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare scheduled_for: CreationOptional<Date | null>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare sent_at: CreationOptional<Date | null>;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare provider_message_id: CreationOptional<string | null>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare opened_at: CreationOptional<Date | null>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare bounced_at: CreationOptional<Date | null>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare complaint_at: CreationOptional<Date | null>;

  @Default('queued')
  @Column({ type: DataType.STRING(30), allowNull: false })
  declare status: CreationOptional<EmailStatus>;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare cancelled_reason: CreationOptional<string | null>;

  @Column(DataType.DATE)
  declare created_at: CreationOptional<Date>;

  @Column(DataType.DATE)
  declare updated_at: CreationOptional<Date>;
}
