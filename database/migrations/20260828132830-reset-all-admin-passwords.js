'use strict';

const bcrypt = require('bcrypt');

/**
 * Reset passwords for all admin users.
 *
 * This updates existing records.
 * It does NOT create duplicate admin users.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const saltRounds = 10;

    const users = [
      {
        login_id: 'GFHR537F',
        email: 'superadmin@ryerloans.com',
        password: 'RyerSuper#2026!Adm',
      },
      {
        login_id: 'GFHR5371',
        email: 'underwriter@ryerloans.com',
        password: 'RyerUW#2026!Pass',
      },
      {
        login_id: 'GFHR5372',
        email: 'funding@ryerloans.com',
        password: 'RyerFund#2026!Pay',
      },
      {
        login_id: 'GFHR5373',
        email: 'agent@ryerloans.com',
        password: 'RyerAgent#2026!Ops',
      },
      {
        login_id: 'GFHR5374',
        email: 'auditor@ryerloans.com',
        password: 'RyerView#2026!Audit',
      },
    ];

    for (const user of users) {
      const passwordHash = await bcrypt.hash(user.password, saltRounds);

      const [existingUser] = await queryInterface.sequelize.query(
        `
        SELECT id
        FROM admin_users
        WHERE login_id = :loginId
        LIMIT 1
        `,
        {
          replacements: {
            loginId: user.login_id,
          },
          type: Sequelize.QueryTypes.SELECT,
        },
      );

      if (!existingUser) {
        throw new Error(
          `Admin user not found: ${user.login_id} (${user.email})`,
        );
      }

      await queryInterface.sequelize.query(
        `
        UPDATE admin_users
        SET
          password_hash = :passwordHash,
          updated_at = NOW()
        WHERE login_id = :loginId
        `,
        {
          replacements: {
            passwordHash,
            loginId: user.login_id,
          },
        },
      );

      console.log(`Password reset successfully for ${user.email}`);
    }

    console.log('All admin user passwords have been reset successfully.');
  },

  async down() {
    /**
     * Previous password hashes are not stored by this migration,
     * so rollback cannot safely restore them.
     */
    console.log('Rollback skipped: previous password hashes were not stored.');
  },
};
