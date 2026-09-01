'use strict';
const bcrypt = require('bcrypt');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const saltRounds = 10;

    const superAdminPassword = await bcrypt.hash(
      'RyerSuper#2026!Adm',
      saltRounds,
    );
    const underwriterPassword = await bcrypt.hash(
      'RyerUW#2026!Pass',
      saltRounds,
    );
    const fundingPassword = await bcrypt.hash('RyerFund#2026!Pay', saltRounds);
    const agentPassword = await bcrypt.hash('RyerAgent#2026!Ops', saltRounds);
    const readOnlyPassword = await bcrypt.hash(
      'RyerView#2026!Audit',
      saltRounds,
    );

    await queryInterface.bulkInsert('admin_users', [
      {
        id: Sequelize.literal('gen_random_uuid()'),
        login_id: 'GFHR537F',
        email: 'superadmin@ryerloans.com',
        password_hash: superAdminPassword,
        role: 'super_admin',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: Sequelize.literal('gen_random_uuid()'),
        login_id: 'GFHR5371',
        email: 'underwriter@ryerloans.com',
        password_hash: underwriterPassword,
        role: 'underwriter',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: Sequelize.literal('gen_random_uuid()'),
        login_id: 'GFHR5372',
        email: 'funding@ryerloans.com',
        password_hash: fundingPassword,
        role: 'funding',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: Sequelize.literal('gen_random_uuid()'),
        login_id: 'GFHR5373',
        email: 'agent@ryerloans.com',
        password_hash: agentPassword,
        role: 'agent',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: Sequelize.literal('gen_random_uuid()'),
        login_id: 'GFHR5374',
        email: 'auditor@ryerloans.com',
        password_hash: readOnlyPassword,
        role: 'read_only',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete(
      'admin_users',
      {
        login_id: ['GFHR537F', 'GFHR5371', 'GFHR5372', 'GFHR5373', 'GFHR5374'],
      },
      {},
    );
  },
};
