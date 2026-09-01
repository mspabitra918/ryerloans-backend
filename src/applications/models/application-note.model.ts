import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import type {
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  NonAttribute,
} from 'sequelize';

import { Application } from './application.model';
import { AdminUser } from '../../admin-users/models/admin-user.model';

/**
 * §8.3 Notes — "internal, timestamped, attributed, append-only".
 *
 * Append-only is enforced by a database trigger (see the admin-portal
 * migration), so the guarantee survives anything that reaches the table,
 * including a psql session.
 */
@Table({
  tableName: 'application_notes',
  timestamps: true,
  updatedAt: false,
  createdAt: 'created_at',
  underscored: true,
})
export class ApplicationNote extends Model<
  InferAttributes<ApplicationNote>,
  InferCreationAttributes<ApplicationNote>
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
  declare admin_user_id: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare body: string;

  @Column(DataType.DATE)
  declare created_at: CreationOptional<Date>;

  @BelongsTo(() => AdminUser)
  declare author?: NonAttribute<AdminUser>;
}
