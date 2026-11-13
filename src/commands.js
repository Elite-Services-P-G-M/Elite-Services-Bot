
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = [
  new SlashCommandBuilder()
    .setName('nexus-panel')
    .setDescription('Post a Elite Services interactive panel')
    .addStringOption(option => option
      .setName('panel')
      .setDescription('Which interactive panel should be posted?')
      .setRequired(true)
      .addChoices(
        { name: 'Applications', value: 'applications' },
        { name: 'Tickets', value: 'tickets' },
        { name: 'Staff duty', value: 'staff' },
        { name: 'DMail', value: 'mail' },
        { name: 'Invoices', value: 'invoices' },
        { name: 'CDN', value: 'cdn' }
      ))
    .addAttachmentOption(option => option
      .setName('image')
      .setDescription('Optional image for the Applications panel')
      .setRequired(false))
].map(command => command.toJSON());
