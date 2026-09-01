'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('applications', 'account_age_months', {
      type: Sequelize.STRING(30),
      allowNull: false,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('applications', 'account_age_months', {
      type: Sequelize.INTEGER,
      allowNull: false,
    });
  },
};
