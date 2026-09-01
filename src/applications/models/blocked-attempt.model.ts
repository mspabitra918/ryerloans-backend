import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  PrimaryKey,
  AutoIncrement,
} from 'sequelize-typescript';

@Table({
  tableName: 'blocked_attempts',
  timestamps: true,
  updatedAt: false,
})
export class BlockedAttempt extends Model<BlockedAttempt> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  declare id: number;

  @Column(DataType.STRING)
  declare email: string;

  // Nullable: a failed public status lookup has neither.
  @Column(DataType.STRING)
  declare phone: string | null;

  @Column(DataType.STRING(64))
  declare ssn_hash: string | null;

  @Column(DataType.STRING)
  declare ip_address: string;

  @Column(DataType.STRING)
  declare ip_country: string | null;

  @Column(DataType.STRING)
  declare ip_region: string | null;

  @Column(DataType.TEXT)
  declare user_agent: string | null;

  @Column(DataType.STRING)
  declare reason: string;

  @Column(DataType.TEXT)
  declare note: string | null;

  @CreatedAt
  @Column
  declare created_at: Date;
}
