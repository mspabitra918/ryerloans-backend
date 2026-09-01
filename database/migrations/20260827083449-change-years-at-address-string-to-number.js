'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "applications"
      ALTER COLUMN "years_at_address" DROP NOT NULL;

      ALTER TABLE "applications"
      ALTER COLUMN "years_at_address" DROP DEFAULT;

      ALTER TABLE "applications"
      ALTER COLUMN "years_at_address"
      TYPE INTEGER
      USING NULLIF(TRIM("years_at_address"), '')::INTEGER;
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "applications"
      ALTER COLUMN "years_at_address"
      TYPE VARCHAR(255)
      USING "years_at_address"::TEXT;
    `);
  },
};
