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

import { AdminUser } from '../../admin-users/models/admin-user.model';

/**
 * One row per signed-in admin session (§8.1).
 *
 * The JWT alone cannot express "15-minute idle timeout" or "session bound to
 * IP" — a bearer token is valid until it expires, wherever it is presented
 * from. Both rules are therefore enforced against this row on every request:
 * `last_seen_at` slides forward on activity and is compared to the idle
 * window, and `ip_address` is compared to the caller's.
 */
@Table({
  tableName: 'admin_sessions',
  timestamps: true,
  underscored: true,
})
export class AdminSession extends Model<
  InferAttributes<AdminSession>,
  InferCreationAttributes<AdminSession>
> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: CreationOptional<string>;

  @ForeignKey(() => AdminUser)
  @Column({ type: DataType.UUID, allowNull: false })
  declare admin_user_id: string;

  /** The address the session was established from; never changes. */
  @Column({ type: DataType.INET, allowNull: false })
  declare ip_address: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare user_agent: CreationOptional<string | null>;

  /** Slides forward on every authenticated request. */
  @Column({ type: DataType.DATE, allowNull: false })
  declare last_seen_at: Date;

  /** Absolute cap, independent of activity. */
  @Column({ type: DataType.DATE, allowNull: false })
  declare expires_at: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare revoked_at: CreationOptional<Date | null>;

  /** 'logout' | 'idle_timeout' | 'ip_mismatch' | 'admin_revoked' | 'expired' |
   *  'refresh_reuse' | 'password_changed' | 'account_locked' */
  @Column({ type: DataType.STRING(40), allowNull: true })
  declare revoked_reason: CreationOptional<string | null>;

  /**
   * SHA-256 of the current refresh token. The token itself is never stored —
   * a leaked backup of this table has to be useless on its own, and a hash
   * costs nothing to compare because the lookup is by exact value.
   *
   * Null once the session is revoked or fully spent: an absent hash is what
   * makes the refresh path fail closed.
   */
  @Column({ type: DataType.STRING(64), allowNull: true })
  declare refresh_token_hash: CreationOptional<string | null>;

  /**
   * The hash retired by the most recent rotation, kept for exactly one
   * generation.
   *
   * Without it a replayed token is indistinguishable from a random string and
   * the only available answer is 401 — which leaves the session, and whoever
   * stole the token, running. Matching here says the token was genuine but
   * already spent, and that is the signal to kill the whole session.
   */
  @Column({ type: DataType.STRING(64), allowNull: true })
  declare previous_refresh_token_hash: CreationOptional<string | null>;

  /**
   * Never later than `expires_at`. The refresh token cannot outlive the
   * session it refreshes, or the absolute cap stops being absolute.
   */
  @Column({ type: DataType.DATE, allowNull: true })
  declare refresh_token_expires_at: CreationOptional<Date | null>;

  @Column({ type: DataType.DATE, allowNull: true })
  declare refresh_rotated_at: CreationOptional<Date | null>;

  /** Diagnostic only — a runaway count is a client stuck in a refresh loop. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare refresh_count: CreationOptional<number>;

  @Column(DataType.DATE)
  declare created_at: CreationOptional<Date>;

  @Column(DataType.DATE)
  declare updated_at: CreationOptional<Date>;
}
