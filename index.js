import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import express from "express";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

// ========= ENV =========
const {
  // discord
  DISCORD_TOKEN,
  GUILD_ID,
  SUPPORT_ROLE_ID,
  TICKET_CATEGORY_ID,

  // panel
  PANEL_LOGO_URL,
  GUIDE_CHANNEL_ID,
  STATUS_CHANNEL_ID,
  UPDATE_CHANNEL_ID,

  // ticket timers
  AUTO_CLOSE_MINUTES,
  AUTO_DELETE_AFTER_CLOSE_MINUTES,

  // web api
  PORT,
  API_SECRET,

  // tier roles
  ROLE_MEMBER_ID,
  ROLE_VIP_ID,
  ROLE_SUPREME_ID,
  THRESHOLD_MEMBER,
  THRESHOLD_VIP,
  THRESHOLD_SUPREME,

  // website links
  SITE_BASE_URL,
  MEMBER_CONNECT_PATH,
  MEMBER_REFRESH_PATH,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !SUPPORT_ROLE_ID) {
  console.error("❌ Missing env: DISCORD_TOKEN / GUILD_ID / SUPPORT_ROLE_ID");
  process.exit(1);
}

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// ========= Timers =========
const AUTO_CLOSE_MS = Math.max(1, Number(AUTO_CLOSE_MINUTES ?? 60)) * 60_000;
const AUTO_DELETE_MS =
  Math.max(0, Number(AUTO_DELETE_AFTER_CLOSE_MINUTES ?? 10)) * 60_000;

const closeTimers = new Map(); // channelId -> timeout
const deleteTimers = new Map(); // channelId -> timeout

function clearTimer(map, channelId) {
  const t = map.get(channelId);
  if (t) clearTimeout(t);
  map.delete(channelId);
}

function parseTopicValue(topic, key) {
  const m = topic?.match(new RegExp(`${key}=(\\d+)`));
  return m ? Number(m[1]) : null;
}

function upsertTopicKV(topic, kv) {
  let base = (topic ?? "").trim();
  const pairs = base ? base.split(";").map((s) => s.trim()).filter(Boolean) : [];

  const map = new Map();
  for (const p of pairs) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    map.set(p.slice(0, idx).trim(), p.slice(idx + 1).trim());
  }

  for (const [k, v] of Object.entries(kv)) {
    map.set(k, String(v));
  }

  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// ========= Discord Client =========
// ✅ 用最少 intents，避免 Used disallowed intents
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

// ========= Web API (WooCommerce sync) =========
const app = express();
app.use(express.json());

function auth(req, res, next) {
  const secret = req.header("X-API-Secret");
  if (!API_SECRET || secret !== API_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function pickTierRole(totalSpent) {
  const spent = Number(totalSpent ?? 0);

  const tSup = Number(THRESHOLD_SUPREME ?? 10000);
  const tVip = Number(THRESHOLD_VIP ?? 4000);
  const tMem = Number(THRESHOLD_MEMBER ?? 0);

  if (ROLE_SUPREME_ID && spent >= tSup) return ROLE_SUPREME_ID;
  if (ROLE_VIP_ID && spent >= tVip) return ROLE_VIP_ID;
  if (ROLE_MEMBER_ID && spent >= tMem) return ROLE_MEMBER_ID;

  return null;
}

// 官網呼叫：帶 discordUserId + totalSpent（累積消費）
app.post("/sync-role", auth, async (req, res) => {
  try {
    const { discordUserId, totalSpent } = req.body || {};
    if (!discordUserId)
      return res.status(400).json({ ok: false, error: "missing discordUserId" });

    const targetRoleId = pickTierRole(totalSpent);
    if (!targetRoleId)
      return res.status(400).json({ ok: false, error: "no tier role matched" });

    const guild = await client.guilds.fetch(GUILD_ID);

    // ✅ 不依賴 GuildMembers intent：直接 fetch 成員（走 REST）
    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member)
      return res.status(404).json({ ok: false, error: "member not found in guild" });

    const tierRoles = [ROLE_MEMBER_ID, ROLE_VIP_ID, ROLE_SUPREME_ID].filter(Boolean);

    // 先移除其他階級
    for (const rid of tierRoles) {
      if (rid !== targetRoleId && member.roles.cache.has(rid)) {
        await member.roles.remove(rid).catch(() => {});
      }
    }
    // 再加入目標階級
    if (!member.roles.cache.has(targetRoleId)) {
      await member.roles.add(targetRoleId).catch(() => {});
    }

    return res.json({ ok: true, targetRoleId });
  } catch (e) {
    console.error("❌ /sync-role error:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});

// health check
app.get("/", (req, res) => res.status(200).send("OK"));

// ========= Ticket Config =========
const TICKET_OPTIONS = [
  { label: "售前問題", value: "pre_sale", description: "購買/付款/商品諮詢等" },
  { label: "售後問題", value: "after_sale", description: "商品使用/遠端/售後問題" },
  { label: "訂單領取", value: "order_pickup", description: "訂單領取卡密/檔案" },
  { label: "卡密解綁", value: "unbind", description: "更換設備/重灌需解綁" },
  { label: "參數調整服務", value: "tuning", description: "AI自瞄參數調整(需先購買)" },
  { label: "人工解碼服務", value: "decode", description: "解機碼/人工處理" },
];

function makePanelComponents() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("ticket_select")
    .setPlaceholder("選擇服務項目｜客服單將於下方開啟")
    .addOptions(
      TICKET_OPTIONS.map((o) => ({
        label: o.label,
        value: o.value,
        description: o.description,
      }))
    );

  return [new ActionRowBuilder().addComponents(menu)];
}

function makeCloseButtonRow() {
  const closeBtn = new ButtonBuilder()
    .setCustomId("ticket_close")
    .setLabel("關閉工單")
    .setStyle(ButtonStyle.Danger);

  return [new ActionRowBuilder().addComponents(closeBtn)];
}

function makeGuideLinks() {
  const lines = [];
  if (GUIDE_CHANNEL_ID) lines.push(`💰 **購買方式**：<#${GUIDE_CHANNEL_ID}>`);
  if (STATUS_CHANNEL_ID) lines.push(`🚦 **輔助狀態**：<#${STATUS_CHANNEL_ID}>`);
  if (UPDATE_CHANNEL_ID) lines.push(`📢 **更新公告**：<#${UPDATE_CHANNEL_ID}>`);
  return lines.length ? lines.join("\n") : null;
}

// ========= Member Panel UI =========
function buildSiteUrl(path, userId) {
  const base = (SITE_BASE_URL || "").replace(/\/$/, "");
  const p = (path || "").startsWith("/") ? path : `/${path || ""}`;

  // ✅ 帶 discordUserId 方便官網接住（官網可不用）
  const u = `${base}${p}`;
  if (!userId) return u;
  const joinChar = u.includes("?") ? "&" : "?";
  return `${u}${joinChar}discordUserId=${encodeURIComponent(userId)}`;
}

function makeMemberPanelRow(userId) {
  const connectUrl = buildSiteUrl(MEMBER_CONNECT_PATH || "/member/connect", userId);
  const refreshUrl = buildSiteUrl(MEMBER_REFRESH_PATH || "/member/refresh", userId);

  // ✅ Link Button：客人按了直接開官網
  const getBtn = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("獲取會員")
    .setURL(connectUrl);

  const refreshBtn = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("更新會員狀態")
    .setURL(refreshUrl);

  return [new ActionRowBuilder().addComponents(getBtn, refreshBtn)];
}

// ========= Slash Commands =========
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("在此頻道發送客服工單面板（管理員用）"),
    new SlashCommandBuilder()
      .setName("memberpanel")
      .setDescription("在此頻道發送會員獲取/更新按鈕（管理員用）"),
  ];

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: cmds.map((c) => c.toJSON()),
  });
}

// ========= Tickets =========
async function ensureNoOpenTicket(guild, userId) {
  const chans = await guild.channels.fetch();
  return chans.find(
    (ch) =>
      ch?.type === ChannelType.GuildText &&
      ch?.topic?.includes(`ticket_owner=${userId}`) &&
      ch?.topic?.includes("ticket_status=open")
  );
}

async function closeTicket(channel, closedByUserId = null) {
  if (!channel?.topic?.includes("ticket_owner=")) return;

  clearTimer(closeTimers, channel.id);

  const topic = channel.topic ?? "";
  const ownerId = topic.match(/ticket_owner=(\d+)/)?.[1];

  const newTopic = upsertTopicKV(topic, {
    ticket_status: "closed",
    ticket_closed_at: Date.now(),
  });
  await channel.setTopic(newTopic).catch(() => {});

  if (ownerId) {
    await channel.permissionOverwrites
      .edit(ownerId, { SendMessages: false })
      .catch(() => {});
  }

  const who = closedByUserId ? `<@${closedByUserId}>` : "系統";
  await channel.send({ content: `✅ 工單已關閉（由 ${who}）。` }).catch(() => {});

  scheduleAutoDelete(channel);
}

function scheduleAutoDelete(channel) {
  clearTimer(deleteTimers, channel.id);

  if (!AUTO_DELETE_MS || AUTO_DELETE_MS <= 0) return;

  const topic = channel.topic ?? "";
  const closedAt = parseTopicValue(topic, "ticket_closed_at") ?? Date.now();
  const deleteAt = closedAt + AUTO_DELETE_MS;

  channel.setTopic(upsertTopicKV(topic, { ticket_delete_at: deleteAt })).catch(() => {});

  const delay = Math.max(1000, deleteAt - Date.now());
  const t = setTimeout(async () => {
    try {
      await channel.send("🧹 此工單將自動刪除以保持整潔。").catch(() => {});
      await channel.delete("Auto delete closed ticket").catch(() => {});
    } finally {
      deleteTimers.delete(channel.id);
    }
  }, delay);

  deleteTimers.set(channel.id, t);
}

function scheduleAutoClose(channel) {
  clearTimer(closeTimers, channel.id);

  const topic = channel.topic ?? "";
  const createdAt = parseTopicValue(topic, "ticket_created_at") ?? Date.now();
  const closeAt = parseTopicValue(topic, "ticket_close_at") ?? createdAt + AUTO_CLOSE_MS;

  channel.setTopic(upsertTopicKV(topic, { ticket_close_at: closeAt })).catch(() => {});

  const delay = Math.max(1000, closeAt - Date.now());

  // 5 分鐘前提醒
  const warnMs = 5 * 60_000;
  const warnDelay = closeAt - warnMs - Date.now();
  if (warnDelay > 1000) {
    setTimeout(() => {
      channel
        .send("⏰ 提醒：此工單將於約 **5 分鐘後** 自動關閉（無需再回覆可忽略）。")
        .catch(() => {});
    }, warnDelay);
  }

  const t = setTimeout(async () => {
    try {
      if (!channel.topic?.includes("ticket_status=open")) return;
      await channel
        .send("⏳ 此工單已超時，系統將自動關閉。如需再協助請重新開票。")
        .catch(() => {});
      await closeTicket(channel, null);
    } finally {
      closeTimers.delete(channel.id);
    }
  }, delay);

  closeTimers.set(channel.id, t);
}

async function createTicketChannel(guild, user, categoryValue) {
  const opt = TICKET_OPTIONS.find((o) => o.value === categoryValue);
  const safeName =
    user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "user";
  const name = `ticket-${safeName}`;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
      ],
    },
    {
      id: SUPPORT_ROLE_ID,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.ManageChannels,
      ],
    },
  ];

  const createdAt = Date.now();
  const closeAt = createdAt + AUTO_CLOSE_MS;

  const topic = [
    `ticket_owner=${user.id}`,
    `ticket_type=${categoryValue}`,
    `ticket_status=open`,
    `ticket_created_at=${createdAt}`,
    `ticket_close_at=${closeAt}`,
  ].join("; ");

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID || null,
    topic,
    permissionOverwrites: overwrites,
  });

  const descLines = [
    "請依序提供以下資訊，客服會更快處理：",
    "1) 訂單編號（或付款資訊）",
    "",
    "2) 問題截圖/錄影（如有）",
    "",
    "3) 你的需求描述（越清楚越好）",
    "",
    `⏱️ **${Math.round(AUTO_CLOSE_MS / 60000)} 分鐘**內若未完成處理，系統會自動關閉工單。`,
  ];

  const guideLinks = makeGuideLinks();
  if (guideLinks) descLines.push("", guideLinks);

  const intro = new EmbedBuilder()
    .setTitle(`客服工單：${opt?.label ?? categoryValue}`)
    .setDescription(descLines.join("\n"));

  if (PANEL_LOGO_URL) intro.setThumbnail(PANEL_LOGO_URL);

  await channel.send({
    content: `<@${user.id}> <@&${SUPPORT_ROLE_ID}>`,
    embeds: [intro],
    components: makeCloseButtonRow(),
  });

  scheduleAutoClose(channel);
  return channel;
}

async function rescheduleAllTickets() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const chans = await guild.channels.fetch();

  const ticketChannels = chans.filter(
    (ch) => ch?.type === ChannelType.GuildText && ch?.topic?.includes("ticket_owner=")
  );

  for (const ch of ticketChannels.values()) {
    if (ch.topic?.includes("ticket_status=open")) scheduleAutoClose(ch);
    if (ch.topic?.includes("ticket_status=closed")) {
      const deleteAt = parseTopicValue(ch.topic, "ticket_delete_at");
      const closedAt = parseTopicValue(ch.topic, "ticket_closed_at");
      if ((!deleteAt && closedAt && AUTO_DELETE_MS > 0) || (deleteAt && AUTO_DELETE_MS > 0)) {
        scheduleAutoDelete(ch);
      }
    }
  }
}

// ========= Events =========
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Web API 一定要開（Web Service 需要 port）
  const listenPort = Number(PORT || 8000);
  app.listen(listenPort, () => {
    console.log(`✅ Web API listening on :${listenPort}`);
  });

  try {
    await registerCommands();
    console.log("✅ Slash commands registered");
  } catch (e) {
    console.error("❌ Register commands failed:", e);
  }

  try {
    await rescheduleAllTickets();
    console.log("✅ Ticket timers rescheduled");
  } catch (e) {
    console.error("❌ Reschedule failed:", e);
  }
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    // ===== /panel 工單面板 =====
    if (i.isChatInputCommand() && i.commandName === "panel") {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return i.reply({ content: "你沒有權限使用此指令。", ephemeral: true });
      }

      const lines = [
        "請在下方選擇服務項目，系統將自動建立客服工單頻道。",
        "",
        `💰 **購買方式**：${GUIDE_CHANNEL_ID ? `<#${GUIDE_CHANNEL_ID}>` : "（未設定）"}`,
        "",
        `🚦 **輔助狀態**：${STATUS_CHANNEL_ID ? `<#${STATUS_CHANNEL_ID}>` : "（未設定）"}`,
        "",
        `📢 **更新公告**：${UPDATE_CHANNEL_ID ? `<#${UPDATE_CHANNEL_ID}>` : "（未設定）"}`,
      ];

      const embed = new EmbedBuilder().setTitle("客服服務｜專人處理").setDescription(lines.join("\n"));
      if (PANEL_LOGO_URL) embed.setThumbnail(PANEL_LOGO_URL);

      return i.reply({ embeds: [embed], components: makePanelComponents() });
    }

    // ===== /memberpanel 會員面板 =====
    if (i.isChatInputCommand() && i.commandName === "memberpanel") {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return i.reply({ content: "你沒有權限使用此指令。", ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle("會員系統｜自助領取/更新")
        .setDescription("請點擊下方【獲取會員】連接官網會員，或按【更新會員狀態】同步你的身分組。");

      if (PANEL_LOGO_URL) embed.setThumbnail(PANEL_LOGO_URL);

      // 這裡放「不帶 userId 的通用按鈕」（所有人都能按）
      const row = makeMemberPanelRow(null);
      return i.reply({ embeds: [embed], components: row });
    }

    // ===== 下拉選單建立工單 =====
    if (i.isStringSelectMenu() && i.customId === "ticket_select") {
      await i.deferReply({ ephemeral: true });

      const guild = await client.guilds.fetch(GUILD_ID);

      const existing = await ensureNoOpenTicket(guild, i.user.id);
      if (existing) return i.editReply({ content: `你已經有一張未關閉工單：<#${existing.id}>` });

      const categoryValue = i.values?.[0];
      const channel = await createTicketChannel(guild, i.user, categoryValue);

      return i.editReply({ content: `✅ 已建立工單：<#${channel.id}>` });
    }

    // ===== 關閉工單按鈕 =====
    if (i.isButton() && i.customId === "ticket_close") {
      const ch = i.channel;
      if (!ch?.topic?.includes("ticket_owner=")) {
        return i.reply({ content: "這不是工單頻道。", ephemeral: true });
      }

      const isAdmin = i.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
      const isSupport = i.member?.roles?.cache?.has(SUPPORT_ROLE_ID);
      const ownerId = ch.topic.match(/ticket_owner=(\d+)/)?.[1];
      const isOwner = ownerId && i.user.id === ownerId;

      if (!isAdmin && !isSupport && !isOwner) {
        return i.reply({ content: "你沒有權限關閉此工單。", ephemeral: true });
      }

      await i.reply({ content: "✅ 正在關閉工單…", ephemeral: true });
      await closeTicket(ch, i.user.id);
      return;
    }
  } catch (e) {
    console.error(e);
    if (i.deferred || i.replied) {
      i.editReply({ content: "❌ 發生錯誤，請稍後再試。" }).catch(() => {});
    } else {
      i.reply({ content: "❌ 發生錯誤，請稍後再試。", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN).catch(console.error);
