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

import { Application } from './application.model';

/**
 * The borrower-driven edges of §6.1, and how long each link stays usable.
 *
 * Scoping a token to one purpose is what stops the e-sign link from being
 * replayed against the deposit-confirmation endpoint — the borrower holds both
 * at once, and both advance the file.
 */
export const BORROWER_ACTION_PURPOSES = [
  'bank_verification',
  'agreement_signature',
  'deposit_confirmation',
] as const;

export type BorrowerActionPurpose = (typeof BORROWER_ACTION_PURPOSES)[number];

/**
 * How long every borrower action link lives.
 */
export const BORROWER_ACTION_TTL_DAYS: Record<BorrowerActionPurpose, number> = {
  bank_verification: 30,
  agreement_signature: 30,
  deposit_confirmation: 30,
};

/**
 * A single-use link that authenticates a borrower for exactly one action.
 *
 * `token_hash` holds SHA-256 of the token, never the token itself: the
 * borrower's email is the only place the plaintext exists, so a leaked database
 * dump does not hand out the ability to sign agreements.
 *
 * Rows are never deleted on use. A consumed token — with its timestamp and the
 * IP that used it — is the evidence that the borrower, and not an employee,
 * took the step.
 */
@Table({
  tableName: 'borrower_action_tokens',
  timestamps: true,
  underscored: true,
})
export class BorrowerActionToken extends Model<
  InferAttributes<BorrowerActionToken>,
  InferCreationAttributes<BorrowerActionToken>
> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: CreationOptional<string>;

  @ForeignKey(() => Application)
  @Column({ type: DataType.UUID, allowNull: false })
  declare application_id: string;

  @Column({ type: DataType.STRING(40), allowNull: false })
  declare purpose: BorrowerActionPurpose;

  @Column({ type: DataType.STRING(64), allowNull: false })
  declare token_hash: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expires_at: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare consumed_at: CreationOptional<Date | null>;

  @Column({ type: DataType.INET, allowNull: true })
  declare consumed_ip: CreationOptional<string | null>;

  /** Set when a re-send supersedes an outstanding link for the same purpose. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare revoked_at: CreationOptional<Date | null>;

  @Column(DataType.DATE)
  declare created_at: CreationOptional<Date>;

  @Column(DataType.DATE)
  declare updated_at: CreationOptional<Date>;
}
