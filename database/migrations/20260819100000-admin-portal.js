'use strict';

/**
 * Schema for the §8 admin portal.
 *
 *  1. admin_sessions          — §8.1 idle timeout + IP-bound sessions
 *  2. application_notes       — §8.3 internal, append-only notes
 *  3. applications.*          — assigned agent, adverse-action reference,
 *                               document-request state
 *  4. §8.2 search indexes     — pg_trgm GIN on names, B-tree on
 *                               phone_normalized / email_normalized / ssn_last4
 *  5. documents.*             — virus-scan verdict, upload links, request state
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

      // ---------------------------------------------------------------------
      // 0. Extensions
      // ---------------------------------------------------------------------
      // pg_trgm backs the §8.2 requirement that a partial or slightly wrong
      // name still finds the borrower. Without the extension the GIN indexes
      // below cannot be created at all.
      await sequelize.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;', options);
      await sequelize.query('CREATE EXTENSION IF NOT EXISTS citext;', options);

      // ---------------------------------------------------------------------
      // 1. admin_sessions
      // ---------------------------------------------------------------------
      const tables = await queryInterface.showAllTables(options);
      const hasTable = (name) =>
        tables.map((t) => (typeof t === 'string' ? t : t.tableName)).includes(name);

      if (!hasTable('admin_sessions')) {
        await queryInterface.createTable(
          'admin_sessions',
          {
            id: {
              type: Sequelize.UUID,
              defaultValue: Sequelize.literal('gen_random_uuid()'),
              primaryKey: true,
              allowNull: false,
            },
            admin_user_id: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'admin_users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            ip_address: { type: Sequelize.INET, allowNull: false },
            user_agent: { type: Sequelize.TEXT },
            last_seen_at: { type: Sequelize.DATE, allowNull: false },
            expires_at: { type: Sequelize.DATE, allowNull: false },
            revoked_at: { type: Sequelize.DATE },
            revoked_reason: { type: Sequelize.STRING(40) },
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
          options,
        );

        await queryInterface.addIndex('admin_sessions', ['admin_user_id'], options);
        // Every authenticated request reads a live session; the partial index
        // keeps revoked rows out of the hot path entirely.
        await queryInterface.addIndex('admin_sessions', ['expires_at'], {
          ...options,
          name: 'admin_sessions_active_idx',
          where: { revoked_at: null },
        });
      }

      // ---------------------------------------------------------------------
      // 2. application_notes (§8.3 "internal, timestamped, attributed,
      //    append-only")
      // ---------------------------------------------------------------------
      if (!hasTable('application_notes')) {
        await queryInterface.createTable(
          'application_notes',
          {
            id: {
              type: Sequelize.UUID,
              defaultValue: Sequelize.literal('gen_random_uuid()'),
              primaryKey: true,
              allowNull: false,
            },
            application_id: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'applications', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            admin_user_id: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'admin_users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'RESTRICT',
            },
            body: { type: Sequelize.TEXT, allowNull: false },
            created_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('NOW()'),
            },
          },
          options,
        );

        await queryInterface.addIndex(
          'application_notes',
          ['application_id', 'created_at'],
          options,
        );

        // Append-only is enforced in the database, not merely by convention:
        // a note an admin can quietly rewrite is not evidence of anything.
        await sequelize.query(
          `
            CREATE OR REPLACE FUNCTION application_notes_append_only()
            RETURNS trigger AS $$
            BEGIN
              RAISE EXCEPTION 'application_notes is append-only';
            END;
            $$ LANGUAGE plpgsql;

            CREATE TRIGGER application_notes_no_mutation
            BEFORE UPDATE OR DELETE ON application_notes
            FOR EACH ROW EXECUTE FUNCTION application_notes_append_only();
          `,
          options,
        );
      }

      // ---------------------------------------------------------------------
      // 3. applications — new admin-portal columns
      // ---------------------------------------------------------------------
      const applications = await queryInterface.describeTable('applications', options);

      const addApplicationColumn = async (name, spec) => {
        if (!applications[name]) {
          await queryInterface.addColumn('applications', name, spec, options);
        }
      };

      // §8.2 filter and §8.3 header: "assigned agent".
      await addApplicationColumn('assigned_agent_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'admin_users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });

      await addApplicationColumn('assigned_at', { type: Sequelize.DATE });

      // §7.3 / §8.4 Decline: the adverse action notice needs a stable
      // reference the borrower can quote, and the date they may reapply.
      await addApplicationColumn('adverse_action_reference', {
        type: Sequelize.STRING(30),
      });
      await addApplicationColumn('reapply_eligible_date', {
        type: Sequelize.DATEONLY,
      });

      // §8.4 Request Documents.
      await addApplicationColumn('documents_requested_at', { type: Sequelize.DATE });
      await addApplicationColumn('documents_requested_types', {
        type: Sequelize.ARRAY(Sequelize.TEXT),
      });

      // Was read by the public status endpoint but never existed as a column —
      // the deposit tracker could therefore never report "completed".
      await addApplicationColumn('micro_deposit_confirmed_at', {
        type: Sequelize.DATE,
      });

      // ---------------------------------------------------------------------
      // 4. §8.2 search indexes
      // ---------------------------------------------------------------------
      // GIN + gin_trgm_ops is what makes ILIKE '%smith%' and fuzzy matching an
      // index scan instead of a sequential one.
      await sequelize.query(
        `
          CREATE INDEX IF NOT EXISTS applications_first_name_trgm_idx
            ON applications USING GIN (first_name gin_trgm_ops);
          CREATE INDEX IF NOT EXISTS applications_last_name_trgm_idx
            ON applications USING GIN (last_name gin_trgm_ops);
          CREATE INDEX IF NOT EXISTS applications_email_trgm_idx
            ON applications USING GIN ((email::text) gin_trgm_ops);

          CREATE INDEX IF NOT EXISTS applications_phone_normalized_idx
            ON applications (phone_normalized);
          CREATE INDEX IF NOT EXISTS applications_ssn_last4_idx
            ON applications (ssn_last4);
          CREATE INDEX IF NOT EXISTS applications_assigned_agent_idx
            ON applications (assigned_agent_id);
          CREATE INDEX IF NOT EXISTS applications_created_at_idx
            ON applications (created_at DESC);
          CREATE INDEX IF NOT EXISTS applications_state_idx
            ON applications (state);
          -- The §8.2 "possible-duplicate" filter only ever asks for the flagged
          -- rows, which are a small minority.
          CREATE INDEX IF NOT EXISTS applications_possible_duplicate_idx
            ON applications (possible_duplicate) WHERE possible_duplicate;
        `,
        options,
      );

      // ---------------------------------------------------------------------
      // 5. documents — §8.3 virus-scan status and presigned links
      // ---------------------------------------------------------------------
      const documents = await queryInterface.describeTable('documents', options);

      const addDocumentColumn = async (name, spec) => {
        if (!documents[name]) {
          await queryInterface.addColumn('documents', name, spec, options);
        }
      };

      // The boolean `virus_scanned` could not distinguish "not scanned yet"
      // from "scanned and infected" — both read as false, and the second must
      // never produce a download link.
      await addDocumentColumn('scan_status', {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
      });
      await addDocumentColumn('scanned_at', { type: Sequelize.DATE });
      await addDocumentColumn('scan_detail', { type: Sequelize.TEXT });
      await addDocumentColumn('deleted_at', { type: Sequelize.DATE });

      await sequelize.query(
        `
          UPDATE documents
             SET scan_status = 'clean'
           WHERE virus_scanned = true AND scan_status = 'pending';
        `,
        options,
      );

      // ---------------------------------------------------------------------
      // 5b. blocked_attempts — now also records failed public status lookups
      // ---------------------------------------------------------------------
      // A lookup failure has an application id and an email but no phone or
      // SSN, and the columns were declared NOT NULL for the duplicate-check
      // case that created the table.
      await sequelize.query(
        `
          ALTER TABLE blocked_attempts ALTER COLUMN phone DROP NOT NULL;
          ALTER TABLE blocked_attempts ALTER COLUMN ssn_hash DROP NOT NULL;
        `,
        options,
      );

      const blockedAttempts = await queryInterface.describeTable(
        'blocked_attempts',
        options,
      );

      if (!blockedAttempts.note) {
        await queryInterface.addColumn(
          'blocked_attempts',
          'note',
          { type: Sequelize.TEXT },
          options,
        );
      }

      await sequelize.query(
        `
          CREATE INDEX IF NOT EXISTS blocked_attempts_ip_reason_idx
            ON blocked_attempts (ip_address, reason, created_at DESC);
        `,
        options,
      );

      // ---------------------------------------------------------------------
      // 6. document_requests — the §8.4 checklist and its upload link
      // ---------------------------------------------------------------------
      if (!hasTable('document_requests')) {
        await queryInterface.createTable(
          'document_requests',
          {
            id: {
              type: Sequelize.UUID,
              defaultValue: Sequelize.literal('gen_random_uuid()'),
              primaryKey: true,
              allowNull: false,
            },
            application_id: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'applications', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            requested_by: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'admin_users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'RESTRICT',
            },
            doc_types: { type: Sequelize.ARRAY(Sequelize.TEXT), allowNull: false },
            // Random, single-purpose, and hashed at rest: the borrower gets the
            // only copy of the plaintext token, by email.
            token_hash: {
              type: Sequelize.STRING(64),
              allowNull: false,
              unique: true,
            },
            expires_at: { type: Sequelize.DATE, allowNull: false },
            completed_at: { type: Sequelize.DATE },
            note: { type: Sequelize.TEXT },
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
          options,
        );

        await queryInterface.addIndex('document_requests', ['application_id'], options);
      }
    });
  },

  async down(queryInterface, Sequelize) {
    const { sequelize } = queryInterface;

    await sequelize.transaction(async (transaction) => {
      const options = { transaction };

      await sequelize.query(
        'DROP TRIGGER IF EXISTS application_notes_no_mutation ON application_notes;',
        options,
      );
      await sequelize.query(
        'DROP FUNCTION IF EXISTS application_notes_append_only();',
        options,
      );

      await queryInterface.dropTable('document_requests', options);
      await queryInterface.dropTable('application_notes', options);
      await queryInterface.dropTable('admin_sessions', options);

      await queryInterface.removeColumn('blocked_attempts', 'note', options);

      await sequelize.query(
        `
          DROP INDEX IF EXISTS blocked_attempts_ip_reason_idx;
          DROP INDEX IF EXISTS applications_first_name_trgm_idx;
          DROP INDEX IF EXISTS applications_last_name_trgm_idx;
          DROP INDEX IF EXISTS applications_email_trgm_idx;
          DROP INDEX IF EXISTS applications_phone_normalized_idx;
          DROP INDEX IF EXISTS applications_ssn_last4_idx;
          DROP INDEX IF EXISTS applications_assigned_agent_idx;
          DROP INDEX IF EXISTS applications_created_at_idx;
          DROP INDEX IF EXISTS applications_state_idx;
          DROP INDEX IF EXISTS applications_possible_duplicate_idx;
        `,
        options,
      );

      for (const column of [
        'assigned_agent_id',
        'assigned_at',
        'adverse_action_reference',
        'reapply_eligible_date',
        'documents_requested_at',
        'documents_requested_types',
        'micro_deposit_confirmed_at',
      ]) {
        await queryInterface.removeColumn('applications', column, options);
      }

      for (const column of ['scan_status', 'scanned_at', 'scan_detail', 'deleted_at']) {
        await queryInterface.removeColumn('documents', column, options);
      }
    });
  },
};
