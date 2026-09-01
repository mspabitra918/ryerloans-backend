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
 * Column types mirror the create-review-invitations migration: UUID keys
 * throughout. The model previously declared auto-increment INTEGERs for `id`,
 * `application_id` and `moderated_by`, none of which the table has.
 */
@Table({ tableName: 'review_invitations', timestamps: true, underscored: true })
export class ReviewInvitation extends Model<
  InferAttributes<ReviewInvitation>,
  InferCreationAttributes<ReviewInvitation>
> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: CreationOptional<string>;

  /** FK to applications.id (the UUID). */
  @Column({ type: DataType.UUID, allowNull: false })
  declare application_id: string;

  @Column({ type: DataType.STRING, unique: true, allowNull: false })
  declare token: string;

  @Column(DataType.DATE)
  declare sent_at: Date;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expires_at: Date;

  @Column(DataType.DATE)
  declare submitted_at: CreationOptional<Date | null>;

  @Column(DataType.INTEGER)
  declare rating: CreationOptional<number | null>;

  @Column(DataType.TEXT)
  declare review_text: CreationOptional<string | null>;

  /** Rendered from the application at submit time — see renderDisplayName. */
  @Column(DataType.STRING)
  declare display_name: CreationOptional<string | null>;

  /** Which of the three §11 formats the borrower chose. */
  @Column(DataType.STRING)
  declare display_name_preference: CreationOptional<string | null>;

  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  declare consent_to_publish: CreationOptional<boolean>;

  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  declare is_published: CreationOptional<boolean>;

  @Column(DataType.UUID)
  declare moderated_by: CreationOptional<string | null>;

  @Column(DataType.DATE)
  declare moderated_at: CreationOptional<Date | null>;

  /** §11: a rejection has to say why. Null on a published review. */
  @Column(DataType.STRING)
  declare moderation_reason: CreationOptional<string | null>;
}
