import dotenv from 'dotenv';
dotenv.config({ path: './.env' });

import {
  Client, GatewayIntentBits, Partials, Events,
  SlashCommandBuilder, REST, Routes,
  ChannelType, PermissionsBitField,
  ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder,
} from 'discord.js';

const {
  DISCORD_TOKEN, GUILD_ID, SUPPORT_ROLE_ID, TICKET_CATEGORY_ID,
  PANEL_LOGO_URL, GUIDE_CHANNEL_ID, STATUS_CHANNEL_ID, UPDATE_CHANNEL_ID,
  AUTO_CLOSE_MINUTES, AUTO_DELETE_AFTER_CLOSE_MINUTES,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !SUPPORT_ROLE_ID) {
  console.error('❌ Missing env: DISCORD_TOKEN / GUILD_ID / SUPPORT_ROLE_ID');
  process.exit(1);
}

const AUTO_CLOSE_MS = Math.max(1, Number(AUTO_CLOSE_MINUTES ?? 60)) * 60_000;
const AUTO_DELETE_MS = Math.max(0, Number(AUTO_DELETE_AFTER_CLOSE_MINUTES ?? 10)) * 60_000;

// 記憶體計時器（重啟會消失，所以我們把時間也寫進 topic，啟動會重排）
const closeTimers = new Map();   // channelId -> timeout
const deleteTimers = new Map();  // channelId -> timeout

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

const TICKET_OPTIONS = [
  { label: '售前問題', value: 'pre_sale', description: '購買/付款/商品諮詢等' },
  { label: '售後問題', value: 'after_sale', description: '商品使用/遠端/售後問題' },
  { label: '訂單領取', value: 'order_pickup', description: '訂單領取卡密/檔案' },
  { label: '卡密解綁', value: 'unbind', description: '更換設備/重灌需解綁' },
  { label: '參數調整服務', value: 'tuning', description: 'AI自瞄參數調整(需先購買)' },
  { label: '人工解碼服務', value: 'decode', description: '解機碼/人工處理' },
];

function makePanelComponents() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_select')
    .setPlaceholder('選擇服務項目｜客服單將於下方開啟')
    .addOptions(TICKET_OPTIONS.map(o => ({
      label: o.label,
      value: o.value,
      description: o.description
    })));

  return [new ActionRowBuilder().addComponents(menu)];
}

function makeCloseButtonRow() {
  const closeBtn = new ButtonBuilder()
    .setCustomId('ticket_close')
    .setLabel('關閉工單')
    .setStyle(ButtonStyle.Danger);

  return [new ActionRowBuilder().addComponents(closeBtn)];
}

function makeGuideLinks() {
  // 你有填就顯示，沒填就跳過
  const lines = [];
  if (GUIDE_CHANNEL_ID) lines.push(`📌 購買方式：<#${GUIDE_CHANNEL_ID}>`);
  if (STATUS_CHANNEL_ID) lines.push(`🟢 輔助狀態：<#${STATUS_CHANNEL_ID}>`);
  if (UPDATE_CHANNEL_ID) lines.push(`🌐 更新公告：<#${UPDATE_CHANNEL_ID}>`);
  return lines.length ? lines.join('\n') : null;
}

function clearTimer(map, channelId) {
  const t = map.get(channelId);
  if (t) clearTimeout(t);
  map.delete(channelId);
}

function parseTopicValue(topic, key) {
  // topic 格式：a=b; c=d; ...
  const m = topic?.match(new RegExp(`${key}=(\\d+)`));
  return m ? Number(m[1]) : null;
}

function upsertTopicKV(topic, kv) {
  // kv: {k: v}
  let base = (topic ?? '').trim();
  const pairs = base
    ? base.split(';').map(s => s.trim()).filter(Boolean)
    : [];

  const map = new Map();
  for (const p of pairs) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    map.set(p.slice(0, idx).trim(), p.slice(idx + 1).trim());
  }

  for (const [k, v] of Object.entries(kv)) {
    map.set(k, String(v));
  }

  // 保持順序大致可讀
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function registerCommands() {
  const cmd = new SlashCommandBuilder()
    .setName('panel')
    .setDescription('在此頻道發送客服工單面板（管理員用）');

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, GUILD_ID),
    { body: [cmd.toJSON()] }
  );
}

async function ensureNoOpenTicket(guild, userId) {
  const chans = await guild.channels.fetch();
  return chans.find(ch =>
    ch?.type === ChannelType.GuildText &&
    ch?.topic?.includes(`ticket_owner=${userId}`) &&
    ch?.topic?.includes('ticket_status=open')
  );
}

async function closeTicket(channel, closedByUserId = null) {
  if (!channel?.topic?.includes('ticket_owner=')) return;

  // 清掉自動關閉計時器
  clearTimer(closeTimers, channel.id);

  const topic = channel.topic ?? '';
  const ownerId = topic.match(/ticket_owner=(\d+)/)?.[1];

  // 設定狀態 closed + 記錄關閉時間
  const newTopic = upsertTopicKV(topic, {
    ticket_status: 'closed',
    ticket_closed_at: Date.now(),
  });
  await channel.setTopic(newTopic).catch(() => {});

  // 讓 owner 不能再發言（但仍可看）
  if (ownerId) {
    await channel.permissionOverwrites.edit(ownerId, { SendMessages: false }).catch(() => {});
  }

  const who = closedByUserId ? `<@${closedByUserId}>` : '系統';
  await channel.send({ content: `✅ 工單已關閉（由 ${who}）。` }).catch(() => {});

  // 排程自動刪除
  scheduleAutoDelete(channel);
}

function scheduleAutoDelete(channel) {
  clearTimer(deleteTimers, channel.id);

  // 0 表示不刪
  if (!AUTO_DELETE_MS || AUTO_DELETE_MS <= 0) return;

  const topic = channel.topic ?? '';
  const closedAt = parseTopicValue(topic, 'ticket_closed_at') ?? Date.now();
  const deleteAt = closedAt + AUTO_DELETE_MS;

  // 把 deleteAt 寫進 topic，重啟也能補排程
  channel.setTopic(upsertTopicKV(topic, { ticket_delete_at: deleteAt })).catch(() => {});

  const delay = Math.max(1000, deleteAt - Date.now());
  const t = setTimeout(async () => {
    try {
      await channel.send('🧹 此工單將自動刪除以保持整潔。').catch(() => {});
      await channel.delete('Auto delete closed ticket').catch(() => {});
    } finally {
      deleteTimers.delete(channel.id);
    }
  }, delay);

  deleteTimers.set(channel.id, t);
}

function scheduleAutoClose(channel) {
  clearTimer(closeTimers, channel.id);

  const topic = channel.topic ?? '';
  const createdAt = parseTopicValue(topic, 'ticket_created_at') ?? Date.now();
  const closeAt = parseTopicValue(topic, 'ticket_close_at') ?? (createdAt + AUTO_CLOSE_MS);

  // 把 closeAt 寫進 topic
  channel.setTopic(upsertTopicKV(topic, { ticket_close_at: closeAt })).catch(() => {});

  const delay = Math.max(1000, closeAt - Date.now());

  // 提前 5 分鐘提醒（如果時間夠）
  const warnMs = 5 * 60_000;
  const warnDelay = closeAt - warnMs - Date.now();
  if (warnDelay > 1000) {
    setTimeout(() => {
      channel.send(`⏰ 提醒：此工單將於約 **5 分鐘後** 自動關閉（無需再回覆可忽略）。`).catch(() => {});
    }, warnDelay);
  }

  const t = setTimeout(async () => {
    try {
      // 如果已經不是 open 就不處理
      if (!channel.topic?.includes('ticket_status=open')) return;
      await channel.send('⏳ 此工單已超時，系統將自動關閉。如需再協助請重新開票。').catch(() => {});
      await closeTicket(channel, null);
    } finally {
      closeTimers.delete(channel.id);
    }
  }, delay);

  closeTimers.set(channel.id, t);
}

async function createTicketChannel(guild, member, categoryValue) {
  const opt = TICKET_OPTIONS.find(o => o.value === categoryValue);
  const safeName = member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'user';
  const name = `ticket-${safeName}`;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: member.id, allow: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.AttachFiles,
      PermissionsBitField.Flags.EmbedLinks,
    ]},
    { id: SUPPORT_ROLE_ID, allow: [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.ManageMessages,
      PermissionsBitField.Flags.ManageChannels,
    ]},
  ];

  const createdAt = Date.now();
  const closeAt = createdAt + AUTO_CLOSE_MS;

  const topic = [
    `ticket_owner=${member.id}`,
    `ticket_type=${categoryValue}`,
    `ticket_status=open`,
    `ticket_created_at=${createdAt}`,
    `ticket_close_at=${closeAt}`,
  ].join('; ');

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID || null,
    topic,
    permissionOverwrites: overwrites,
  });

  const descLines = [
    '請依序提供以下資訊，客服會更快處理：',
    '1) 訂單編號（或付款資訊）',
	'',
    '2) 問題截圖/錄影（如有）',
	'',
    '3) 你的需求描述（越清楚越好）',
    '',
    `⏱️ **${Math.round(AUTO_CLOSE_MS / 60000)} 分鐘**內若未完成處理，系統會自動關閉工單。`,
  ];

  const guideLinks = makeGuideLinks();
  if (guideLinks) descLines.push('', guideLinks);

  const intro = new EmbedBuilder()
    .setTitle(`客服工單：${opt?.label ?? categoryValue}`)
    .setDescription(descLines.join('\n'));

  if (PANEL_LOGO_URL) intro.setThumbnail(PANEL_LOGO_URL);

  await channel.send({
    content: `<@${member.id}> <@&${SUPPORT_ROLE_ID}>`,
    embeds: [intro],
    components: makeCloseButtonRow(),
  });

  // 排程自動關閉
  scheduleAutoClose(channel);

  return channel;
}

async function rescheduleAllTickets() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const chans = await guild.channels.fetch();

  const ticketChannels = chans.filter(ch =>
    ch?.type === ChannelType.GuildText &&
    ch?.topic?.includes('ticket_owner=')
  );

  for (const ch of ticketChannels.values()) {
    // open -> 排程自動關閉
    if (ch.topic?.includes('ticket_status=open')) {
      scheduleAutoClose(ch);
    }

    // closed -> 排程自動刪除（如果有設定 delete）
    if (ch.topic?.includes('ticket_status=closed')) {
      const deleteAt = parseTopicValue(ch.topic, 'ticket_delete_at');
      const closedAt = parseTopicValue(ch.topic, 'ticket_closed_at');

      // 如果沒有 deleteAt 但有 closedAt，補上 deleteAt 後排程
      if (!deleteAt && closedAt && AUTO_DELETE_MS > 0) {
        scheduleAutoDelete(ch);
      } else if (deleteAt && AUTO_DELETE_MS > 0) {
        // 直接照 deleteAt 排
        scheduleAutoDelete(ch);
      }
    }
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
    console.log('✅ Slash commands registered');
  } catch (e) {
    console.error('❌ Register commands failed:', e);
  }

  // 啟動後補排程（避免重啟後計時失效）
  try {
    await rescheduleAllTickets();
    console.log('✅ Ticket timers rescheduled');
  } catch (e) {
    console.error('❌ Reschedule failed:', e);
  }
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'panel') {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return i.reply({ content: '你沒有權限使用此指令。', ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle('客服服務｜專人處理')
        .setDescription('請在下方選擇服務項目，系統將自動建立客服工單頻道。');

      if (PANEL_LOGO_URL) embed.setThumbnail(PANEL_LOGO_URL);

      return i.reply({ embeds: [embed], components: makePanelComponents() });
    }

    if (i.isStringSelectMenu() && i.customId === 'ticket_select') {
      await i.deferReply({ ephemeral: true });

      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(i.user.id);

      const existing = await ensureNoOpenTicket(guild, i.user.id);
      if (existing) {
        return i.editReply({ content: `你已經有一張未關閉工單：<#${existing.id}>` });
      }

      const categoryValue = i.values?.[0];
      const channel = await createTicketChannel(guild, member, categoryValue);

      return i.editReply({ content: `✅ 已建立工單：<#${channel.id}>` });
    }

    if (i.isButton() && i.customId === 'ticket_close') {
      const ch = i.channel;
      if (!ch?.topic?.includes('ticket_owner=')) {
        return i.reply({ content: '這不是工單頻道。', ephemeral: true });
      }

      const isAdmin = i.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
      const isSupport = i.member?.roles?.cache?.has(SUPPORT_ROLE_ID);
      const ownerId = ch.topic.match(/ticket_owner=(\d+)/)?.[1];
      const isOwner = ownerId && i.user.id === ownerId;

      if (!isAdmin && !isSupport && !isOwner) {
        return i.reply({ content: '你沒有權限關閉此工單。', ephemeral: true });
      }

      await i.reply({ content: '✅ 正在關閉工單…', ephemeral: true });
      await closeTicket(ch, i.user.id);
    }
  } catch (e) {
    console.error(e);
    if (i.deferred || i.replied) {
      i.editReply({ content: '❌ 發生錯誤，請稍後再試。' }).catch(() => {});
    } else {
      i.reply({ content: '❌ 發生錯誤，請稍後再試。', ephemeral: true }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN).catch(console.error);
