'use strict';

/**
 * §8.1 refresh tokens for admin sessions.
 *
 * The access token used to live as long as the idle window, which made it the
 * only credential in the system: a copy lifted off a laptop stayed good for two
 * hours and nothing short of a manual revoke stopped it. Splitting the pair
 * lets the access token be short (minutes) while the session itself keeps its
 * 12-hour absolute life, so a stolen bearer token expires on its own.
 *
 * Only hashes are stored. A dump of admin_sessions must not hand anyone a
 * working credential, which a plaintext refresh token would.
 *
 * `previous_refresh_token_hash` exists for reuse detection: after rotation the
 * retired hash is kept for one generation, so a replayed token is recognisable
 * as *this* session's old token rather than as an unknown string, and the whole
 * session can be killed.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { sequelize } = queryInterface;

    await sequelize.transaction(async (transaction) => {
      const options = { transaction };
      const table = await queryInterface.describeTable('admin_sessions', options);

      const addColumn = async (name, spec) => {
        if (!table[name]) {
          await queryInterface.addColumn('admin_sessions', name, spec, options);
        }
      };

      // SHA-256 hex — 64 characters, fixed width.
      await addColumn('refresh_token_hash', {
        type: Sequelize.STRING(64),
        allowNull: true,
      });

      await addColumn('previous_refresh_token_hash', {
        type: Sequelize.STRING(64),
        allowNull: true,
      });

      await addColumn('refresh_token_expires_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });

      await addColumn('refresh_rotated_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });

      // Purely diagnostic: an implausible rotation count on one session is the
      // signature of a client stuck in a refresh loop.
      await addColumn('refresh_count', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });

      /*
       * Refresh is a lookup *by hash* — the caller presents a token, not a
       * session id — so this index is the hot path, not a nicety. Unique so two
       * sessions can never collide on one credential; partial so the many rows
       * with a NULL hash (revoked, or created before this migration) do not sit
       * in it.
       */
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS admin_sessions_refresh_token_hash_idx
           ON admin_sessions (refresh_token_hash)
         WHERE refresh_token_hash IS NOT NULL;`,
        options,
      );

      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS admin_sessions_previous_refresh_hash_idx
           ON admin_sessions (previous_refresh_token_hash)
         WHERE previous_refresh_token_hash IS NOT NULL;`,
        options,
      );

      /*
       * Sessions that predate this migration have no refresh token and can
       * never be given one — there is nothing to hand back to a client that
       * never received one. They keep working until their access token runs
       * out and then have to sign in again, which is a single re-login on
       * deploy rather than a broken portal.
       */
    });
  },

  async down(queryInterface) {
    const { sequelize } = queryInterface;

    await sequelize.transaction(async (transaction) => {
      const options = { transaction };

      await sequelize.query(
        'DROP INDEX IF EXISTS admin_sessions_refresh_token_hash_idx;',
        options,
      );
      await sequelize.query(
        'DROP INDEX IF EXISTS admin_sessions_previous_refresh_hash_idx;',
        options,
      );

      for (const column of [
        'refresh_token_hash',
        'previous_refresh_token_hash',
        'refresh_token_expires_at',
        'refresh_rotated_at',
        'refresh_count',
      ]) {
        await queryInterface.removeColumn('admin_sessions', column, options);
      }
    });
  },
};
