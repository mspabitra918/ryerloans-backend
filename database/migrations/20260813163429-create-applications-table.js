'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Drop existing ENUM if lingering in Postgres to prevent duplicate errors
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_applications_status" CASCADE;',
    );

    // Create custom ENUM type for PG
    await queryInterface.sequelize.query(`
      CREATE TYPE "enum_applications_status" AS ENUM (
        'received', 'pending_call', 'in_review', 'bank_verification_pending',
        'bank_verification_complete', 'agreement_sent', 'agreement_signed',
        'verification_deposit_sent', 'verification_deposit_confirmed',
        'underwriting', 'approved', 'funded', 'declined', 'withdrawn', 'expired'
      );
    `);

    // Ensure extension for 'citext' is available
    await queryInterface.sequelize.query(
      'CREATE EXTENSION IF NOT EXISTS citext;',
    );

    // 2. Create Table
    await queryInterface.createTable('applications', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
        allowNull: false,
      },
      application_id: {
        type: Sequelize.STRING(6),
        unique: true,
        allowNull: false,
      },
      status: {
        type: 'enum_applications_status',
        allowNull: false,
        defaultValue: 'received',
      },
      substatus: {
        type: Sequelize.STRING(50),
      },

      // Loan Request
      amount_requested: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      loan_purpose: {
        type: Sequelize.STRING(50),
        allowNull: false,
      },
      loan_purpose_other: {
        type: Sequelize.TEXT,
      },

      // Identity (Encrypted)
      first_name: {
        type: Sequelize.STRING(80),
        allowNull: false,
      },
      last_name: {
        type: Sequelize.STRING(80),
        allowNull: false,
      },
      email: {
        type: 'CITEXT',
        allowNull: false,
      },
      email_normalized: {
        type: 'CITEXT',
        allowNull: false,
      },
      phone: {
        type: Sequelize.STRING(20),
        allowNull: false,
      },
      phone_normalized: {
        type: Sequelize.STRING(10),
        allowNull: false,
      },
      dob: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      ssn_encrypted: {
        type: Sequelize.BLOB,
        allowNull: false,
      },
      ssn_last4: {
        type: Sequelize.STRING(4),
        allowNull: false,
      },
      ssn_hash: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      dl_number_encrypted: {
        type: Sequelize.BLOB,
      },
      dl_state: {
        type: Sequelize.CHAR(2),
      },

      // Address
      street_address: {
        type: Sequelize.STRING(200),
        allowNull: false,
      },
      address_line_2: {
        type: Sequelize.STRING(100),
      },
      city: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      state: {
        type: Sequelize.CHAR(2),
        allowNull: false,
      },
      zip: {
        type: Sequelize.STRING(10),
        allowNull: false,
      },
      years_at_address: {
        type: Sequelize.INTEGER,
      },
      housing_status: {
        type: Sequelize.STRING(20),
      },
      monthly_housing_cost: {
        type: Sequelize.INTEGER,
      },

      // Employment
      employment_status: {
        type: Sequelize.STRING(30),
        allowNull: false,
      },
      employer_name: {
        type: Sequelize.STRING(150),
      },
      job_title: {
        type: Sequelize.STRING(100),
      },
      employment_length_mo: {
        type: Sequelize.INTEGER,
      },
      employer_phone: {
        type: Sequelize.STRING(20),
      },
      pay_frequency: {
        type: Sequelize.STRING(20),
        allowNull: false,
      },
      next_pay_date: {
        type: Sequelize.DATEONLY,
      },
      net_monthly_income: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      income_source: {
        type: Sequelize.STRING(40),
      },

      // Vehicle
      owns_vehicle: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },
      vehicle_year: {
        type: Sequelize.INTEGER,
      },
      vehicle_make: {
        type: Sequelize.STRING(50),
      },
      vehicle_model: {
        type: Sequelize.STRING(50),
      },
      vehicle_paid_off: {
        type: Sequelize.BOOLEAN,
      },

      // Banking
      bank_name: {
        type: Sequelize.STRING(120),
        allowNull: false,
      },
      account_type: {
        type: Sequelize.STRING(20),
        allowNull: false,
      },
      routing_encrypted: {
        type: Sequelize.BLOB,
        allowNull: false,
      },
      account_encrypted: {
        type: Sequelize.BLOB,
        allowNull: false,
      },
      account_last4: {
        type: Sequelize.STRING(4),
        allowNull: false,
      },
      account_age_months: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      current_balance_band: {
        type: Sequelize.STRING(30),
        allowNull: false,
      },
      direct_deposit: {
        type: Sequelize.BOOLEAN,
      },

      // Verification
      bank_verified: {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      },
      bank_verified_at: {
        type: Sequelize.DATE,
      },
      plaid_item_id: {
        type: Sequelize.STRING(100),
      },
      agreement_sent_at: {
        type: Sequelize.DATE,
      },
      agreement_signed_at: {
        type: Sequelize.DATE,
      },
      micro_deposit_sent_at: {
        type: Sequelize.DATE,
      },
      micro_deposit_conf_at: {
        type: Sequelize.DATE,
      },

      // Call gate
      called_in: {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      },
      called_in_at: {
        type: Sequelize.DATE,
      },
      // The FK to admin_users is added by the create-admin_users migration
      // rather than declared inline: this migration has the earlier timestamp,
      // so admin_users does not exist yet at this point.
      called_in_by_admin: {
        type: Sequelize.UUID,
      },

      // Decisioning
      decision: {
        type: Sequelize.STRING(20),
      },
      decision_at: {
        type: Sequelize.DATE,
      },
      decline_reason_codes: {
        type: Sequelize.ARRAY(Sequelize.TEXT),
      },
      funded_at: {
        type: Sequelize.DATE,
      },
      funded_amount: {
        type: Sequelize.INTEGER,
      },
      approved_term_months: {
        type: Sequelize.INTEGER,
      },
      approved_apr: {
        type: Sequelize.DECIMAL(5, 2),
      },

      // Consent audit
      consent_tcpa: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },
      consent_tcpa_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      consent_tcpa_text: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      consent_esign: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },
      consent_esign_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      consent_privacy: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },
      consent_credit_pull: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },

      // Provenance
      ip_address: {
        type: Sequelize.INET,
        allowNull: false,
      },
      ip_country: {
        type: Sequelize.CHAR(2),
      },
      ip_region: {
        type: Sequelize.STRING(80),
      },
      user_agent: {
        type: Sequelize.TEXT,
      },
      referrer: {
        type: Sequelize.TEXT,
      },
      utm_source: {
        type: Sequelize.STRING(100),
      },
      utm_medium: {
        type: Sequelize.STRING(100),
      },
      utm_campaign: {
        type: Sequelize.STRING(100),
      },
      landing_page: {
        type: Sequelize.TEXT,
      },
      form_started_at: {
        type: Sequelize.DATE,
      },
      form_completed_at: {
        type: Sequelize.DATE,
      },

      // Timestamps
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    // Indexes
    await queryInterface.addIndex('applications', ['application_id'], {
      unique: true,
    });
    await queryInterface.addIndex('applications', ['email_normalized']);
    await queryInterface.addIndex('applications', ['ssn_hash']);
    await queryInterface.addIndex('applications', ['status']);
    await queryInterface.addIndex('applications', ['first_name']);
    await queryInterface.addIndex('applications', ['last_name']);
    await queryInterface.addIndex('applications', ['phone']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('applications');
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_applications_status" CASCADE;',
    );
  },
};
