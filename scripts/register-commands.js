import { REST, Routes } from 'discord.js';
import { commands } from '../lib/discord/commands.js';
const {DISCORD_TOKEN,DISCORD_APPLICATION_ID}=process.env;
if (!DISCORD_TOKEN || !/^\d{17,20}$/.test(DISCORD_APPLICATION_ID || '')) {
  console.error('Set DISCORD_TOKEN and DISCORD_APPLICATION_ID in .env. No commands were registered.');
  process.exitCode=1;
} else {
  try {
    await new REST({version:'10'}).setToken(DISCORD_TOKEN).put(Routes.applicationCommands(DISCORD_APPLICATION_ID),{body:commands});
    console.log(`Registered ${commands.length} global commands for user installs, servers, and DMs.`);
    console.log(`Add to My Apps: https://discord.com/oauth2/authorize?client_id=${DISCORD_APPLICATION_ID}&integration_type=1&scope=applications.commands`);
  } catch (err) { console.error(`Command registration failed: ${err.message}`); process.exitCode=1; }
}
