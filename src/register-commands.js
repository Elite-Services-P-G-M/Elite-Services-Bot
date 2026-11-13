const { REST, Routes } = require('discord.js');
const config = require('./config');
const commands = require('./commands');

async function main() {
  if (!config.token || !config.clientId || !config.guildId) {
    throw new Error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
  }
  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
  console.log(`Registered ${commands.length} Elite Services command(s).`);
}
main().catch(error => {
  console.error('Command registration failed:', error);
  process.exitCode = 1;
});
