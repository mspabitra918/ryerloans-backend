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

/**
 * Values match the `scheduled` default in the create-email-sequences migration.
 * Stored as a plain varchar, not a PG enum — declaring DataType.ENUM here would
 * not match the column.
 */
export const SequenceStatus = {
  SCHEDULED: 'scheduled',
  SENT: 'sent',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const;

export type SequenceStatus =
  (typeof SequenceStatus)[keyof typeof SequenceStatus];

/**
 * Drip sequence control (§3, §7.2). One row per planned step, so a cancellation
 * can always be explained after the fact via cancelled_at + cancel_trigger.
 */
@Table({
  tableName: 'email_sequences',
  timestamps: true,
  underscored: true,
})
export class EmailSequence extends Model<
  InferAttributes<EmailSequence>,
  InferCreationAttributes<EmailSequence>
> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: CreationOptional<string>;

  /** FK to applications.id (the UUID), not the 6-digit application_id. */
  @Column({ type: DataType.UUID, allowNull: false })
  declare application_id: string;

  /** `call_in` or `bank_verification`. */
  @Column({ type: DataType.STRING(100), allowNull: false })
  declare sequence_key: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare step_number: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare scheduled_for: Date;

  @Default(SequenceStatus.SCHEDULED)
  @Column({ type: DataType.STRING(30), allowNull: false })
  declare status: CreationOptional<SequenceStatus>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare cancelled_at: CreationOptional<Date | null>;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare cancel_trigger: CreationOptional<string | null>;
}
