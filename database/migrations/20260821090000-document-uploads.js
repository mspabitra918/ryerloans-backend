'use strict';

/**
 * Schema for the §8.4 borrower document upload.
 *
 * `documents` and `document_requests` both already existed, but nothing joined
 * them: a row recorded which application a file belonged to and never which
 * checklist it answered. That gap is what made the borrower's own page
 * impossible to build — "the files you just uploaded" and "every document ever
 * attached to this application" were the same query, and the second one
 * includes whatever an admin filed by hand.
 *
 * Three changes:
 *
 *  1. documents.document_request_id — nullable FK, because an admin-attached
 *     document has no request behind it. ON DELETE SET NULL rather than
 *     CASCADE: deleting a checklist must not delete the borrower's paystub.
 *  2. an index for the two lookups the upload flow runs on every request —
 *     the borrower's file list and the per-request upload count.
 *  3. audit_log.admin_user_id, dropped to NULL — again.
 *
 * The third is a repair. 20260819160000 already intended it, but its
 * queryInterface.changeColumn() carried a `references` clause and Postgres
 * came out of it with the NOT NULL still in place, so the guard on re-run
 * ("only if it is still NOT NULL") kept firing a statement that never took.
 * The visible effect was silence: AuditLogService catches its own failures so
 * an audit write cannot take down the action it records, so every
 * borrower-authored row — this upload, and the §6.1 e-signature, bank
 * verification and deposit confirmation before it — was logged as an error and
 * dropped. `SELECT count(*) FROM audit_log WHERE actor_type = 'borrower'`
 * returned 0 on a database that had been through all three of those flows.
 *
 * So this one goes through raw SQL, which says exactly the one thing it means
 * and is idempotent whether or not the constraint is there.
 *
 * Every step is guarded so the migration can be re-run against a database that
 * was patched by hand.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { sequelize } = queryInterface;

    await sequelize.transaction(async (transaction) => {
      const options = { transaction };

      const documents = await queryInterface.describeTable(
        'documents',
        options,
      );

      if (!documents.document_request_id) {
        await queryInterface.addColumn(
          'documents',
          'document_request_id',
          {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: 'document_requests', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          options,
        );
      }

      /*
       * Partial on deleted_at IS NULL: every read in the upload path filters
       * out soft-deleted rows, and a borrower who replaces a file three times
       * should not make the fourth lookup walk their mistakes.
       */
      await sequelize.query(
        `
          CREATE INDEX IF NOT EXISTS documents_request_active_idx
            ON documents (document_request_id, created_at)
            WHERE deleted_at IS NULL;
        `,
        options,
      );

      /*
       * A borrower has no admin_user_id and inventing one — reusing the agent
       * who last touched the file — would put a name against an action that
       * person did not take. DROP NOT NULL is a no-op when it has already been
       * dropped, so this needs no guard around it.
       */
      await sequelize.query(
        `ALTER TABLE audit_log ALTER COLUMN admin_user_id DROP NOT NULL;`,
        options,
      );
    });
  },

  /*
   * The NOT NULL is deliberately not restored here. It belongs to
   * 20260819160000, whose own down() already puts it back — and which has to
   * delete the borrower-authored rows to do it. Undoing this migration should
   * cost the upload column, not the audit trail.
   */
  async down(queryInterface) {
    const { sequelize } = queryInterface;

    await sequelize.transaction(async (transaction) => {
      const options = { transaction };

      await sequelize.query(
        `DROP INDEX IF EXISTS documents_request_active_idx;`,
        options,
      );

      const documents = await queryInterface.describeTable(
        'documents',
        options,
      );

      if (documents.document_request_id) {
        await queryInterface.removeColumn(
          'documents',
          'document_request_id',
          options,
        );
      }
    });
  },
};
