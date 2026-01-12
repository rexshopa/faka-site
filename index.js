import dotenv from 'dotenv';
dotenv.config({ path: './.env' });

import {
  Client, GatewayIntentBits, Partials, Events,
  SlashCommandBuilder, REST, Routes,
  ChannelType, PermissionsBitField,
  ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder
} from 'discord.js';

const {
  DISCORD_TOKEN, GUILD_ID, SUPPORT_ROLE_ID, TICKET_CATEGORY_ID,
  PANEL_LOGO_URL, GUIDE_CHANNEL_ID, STATUS_CHANNEL_ID, UPDATE_CHANNEL_ID,
  AUTO_CLOSE_MINUTES, AUTO_DELETE_AFTER_CLOSE_MINUTES
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !SUPPORT_ROLE_ID) {
  console.error('❌ Missing env: DISCORD_TOKEN / GUILD_ID / SUPPORT_ROLE_ID');
  process.exit(1);
}

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

const AUTO_CLOSE_MINS = Number(AUTO_CLOSE_MINUTES || 0); // 0 = 不自動關閉
const AUTO_DELETE_AFTER_CLOSE_MINS = Number(AUTO_DELETE_AFTER_CLOSE_MINUTES || 0); // 0 = 不自動刪除

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
    !ch?.topic?.includes('ticket_status=closed')
  );
}

function isValidSnowflake(id) {
  return typeof id === 'string' && /^[0-9]{17,20}$/.test(id);
}

async function closeTicketChannel(channel, closedBy = 'system') {
  if (!channel?.topic?.includes('ticket_owner=')) return;

  const ownerId = channel.topic.match(/ticket_owner=(\d+)/)?.[1];

  // 標記關閉
  if (channel.topic.includes('ticket_status=open')) {
    await channel.setTopic(channel.topic.replace('ticket_status=open', 'ticket_status=closed'));
  }

  // 鎖住工單本人發言（保留查看）
  if (ownerId) {
    await channel.permissionOverwrites.edit(ownerId, { SendMessages: false });
  }

  await channel.send(`✅ 工單已關閉（by ${closedBy}）。如需協助請重新開票。`);

  // 可選：延遲刪除
  if (AUTO_DELETE_AFTER_CLOSE_MINS > 0) {
    setTimeout(() => {
      channel.delete('Ticket auto deleted after close').catch(() => {});
    }, AUTO_DELETE_AFTER_CLOSE_MINS * 60 * 1000);
  }
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
    ]},
  ];

  const parent = isValidSnowflake(TICKET_CATEGORY_ID) ? TICKET_CATEGORY_ID : null;

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent,
    topic: `ticket_owner=${member.id}; ticket_type=${categoryValue}; ticket_status=open`,
    permissionOverwrites: overwrites,
  });

  const intro = new EmbedBuilder()
    .setTitle(`客服工單：${opt?.label ?? categoryValue}`)
    .setDescription(
      [
        '請依序提供以下資訊，客服會更快處理：',
        '1) 訂單編號（或付款資訊）',
		'',
        '2) 問題截圖/錄影（如有）',
		'',
        '3) 你的需求描述（越清楚越好）',
        '',
        '📌 注意：請勿在工單內公開敏感資訊（例如完整付款帳密）。'
      ].join('\n')
    );

  await channel.send({
    content: `<@${member.id}> <@&${SUPPORT_ROLE_ID}>`,
    embeds: [intro],
    components: makeCloseButtonRow(),
  });

  // 置頂提示（Pin）
  const pinned = await channel.send('📌 **請先貼上：訂單號 / 問題描述 / 截圖（如有）**，客服會更快處理。');
  await pinned.pin().catch(() => {});

  // 自動關閉（從建立開始算）
  if (AUTO_CLOSE_MINS > 0) {
    setTimeout(() => {
      closeTicketChannel(channel, 'auto-close').catch(() => {});
    }, AUTO_CLOSE_MINS * 60 * 1000);
  }

  return channel;
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
    console.log('✅ Slash commands registered');
  } catch (e) {
    console.error('❌ Register commands failed:', e);
  }
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    // /panel
    if (i.isChatInputCommand() && i.commandName === 'panel') {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return i.reply({ content: '你沒有權限使用此指令。', ephemeral: true });
      }

      const guide = GUIDE_CHANNEL_ID ? `<#${GUIDE_CHANNEL_ID}>` : '（未設定）';
      const status = STATUS_CHANNEL_ID ? `<#${STATUS_CHANNEL_ID}>` : '（未設定）';
      const updates = UPDATE_CHANNEL_ID ? `<#${UPDATE_CHANNEL_ID}>` : '（未設定）';

      const embed = new EmbedBuilder()
        .setTitle('客服服務｜專人處理')
        .setDescription(
          [
            `💰 **購買方式**：${guide}`,
			'',
            `🚦 **輔助狀態**：${status}`,
			'',
            `📩 **更新公告**：${updates}`,
            '',
            '請在下方選擇服務項目，系統將自動建立 **客服工單頻道**。',
          ].join('\n')
        );

      if (PANEL_LOGO_URL) embed.setThumbnail(PANEL_LOGO_URL);

      return i.reply({ embeds: [embed], components: makePanelComponents() });
    }

    // 下拉選單：開票
    if (i.isStringSelectMenu() && i.customId === 'ticket_select') {
      await i.deferReply({ ephemeral: true });

      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(i.user.id);

      const existing = await ensureNoOpenTicket(guild, i.user.id);
      if (existing) {
        return i.editReply({ content: `你已經有一張未關閉工單：<#${existing.id}>` });
      }

      const categoryValue = i.values?.[0];

      try {
        const channel = await createTicketChannel(guild, member, categoryValue);
        return i.editReply({ content: `✅ 已建立工單：<#${channel.id}>` });
      } catch (err) {
        console.error('❌ createTicketChannel failed:', err);
        const msg =
          err?.rawError?.errors?.parent_id?._errors?.[0]?.message ||
          err?.rawError?.message ||
          err?.message ||
          String(err);
        return i.editReply({ content: `❌ 開票失敗：${msg}`.slice(0, 1800) });
      }
    }

    // 關閉按鈕
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

      await closeTicketChannel(ch, i.user.tag);
      return i.reply({ content: '✅ 已關閉此工單。', ephemeral: true });
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
