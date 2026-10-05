'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    /**
     * Add seed commands here.
     *
     * Example:
     * await queryInterface.bulkInsert('People', [{
     *   name: 'John Doe',
     *   isBetaMember: false
     * }], {});
    */
  },

  async down (queryInterface, Sequelize) {
    /**
     * Add commands to revert seed here.
     *
     * Example:
     * await queryIn'use strict';

const bcrypt = require('bcrypt');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const passwordHash = await bcrypt.hash(
      '<lkEKO]qb<3z><#i',
      10,
    );

    await queryInterface.bulkInsert('admin_users', [
      {
        id: Sequelize.literal('gen_random_uuid()'),
        login_id: 'DAVID001',
        email: 'david@ryerloans.com',
        password_hash: passwordHash,
        role: 'super_admin',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('admin_users', {
      email: 'david@ryerloans.com',
    });
  },
};terface.bulkDelete('People', null, {});
     */
  }
};
