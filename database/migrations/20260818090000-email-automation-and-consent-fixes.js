'use strict';

/**
 * Brings the schema in line with the brief's §3/§7 requirements:
 *
 *  1. email_suppressions — the pre-send suppression list (§7.3). Did not exist.
 *  2. email_log.application_id relaxed to NULL for operational mail.
 *  3. applications.possible_duplicate — the soft-duplicate score was already
 *     being computed on submit and then silently dropped, because there was no
 *     column to write it to.
 *  4. TCPA consent evidence columns made conditionally required. consent_tcpa_at
 *     and consent_tcpa_text were NOT NULL while the DTO treats TCPA consent as
 *     optional (correct — the FCC forbids making it a condition of the loan), so
 *     any submission without marketing consent failed to insert. They are now
 *     nullable, with a CHECK enforcing that the evidence IS present whenever
 *     consent was actually given.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      /* ----------------------------------------------------------------
       * 1. Suppression list
       * ---------------------------------------------------------------- */
      const tables = await queryInterface.showAllTables();
      const tableNames = tables.map((t) =>
        typeof t === 'object' ? t.tableName : t,
      );

      if (!tableNames.includes('email_suppressions')) {
        await queryInterface.sequelize.query(
          `DROP TYPE IF EXISTS "enum_email_suppressions_reason" CASCADE;`,
          { transaction },
        );

        await queryInterface.sequelize.query(
          `CREATE TYPE "enum_email_suppressions_reason" AS ENUM (
             'unsubscribe', 'hard_bounce', 'spam_complaint', 'manual'
           );`,
          { transaction },
        );

        await queryInterface.createTable(
          'email_suppressions',
          {
            id: {
              type: Sequelize.UUID,
              defaultValue: Sequelize.literal('gen_random_uuid()'),
              primaryKey: true,
              allowNull: false,
            },
            email_normalized: {
              type: Sequelize.STRING(320),
              allowNull: false,
              unique: true,
            },
            email: {
              type: Sequelize.STRING(320),
              allowNull: false,
            },
            reason: {
              type: 'enum_email_suppressions_reason',
              allowNull: false,
            },
            // Hard bounces and complaints block everything; an unsubscribe
            // blocks marketing/drip mail only.
            suppresses_transactional: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
              defaultValue: false,
            },
            source: {
              type: Sequelize.STRING(100),
              allowNull: true,
            },
            suppressed_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('NOW()'),
            },
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
          },
          { transaction },
        );

        await queryInterface.addIndex(
          'email_suppressions',
          ['email_normalized'],
          {
            unique: true,
            name: 'email_suppressions_email_normalized_uniq',
            transaction,
          },
        );
      }

      /* ----------------------------------------------------------------
       * 2. email_log.application_id -> nullable
       * ---------------------------------------------------------------- */
      if (tableNames.includes('email_log')) {
        await queryInterface.changeColumn(
          'email_log',
          'application_id',
          {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: 'applications', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          { transaction },
        );

        await queryInterface.addIndex('email_log', ['provider_message_id'], {
          name: 'email_log_provider_message_id_idx',
          transaction,
        });
      }

      /* ----------------------------------------------------------------
       * 3. applications.possible_duplicate
       * ---------------------------------------------------------------- */
      const applicationsTable =
        await queryInterface.describeTable('applications');

      if (!applicationsTable.possible_duplicate) {
        await queryInterface.addColumn(
          'applications',
          'possible_duplicate',
          {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          { transaction },
        );
      }

      /* ----------------------------------------------------------------
       * 4. TCPA consent evidence: nullable + conditional CHECK
       * ---------------------------------------------------------------- */
      await queryInterface.changeColumn(
        'applications',
        'consent_tcpa_at',
        { type: Sequelize.DATE, allowNull: true },
        { transaction },
      );

      await queryInterface.changeColumn(
        'applications',
        'consent_tcpa_text',
        { type: Sequelize.TEXT, allowNull: true },
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "applications"
           ALTER COLUMN "consent_tcpa" SET DEFAULT false;`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "applications"
           DROP CONSTRAINT IF EXISTS "applications_tcpa_evidence_check";`,
        { transaction },
      );

      // Consent given => we must be able to prove when, and with what wording.
      await queryInterface.sequelize.query(
        `ALTER TABLE "applications"
           ADD CONSTRAINT "applications_tcpa_evidence_check"
           CHECK (
             "consent_tcpa" IS NOT TRUE
             OR ("consent_tcpa_at" IS NOT NULL AND "consent_tcpa_text" IS NOT NULL)
           );`,
        { transaction },
      );

      /* ----------------------------------------------------------------
       * 5. Indexes supporting the 45-day expiry sweep and status filtering
       * ---------------------------------------------------------------- */
      await queryInterface.addIndex('applications', ['form_completed_at'], {
        name: 'applications_form_completed_at_idx',
        transaction,
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.removeIndex(
        'applications',
        'applications_form_completed_at_idx',
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "applications"
           DROP CONSTRAINT IF EXISTS "applications_tcpa_evidence_check";`,
        { transaction },
      );

      // NOTE: reverting these to NOT NULL will fail if any row has null TCPA
      // evidence, which is the expected state for borrowers who declined
      // marketing consent. Backfill before rolling back.
      await queryInterface.changeColumn(
        'applications',
        'consent_tcpa_text',
        { type: Sequelize.TEXT, allowNull: false },
        { transaction },
      );

      await queryInterface.changeColumn(
        'applications',
        'consent_tcpa_at',
        { type: Sequelize.DATE, allowNull: false },
        { transaction },
      );

      await queryInterface.removeColumn('applications', 'possible_duplicate', {
        transaction,
      });

      await queryInterface.removeIndex(
        'email_log',
        'email_log_provider_message_id_idx',
        { transaction },
      );

      await queryInterface.changeColumn(
        'email_log',
        'application_id',
        {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'applications', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        { transaction },
      );

      await queryInterface.dropTable('email_suppressions', { transaction });

      await queryInterface.sequelize.query(
        `DROP TYPE IF EXISTS "enum_email_suppressions_reason" CASCADE;`,
        { transaction },
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
