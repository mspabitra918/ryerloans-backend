'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('state_availability', {
      state_code: {
        type: Sequelize.CHAR(2),
        primaryKey: true,
        allowNull: false,
      },
      is_active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      license_number: {
        type: Sequelize.STRING(100),
      },
      max_loan_amount: {
        type: Sequelize.INTEGER,
      },
      max_apr: {
        type: Sequelize.DECIMAL(5, 2),
      },
      disclosure_text: {
        type: Sequelize.TEXT,
      },
      waitlist_only: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
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
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('state_availability');
  },
};
