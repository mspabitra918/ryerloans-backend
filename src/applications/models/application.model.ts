import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  Unique,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import type { NonAttribute } from 'sequelize';
import { AdminUser } from '../../admin-users/models/admin-user.model';
import { ApplicationStatus } from '../dto/application-enums';

export interface ApplicationAttributes {
  id?: string;
  application_id: string;
  status: ApplicationStatus;
  substatus?: string;
  amount_requested: number;
  loan_purpose: string;
  loan_purpose_other?: string;
  first_name: string;
  last_name: string;
  email: string;
  email_normalized: string;
  phone: string;
  phone_normalized: string;
  dob: string;
  ssn_encrypted: Buffer;
  ssn_last4: string;
  ssn_hash: string;
  dl_number_encrypted?: Buffer;
  dl_state?: string;
  street_address: string;
  address_line_2?: string;
  city: string;
  state: string;
  zip: string;
  years_at_address?: string;
  housing_status?: string;
  monthly_housing_cost?: number;
  employment_status: string;
  employer_name?: string;
  job_title?: string;
  employment_length_mo?: number;
  employer_phone?: string;
  pay_frequency: string;
  next_pay_date?: string;
  net_monthly_income: number;
  income_source?: string;
  owns_vehicle: boolean;
  vehicle_year?: number;
  vehicle_make?: string;
  vehicle_model?: string;
  vehicle_paid_off?: boolean;
  bank_name: string;
  account_type: string;
  routing_encrypted: Buffer;
  account_encrypted: Buffer;
  account_last4: string;
  /** Banded ("<3", "3–6", "1–2 yrs"), not a count — the column is varchar(30). */
  account_age_months: string;
  current_balance_band: string;
  direct_deposit?: boolean;
  bank_verified?: boolean;
  bank_verified_at?: Date;
  plaid_item_id?: string;
  agreement_sent_at?: Date;
  agreement_signed_at?: Date;
  micro_deposit_sent_at?: Date;
  micro_deposit_conf_at?: Date;
  called_in?: boolean;
  called_in_at?: Date;
  called_in_by_admin?: string;
  decision?: string;
  decision_at?: Date;
  decline_reason_codes?: string[];
  funded_at?: Date;
  funded_amount?: number;
  approved_term_months?: number;
  approved_apr?: number;
  consent_tcpa: boolean;
  /** Null when TCPA consent was declined — see the CHECK constraint. */
  consent_tcpa_at?: Date | null;
  consent_tcpa_text?: string | null;
  consent_esign: boolean;
  consent_esign_at: Date;
  consent_privacy: boolean;
  consent_credit_pull: boolean;
  ip_address: string;
  ip_country?: string;
  ip_region?: string;
  user_agent?: string;
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  landing_page?: string;
  form_started_at?: Date;
  form_completed_at?: Date;
  /** Soft-duplicate signal computed at submit; flags the file for review. */
  possible_duplicate?: boolean;
  /** §8.2/§8.3 assigned agent — FK to admin_users.id. */
  assigned_agent_id?: string | null;
  assigned_at?: Date | null;
  /** §7.3 adverse action notice reference the borrower can quote. */
  adverse_action_reference?: string | null;
  reapply_eligible_date?: string | null;
  /** §8.4 Request Documents. */
  documents_requested_at?: Date | null;
  documents_requested_types?: string[] | null;
  micro_deposit_confirmed_at?: Date | null;
  micro_deposit_amount_1_cents?: number | null;
  micro_deposit_amount_2_cents?: number | null;
  micro_deposit_attempts?: number;
  payoff_recorded_at?: Date | null;
  created_at?: Date;
  updated_at?: Date;
}

@Table({
  tableName: 'applications',
  timestamps: true,
  underscored: true,
})
export class Application
  extends Model<ApplicationAttributes>
  implements ApplicationAttributes
{
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Unique
  @Column({ type: DataType.STRING(6), allowNull: false })
  declare application_id: string;

  @Default(ApplicationStatus.RECEIVED)
  @Column({
    type: DataType.ENUM(...Object.values(ApplicationStatus)),
    allowNull: false,
  })
  declare status: ApplicationStatus;

  @Column(DataType.STRING(50))
  declare substatus?: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare amount_requested: number;

  @Column({ type: DataType.STRING(50), allowNull: false })
  declare loan_purpose: string;

  @Column(DataType.TEXT)
  declare loan_purpose_other?: string;

  @Column({ type: DataType.STRING(80), allowNull: false })
  declare first_name: string;

  @Column({ type: DataType.STRING(80), allowNull: false })
  declare last_name: string;

  @Column({ type: DataType.CITEXT, allowNull: false })
  declare email: string;

  @Column({ type: DataType.CITEXT, allowNull: false })
  declare email_normalized: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare phone: string;

  @Column({ type: DataType.STRING(10), allowNull: false })
  declare phone_normalized: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare dob: string;

  @Column({ type: DataType.BLOB, allowNull: false })
  declare ssn_encrypted: Buffer;

  @Column({ type: DataType.STRING(4), allowNull: false })
  declare ssn_last4: string;

  @Column({ type: DataType.STRING(64), allowNull: false })
  declare ssn_hash: string;

  @Column(DataType.BLOB)
  declare dl_number_encrypted?: Buffer;

  @Column(DataType.CHAR(2))
  declare dl_state?: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare street_address: string;

  @Column(DataType.STRING(100))
  declare address_line_2?: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare city: string;

  @Column({ type: DataType.CHAR(2), allowNull: false })
  declare state: string;

  @Column({ type: DataType.STRING(10), allowNull: false })
  declare zip: string;

  @Column(DataType.INTEGER)
  declare years_at_address?: string;

  @Column(DataType.STRING(20))
  declare housing_status?: string;

  @Column(DataType.INTEGER)
  declare monthly_housing_cost?: number;

  @Column({ type: DataType.STRING(30), allowNull: false })
  declare employment_status: string;

  @Column(DataType.STRING(150))
  declare employer_name?: string;

  @Column(DataType.STRING(100))
  declare job_title?: string;

  @Column(DataType.INTEGER)
  declare employment_length_mo?: number;

  @Column(DataType.STRING(20))
  declare employer_phone?: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare pay_frequency: string;

  @Column(DataType.DATEONLY)
  declare next_pay_date?: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare net_monthly_income: number;

  @Column(DataType.STRING(40))
  declare income_source?: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare owns_vehicle: boolean;

  @Column(DataType.INTEGER)
  declare vehicle_year?: number;

  @Column(DataType.STRING(50))
  declare vehicle_make?: string;

  @Column(DataType.STRING(50))
  declare vehicle_model?: string;

  @Column(DataType.BOOLEAN)
  declare vehicle_paid_off?: boolean;

  @Column({ type: DataType.STRING(120), allowNull: false })
  declare bank_name: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare account_type: string;

  @Column({ type: DataType.BLOB, allowNull: false })
  declare routing_encrypted: Buffer;

  @Column({ type: DataType.BLOB, allowNull: false })
  declare account_encrypted: Buffer;

  @Column({ type: DataType.STRING(4), allowNull: false })
  declare account_last4: string;

  // Stored as a band ("<3", "3–6", "1–2 yrs") per the
  // alter-account-age-months-to-string migration, not as a month count.
  @Column({ type: DataType.STRING(30), allowNull: false })
  declare account_age_months: string;

  @Column({ type: DataType.STRING(30), allowNull: false })
  declare current_balance_band: string;

  @Column(DataType.BOOLEAN)
  declare direct_deposit?: boolean;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare bank_verified: boolean;

  @Column(DataType.DATE)
  declare bank_verified_at?: Date;

  @Column(DataType.STRING(100))
  declare plaid_item_id?: string;

  @Column(DataType.DATE)
  declare agreement_sent_at?: Date;

  @Column(DataType.DATE)
  declare agreement_signed_at?: Date;

  @Column(DataType.DATE)
  declare micro_deposit_sent_at?: Date;

  @Column(DataType.DATE)
  declare micro_deposit_conf_at?: Date;

  @Default(false)
  @Column(DataType.BOOLEAN)
  declare called_in: boolean;

  @Column(DataType.DATE)
  declare called_in_at?: Date;

  @ForeignKey(() => AdminUser)
  @Column(DataType.UUID)
  declare called_in_by_admin?: string;

  @Column(DataType.STRING(20))
  declare decision?: string;

  @Column(DataType.DATE)
  declare decision_at?: Date;

  @Column(DataType.ARRAY(DataType.TEXT))
  declare decline_reason_codes?: string[];

  @Column(DataType.DATE)
  declare funded_at?: Date;

  @Column(DataType.INTEGER)
  declare funded_amount?: number;

  @Column(DataType.INTEGER)
  declare approved_term_months?: number;

  @Column(DataType.DECIMAL(5, 2))
  declare approved_apr?: number;

  // TCPA marketing consent is optional (the FCC forbids conditioning credit on
  // it), so the evidence columns are nullable — but a CHECK constraint requires
  // both to be present whenever consent_tcpa is true.
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare consent_tcpa: boolean;

  @Column({ type: DataType.DATE, allowNull: true })
  declare consent_tcpa_at?: Date | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare consent_tcpa_text?: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare consent_esign: boolean;

  @Column({ type: DataType.DATE, allowNull: false })
  declare consent_esign_at: Date;

  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare consent_privacy: boolean;

  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare consent_credit_pull: boolean;

  @Column({ type: DataType.INET, allowNull: false })
  declare ip_address: string;

  @Column(DataType.CHAR(2))
  declare ip_country?: string;

  @Column(DataType.STRING(80))
  declare ip_region?: string;

  @Column(DataType.TEXT)
  declare user_agent?: string;

  @Column(DataType.TEXT)
  declare referrer?: string;

  @Column(DataType.STRING(100))
  declare utm_source?: string;

  @Column(DataType.STRING(100))
  declare utm_medium?: string;

  @Column(DataType.STRING(100))
  declare utm_campaign?: string;

  @Column(DataType.TEXT)
  declare landing_page?: string;

  @Column(DataType.DATE)
  declare form_started_at?: Date;

  @Column(DataType.DATE)
  declare form_completed_at?: Date;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare possible_duplicate: boolean;

  // §8.2 filter and §8.3 header. SET NULL on delete: an application must not
  // disappear because the agent who owned it left.
  @ForeignKey(() => AdminUser)
  @Column({ type: DataType.UUID, allowNull: true })
  declare assigned_agent_id?: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare assigned_at?: Date | null;

  @Column({ type: DataType.STRING(30), allowNull: true })
  declare adverse_action_reference?: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare reapply_eligible_date?: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare documents_requested_at?: Date | null;

  @Column({ type: DataType.ARRAY(DataType.TEXT), allowNull: true })
  declare documents_requested_types?: string[] | null;

  // Distinct from micro_deposit_sent_at: the borrower confirming the amounts is
  // what advances the file, and the public tracker reads this column.
  @Column({ type: DataType.DATE, allowNull: true })
  declare micro_deposit_confirmed_at?: Date | null;

  /*
   * The two micro-deposit amounts, in whole cents (§0.3: Ryer sends money to
   * the borrower to prove account ownership — never the other way round).
   *
   * Cents as integers, not dollars as floats: the borrower has to reproduce
   * these exactly, and an equality check that compares 0.27 to 0.2699999 fails
   * for a borrower who typed the right thing.
   *
   * Never returned on a borrower-facing response. The only place they legibly
   * exist for the borrower is their own bank statement — that is the proof.
   */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare micro_deposit_amount_1_cents?: number | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare micro_deposit_amount_2_cents?: number | null;

  /** Failed confirmation attempts, so two 2-digit numbers cannot be brute-forced. */
  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare micro_deposit_attempts: number;

  @Column({
    type: DataType.DATE,
    allowNull: true,
  })
  declare payoff_recorded_at: Date | null;

  @Column(DataType.DATE)
  declare created_at?: Date;

  @Column(DataType.DATE)
  declare updated_at?: Date;

  // Two columns point at admin_users, so both associations must name their
  // foreign key explicitly — Sequelize cannot infer which one an include means.
  @BelongsTo(() => AdminUser, {
    foreignKey: 'assigned_agent_id',
    as: 'assigned_agent',
  })
  declare assigned_agent?: NonAttribute<AdminUser>;

  @BelongsTo(() => AdminUser, {
    foreignKey: 'called_in_by_admin',
    as: 'called_in_by',
  })
  declare called_in_by?: NonAttribute<AdminUser>;
}
