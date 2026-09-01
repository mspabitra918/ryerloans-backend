// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------

export enum ApplicationStatus {
  RECEIVED = 'received',
  PENDING_CALL = 'pending_call',
  IN_REVIEW = 'in_review',
  BANK_VERIFICATION_PENDING = 'bank_verification_pending',
  BANK_VERIFICATION_COMPLETE = 'bank_verification_complete',
  AGREEMENT_SENT = 'agreement_sent',
  AGREEMENT_SIGNED = 'agreement_signed',
  VERIFICATION_DEPOSIT_SENT = 'verification_deposit_sent',
  VERIFICATION_DEPOSIT_CONFIRMED = 'verification_deposit_confirmed',
  UNDERWRITING = 'underwriting',
  APPROVED = 'approved',
  FUNDED = 'funded',
  DECLINED = 'declined',
  WITHDRAWN = 'withdrawn',
  EXPIRED = 'expired',
}

export enum LoanPurpose {
  DEBT_CONSOLIDATION = 'Debt Consolidation',
  EMERGENCY_EXPENSES = 'Emergency Expenses',
  MEDICAL_EXPENSES = 'Medical Expenses',
  DENTAL_EXPENSES = 'Dental Expenses',
  HOME_IMPROVEMENT = 'Home Improvement',
  AUTO_REPAIR = 'Auto Repair',
  MOVING_EXPENSES = 'Moving Expenses',
  WEDDING_EXPENSES = 'Wedding Expenses',
  VACATION = 'Vacation',
  EDUCATION = 'Education',
  RENT_OR_UTILITIES = 'Rent or Utilities',
  MAJOR_PURCHASE = 'Major Purchase',
  CHILDCARE_EXPENSES = 'Childcare Expenses',
  FUNERAL_EXPENSES = 'Funeral Expenses',
  TAX_PAYMENTS = 'Tax Payments',
  BUSINESS_EXPENSES = 'Business Expenses',
  OTHER_PERSONAL_EXPENSES = 'Other Personal Expenses',
}

export enum EmploymentStatus {
  FULL_TIME = 'Employed Full-Time',
  PART_TIME = 'Employed Part-Time',
  SELF_EMPLOYED = 'Self-Employed',
  RETIRED = 'Retired',
  MILITARY = 'Military',
  BENEFITS = 'Benefits',
  UNEMPLOYED = 'Unemployed',
}

export enum PayFrequency {
  WEEKLY = 'Weekly',
  BIWEEKLY = 'Bi-Weekly',
  SEMIMONTHLY = 'Semi-Monthly',
  MONTHLY = 'Monthly',
}

export enum AccountType {
  CHECKING = 'Checking',
  SAVINGS = 'Savings',
}

export enum AccountAgeBand {
  LESS_THAN_3_MO = '<3',
  THREE_TO_SIX_MO = '3–6',
  SIX_TO_TWELVE_MO = '6–12',
  ONE_TO_TWO_YR = '1–2 yrs',
  TWO_PLUS_YR = '2+ yrs',
}

export enum CurrentBalanceBand {
  UNDER_100 = 'Under $100',
  BETWEEN_100_500 = '$100–$500',
  BETWEEN_500_1000 = '$500–$1,000',
  BETWEEN_1000_2500 = '$1,000–$2,500',
  OVER_2500 = 'Over $2,500',
}
