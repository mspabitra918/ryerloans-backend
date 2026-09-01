'use strict';

/**
 * Schema for the §6.1 borrower-driven transitions.
 *
 * Three edges on the state machine are labelled with the borrower, not an
 * admin — `[Plaid success — auto]`, `[borrower e-signs]` and `[borrower
 * confirms amounts]` — but they were only reachable through admin endpoints
 * behind AdminJwtGuard. Moving them onto the borrower surface needs three
 * things the schema did not have:
 *
 *  1. borrower_action_tokens  — the one-time links that authenticate a
 *                               borrower for exactly one action, same shape as
 *                               the §8.4 document upload link (SHA-256 only,
 *                               plaintext lives solely in the email)
 *  2. applications.*          — the two micro-deposit amounts, so "confirms
 *                               amounts" has something to be checked against
 *  3. audit_log.*             — an actor that is not an admin. admin_user_id
 *                               was NOT NULL with an FK to admin_users, which
 *                               made a borrower action literally unauditable.
 *
 * Every step is guarded so the migration can be re-run against a database that
 * was partially patched by hand.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { sequelize } = queryInterface;

    await sequelize.transaction(async (transaction) => {
      const options = { transaction };

      const tables = await queryInterface.showAllTables(options);
      const hasTable = (name) =>
        tables
          .map((t) => (typeof t === 'string' ? t : t.tableName))
          .includes(name);

      const columnsOf = async (table) =>
        hasTable(table) ? queryInterface.describeTable(table, options) : {};

      // ---------------------------------------------------------------------
      // 1. borrower_action_tokens
      // ---------------------------------------------------------------------
      if (!hasTable('borrower_action_tokens')) {
        await queryInterface.createTable(
          'borrower_action_tokens',
          {
            id: {
              type: Sequelize.UUID,
              defaultValue: Sequelize.literal('gen_random_uuid()'),
              primaryKey: true,
            },
            application_id: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'applications', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            /*
             * One row type per borrower-driven edge. Scoping the token to a
             * purpose is what stops an e-sign link from being replayed against
             * the deposit-confirmation endpoint.
             */
            purpose: {
              type: Sequelize.STRING(40),
              allowNull: false,
            },
            // SHA-256 hex. The plaintext token exists only in the borrower's
            // email, so a database dump hands out no working links.
            token_hash: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            expires_at: { type: Sequelize.DATE, allowNull: false },
            // Set on use. A consumed token is kept, not deleted: it is the
            // evidence of when the borrower acted.
            consumed_at: { type: Sequelize.DATE, allowNull: true },
            consumed_ip: { type: Sequelize.INET, allowNull: true },
            // Set when a re-send supersedes an outstanding link.
            revoked_at: { type: Sequelize.DATE, allowNull: true },
            created_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.fn('NOW'),
            },
            updated_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.fn('NOW'),
            },
          },
          options,
        );

        // Lookup is always by hash, and a duplicate hash would make the
        // "which token was this" question unanswerable.
        await queryInterface.addIndex('borrower_action_tokens', {
          fields: ['token_hash'],
          unique: true,
          name: 'borrower_action_tokens_token_hash_uniq',
          transaction,
        });

        await queryInterface.addIndex('borrower_action_tokens', {
          fields: ['application_id', 'purpose'],
          name: 'borrower_action_tokens_application_purpose_idx',
          transaction,
        });
      }

      // ---------------------------------------------------------------------
      // 2. applications — micro-deposit amounts
      // ---------------------------------------------------------------------
      const appColumns = await columnsOf('applications');

      /*
       * Stored in cents as integers. Micro-deposits are amounts like $0.27,
       * and the whole point of the step is that the borrower reproduces them
       * exactly — a float that compares 27 to 26.999999 defeats the check.
       */
      for (const column of [
        'micro_deposit_amount_1_cents',
        'micro_deposit_amount_2_cents',
      ]) {
        if (!appColumns[column]) {
          await queryInterface.addColumn(
            'applications',
            column,
            { type: Sequelize.INTEGER, allowNull: true },
            options,
          );
        }
      }

      // Counts failed confirmation attempts so the endpoint can lock out
      // guessing rather than allowing unlimited tries at two 2-digit numbers.
      if (!appColumns.micro_deposit_attempts) {
        await queryInterface.addColumn(
          'applications',
          'micro_deposit_attempts',
          { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          options,
        );
      }

      // ---------------------------------------------------------------------
      // 3. audit_log — an actor that is not an admin
      // ---------------------------------------------------------------------
      const auditColumns = await columnsOf('audit_log');

      if (auditColumns.admin_user_id && auditColumns.admin_user_id.allowNull === false) {
        /*
         * A borrower e-signature is exactly the event an E-SIGN dispute turns
         * on, so it has to be auditable. It has no admin_user_id, and inventing
         * one — reusing the agent who last touched the file — would put a name
         * against an action that person did not take.
         */
        await queryInterface.changeColumn(
          'audit_log',
          'admin_user_id',
          {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: 'admin_users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          options,
        );
      }

      if (!auditColumns.actor_type) {
        await queryInterface.addColumn(
          'audit_log',
          'actor_type',
          {
            type: Sequelize.STRING(20),
            allowNull: false,
            defaultValue: 'admin',
          },
          options,
        );
      }
    });
  },

  async down(queryInterface, Sequelize) {
    const { sequelize } = queryInterface;

    await sequelize.transaction(async (transaction) => {
      const options = { transaction };

      await queryInterface.removeColumn('audit_log', 'actor_type', options);

      /*
       * Restoring NOT NULL would fail against any borrower-authored row, so
       * clear those first. They are audit evidence — this is why the down
       * migration is a last resort, not a routine rollback.
       */
      await sequelize.query(
        `DELETE FROM audit_log WHERE admin_user_id IS NULL;`,
        options,
      );

      await queryInterface.changeColumn(
        'audit_log',
        'admin_user_id',
        {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'admin_users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
        options,
      );

      for (const column of [
        'micro_deposit_amount_1_cents',
        'micro_deposit_amount_2_cents',
        'micro_deposit_attempts',
      ]) {
        await queryInterface.removeColumn('applications', column, options);
      }

      await queryInterface.dropTable('borrower_action_tokens', options);
    });
  },
};
