import { Table, Column, Model, DataType } from 'sequelize-typescript';
import type {
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

/**
 * Why an address stopped receiving mail. Ordered roughly by severity — a hard
 * bounce or complaint is permanent, an unsubscribe applies to non-transactional
 * mail only.
 */
export enum SuppressionReason {
  UNSUBSCRIBE = 'unsubscribe',
  HARD_BOUNCE = 'hard_bounce',
  SPAM_COMPLAINT = 'spam_complaint',
  MANUAL = 'manual',
}

/**
 * The pre-send suppression list required by §7.3. Keyed on the normalized
 * address so `John.Doe@x.com` and `johndoe@x.com` cannot slip past each other.
 */
@Table({
  tableName: 'email_suppressions',
  timestamps: true,
  underscored: true,
})
export class EmailSuppression extends Model<
  InferAttributes<EmailSuppression>,
  InferCreationAttributes<EmailSuppression>
> {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: CreationOptional<number>;

  @Column({ type: DataType.STRING(320), allowNull: false, unique: true })
  declare email_normalized: string;

  @Column({ type: DataType.STRING(320), allowNull: false })
  declare email: string;

  @Column({
    type: DataType.ENUM(...Object.values(SuppressionReason)),
    allowNull: false,
  })
  declare reason: SuppressionReason;

  /**
   * Hard bounces and complaints suppress everything, including transactional
   * mail — continuing to send to them is what burns a sending domain.
   * Unsubscribes only suppress marketing/drip mail.
   */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare suppresses_transactional: CreationOptional<boolean>;

  @Column({ type: DataType.STRING, allowNull: true })
  declare source: CreationOptional<string | null>;

  @Column({ type: DataType.DATE, allowNull: false })
  declare suppressed_at: Date;
}
