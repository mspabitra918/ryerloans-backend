import { Table, Column, Model, DataType } from 'sequelize-typescript';

@Table({ tableName: 'state_availability', timestamps: true })
export class StateAvailability extends Model<StateAvailability> {
  @Column({ type: DataType.STRING(2), primaryKey: true })
  declare state_code: string;

  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  declare is_active: boolean;

  @Column(DataType.STRING)
  declare license_number: string | null;

  @Column(DataType.DECIMAL(10, 2))
  declare max_loan_amount: number;

  @Column(DataType.DECIMAL(5, 2))
  declare max_apr: number;

  @Column(DataType.TEXT)
  declare disclosure_text: string | null;

  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  declare waitlist_only: boolean;
}
