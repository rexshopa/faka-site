import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => console.log('✅ READY:', client.user.tag));

client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('✅ login() resolved'))
  .catch((e) => console.error('❌ login() failed:', e));
const t = process.env.DISCORD_TOKEN || '';
console.log('Token length:', t.length);
console.log('Has whitespace:', /\s/.test(t));
console.log('First 10 chars:', t.slice(0, 10));
