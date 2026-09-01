'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('applications', 'years_at_address', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('applications', 'years_at_address', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },
};
