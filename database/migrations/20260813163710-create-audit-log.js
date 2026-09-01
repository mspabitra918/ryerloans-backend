'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('audit_log', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
        allowNull: false,
      },
      application_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'applications', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      admin_user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'admin_users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      action: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      field_changed: {
        type: Sequelize.STRING(100),
      },
      old_value_hash: {
        type: Sequelize.STRING(64),
      },
      new_value_hash: {
        type: Sequelize.STRING(64),
      },
      note: {
        type: Sequelize.TEXT,
      },
      ip_address: {
        type: Sequelize.INET,
        allowNull: false,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex('audit_log', ['application_id']);
    await queryInterface.addIndex('audit_log', ['admin_user_id']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('audit_log');
  },
};
