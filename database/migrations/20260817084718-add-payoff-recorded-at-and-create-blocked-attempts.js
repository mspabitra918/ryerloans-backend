'use strict';

const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      /*
       * 1. Add payoff_recorded_at to applications
       */
      const applicationTable =
        await queryInterface.describeTable('applications');

      if (!applicationTable.payoff_recorded_at) {
        await queryInterface.addColumn(
          'applications',
          'payoff_recorded_at',
          {
            type: DataTypes.DATE,
            allowNull: true,
            defaultValue: null,
          },
          { transaction },
        );
      }

      /*
       * 2. Create blocked_attempts table
       */
      const tables = await queryInterface.showAllTables();
      const tableNames = tables.map((t) =>
        typeof t === 'object' ? t.tableName : t,
      );
      const blockedAttemptsExists = tableNames.includes('blocked_attempts');

      if (!blockedAttemptsExists) {
        await queryInterface.createTable(
          'blocked_attempts',
          {
            id: {
              type: DataTypes.INTEGER,
              allowNull: false,
              autoIncrement: true,
              primaryKey: true,
            },
            email: {
              type: DataTypes.STRING,
              allowNull: false,
            },
            phone: {
              type: DataTypes.STRING,
              allowNull: false,
            },
            ssn_hash: {
              type: DataTypes.STRING(64),
              allowNull: false,
            },
            ip_address: {
              type: DataTypes.STRING,
              allowNull: false,
            },
            ip_country: {
              type: DataTypes.STRING,
              allowNull: true,
            },
            ip_region: {
              type: DataTypes.STRING,
              allowNull: true,
            },
            user_agent: {
              type: DataTypes.TEXT,
              allowNull: true,
            },
            reason: {
              type: DataTypes.STRING,
              allowNull: false,
            },
            created_at: {
              type: DataTypes.DATE,
              allowNull: false,
              defaultValue: DataTypes.NOW,
            },
          },
          { transaction },
        );
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      /*
       * 1. Remove blocked_attempts table
       */
      const tables = await queryInterface.showAllTables();
      const tableNames = tables.map((t) =>
        typeof t === 'object' ? t.tableName : t,
      );

      if (tableNames.includes('blocked_attempts')) {
        await queryInterface.dropTable('blocked_attempts', { transaction });
      }

      /*
       * 2. Remove payoff_recorded_at column
       */
      const applicationTable =
        await queryInterface.describeTable('applications');

      if (applicationTable.payoff_recorded_at) {
        await queryInterface.removeColumn(
          'applications',
          'payoff_recorded_at',
          { transaction },
        );
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
