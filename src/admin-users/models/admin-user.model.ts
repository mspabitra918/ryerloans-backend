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

export enum AdminRole {
  SUPER_ADMIN = 'super_admin',
  UNDERWRITER = 'underwriter',
  FUNDING = 'funding',
  AGENT = 'agent',
  READ_ONLY = 'read_only',
}

@Table({ tableName: 'admin_users', timestamps: true, underscored: true })
export class AdminUser extends Model<
  InferAttributes<AdminUser>,
  InferCreationAttributes<AdminUser>
> {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: CreationOptional<string>;

  /** Human-facing login code (e.g. GFHR537F) — see the admin_users migration. */
  @Column({ type: DataType.STRING(50), unique: true, allowNull: false })
  declare login_id: string;

  @Column({ type: DataType.CITEXT, unique: true, allowNull: false })
  declare email: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare password_hash: string;

  @Column({
    type: DataType.ENUM(...Object.values(AdminRole)),
    defaultValue: AdminRole.READ_ONLY,
  })
  declare role: AdminRole;

  @Column(DataType.STRING)
  declare mfa_secret: CreationOptional<string | null>;

  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  declare mfa_enabled: CreationOptional<boolean>;

  @Column(DataType.DATE)
  declare last_login_at: CreationOptional<Date | null>;

  @Column(DataType.STRING)
  declare last_login_ip: CreationOptional<string | null>;

  @Column({ type: DataType.INTEGER, defaultValue: 0 })
  declare failed_attempts: CreationOptional<number>;

  @Column(DataType.DATE)
  declare locked_until: CreationOptional<Date | null>;

  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  declare is_active: CreationOptional<boolean>;
}
