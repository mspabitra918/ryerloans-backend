'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('email_sequences', {
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
      sequence_key: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      step_number: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      scheduled_for: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING(30),
        allowNull: false,
        defaultValue: 'scheduled',
      },
      cancelled_at: {
        type: Sequelize.DATE,
      },
      cancel_trigger: {
        type: Sequelize.STRING(100),
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

    await queryInterface.addIndex('email_sequences', [
      'application_id',
      'sequence_key',
    ]);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('email_sequences');
  },
};
