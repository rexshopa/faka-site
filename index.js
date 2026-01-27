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
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelType,
} from "discord.js";

// =====================
// ENV
// =====================
const {
  // core
  DISCORD_TOKEN,
  GUILD_ID,
  PORT,

  // Website (會員綁定/更新)
  SITE_BASE_URL, // https://rexcheat.com
  API_SECRET, // Header: X-API-Secret

  // Member Roles + thresholds
  ROLE_MEMBER_ID,
  ROLE_VIP_ID,
  ROLE_SUPREME_ID,
  THRESHOLD_MEMBER,
  THRESHOLD_VIP,
  THRESHOLD_SUPREME,

  // Ticket system
  SUPPORT_ROLE_ID,
  TICKET_CATEGORY_ID,
  PANEL_LOGO_URL,
  GUIDE_CHANNEL_ID,
  STATUS_CHANNEL_ID,
  UPDATE_CHANNEL_ID,
  AUTO_CLOSE_MINUTES,
  AUTO_DELETE_AFTER_CLOSE_MINUTES,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error("❌ Missing env: DISCORD_TOKEN / GUILD_ID");
  process.exit(1);
}
if (!SITE_BASE_URL || !API_SECRET) {
  console.error("❌ Missing env: SITE_BASE_URL / API_SECRET (會員功能需要)");
  process.exit(1);
}
if (!SUPPORT_ROLE_ID) {
  console.error("❌ Missing env: SUPPORT_ROLE_ID (客服單需要)");
  process.exit(1);
}

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// =====================
// Discord client (minimal intents to avoid disallowed intents)
// =====================
// ✅ 不用 GuildMembers / GuildMessages，避免被卡 privileged intents
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});
// =====================
// API: WP 呼叫來同步身分組
// =====================
app.post("/sync-role", async (req, res) => {
  try {
    const { discordUserId, totalSpent } = req.body || {};
    if (!discordUserId) {
      return res.status(400).json({ ok: false, error: "missing discordUserId" });
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member) {
      return res.status(404).json({ ok: false, error: "member_not_found" });
    }

    const spent = Number(totalSpent ?? 0);

    const tMem = Number(THRESHOLD_MEMBER ?? 0);
    const tVip = Number(THRESHOLD_VIP ?? 4000);
    const tSup = Number(THRESHOLD_SUPREME ?? 10000);

    let targetRole = null;
    if (spent >= tSup) targetRole = ROLE_SUPREME_ID;
    else if (spent >= tVip) targetRole = ROLE_VIP_ID;
    else targetRole = ROLE_MEMBER_ID;

    const tierRoles = [ROLE_MEMBER_ID, ROLE_VIP_ID, ROLE_SUPREME_ID];

    for (const rid of tierRoles) {
      if (rid !== targetRole && member.roles.cache.has(rid)) {
        await member.roles.remove(rid).catch(() => {});
      }
    }

    if (!member.roles.cache.has(targetRole)) {
      await member.roles.add(targetRole);
    }

    return res.json({ ok: true, targetRoleId: targetRole });
  } catch (e) {
    console.error("sync-role error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});


// =====================
// Web server for Koyeb healthcheck
// =====================
const app = express();
app.get("/", (req, res) => res.status(200).send("OK"));

// =====================
// Website endpoints (WordPress API)
// =====================
const WP_LINK_ENDPOINT = "/wp-json/rex/v1/discord/link";
const WP_REFRESH_ENDPOINT = "/wp-json/rex/v1/discord/refresh";

function toApiUrl(path) {
  const base = String(SITE_BASE_URL).replace(/\/$/, "");
  const p = String(path).startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Secret": API_SECRET,
    },
    body: JSON.stringify(body ?? {}),
  });

  let data = null;
  try {
    data = await r.json();
  } catch {
    data = { ok: false, error: "invalid_json_response" };
  }

  if (!r.ok || !data?.ok) {
    const msg = data?.error || `http_${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.data = data;
    throw err;
  }

  return data;
}

// =====================
// Member tier role logic
// =====================
function pickTierRole(totalSpent) {
  const spent = Number(totalSpent ?? 0);

  const tMem = Number(THRESHOLD_MEMBER ?? 0);
  const tVip = Number(THRESHOLD_VIP ?? 4000);
  const tSup = Number(THRESHOLD_SUPREME ?? 10000);

  if (ROLE_SUPREME_ID && spent >= tSup) return ROLE_SUPREME_ID;
  if (ROLE_VIP_ID && spent >= tVip) return ROLE_VIP_ID;
  if (ROLE_MEMBER_ID && spent >= tMem) return ROLE_MEMBER_ID;
  return null;
}

async function applyTierRoles(guild, discordUserId, totalSpent) {
  const targetRoleId = pickTierRole(totalSpent);
  if (!targetRoleId) return { ok: false, error: "no_tier_role_matched" };

  const member = await guild.members.fetch(discordUserId).catch(() => null);
  if (!member) return { ok: false, error: "member_not_found_in_guild" };

  const tierRoles = [ROLE_MEMBER_ID, ROLE_VIP_ID, ROLE_SUPREME_ID].filter(Boolean);

  for (const rid of tierRoles) {
    if (rid !== targetRoleId && member.roles.cache.has(rid)) {
      await member.roles.remove(rid).catch(() => {});
    }
  }
  if (!member.roles.cache.has(targetRoleId)) {
    await member.roles.add(targetRoleId).catch(() => {});
  }

  return { ok: true, targetRoleId };
}

// =====================
// Member UI (徽章 + 面板)
// =====================
const EMO_MEMBER  = "<:rex_badge_blue:1465290780267511832>";
const EMO_VIP     = "<:rex_badge_purple:1465291084061216886>";
const EMO_SUPREME = "<:badge_no_white:1465292714185855057>";

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildMemberPanelText() {
  const tMem = toNum(THRESHOLD_MEMBER, 0);
  const tVip = toNum(THRESHOLD_VIP, 4000);
  const tSup = toNum(THRESHOLD_SUPREME, 10000);

  return [
    "【👑 **會員獲得門檻**】",
	"",
    `${EMO_MEMBER}  **會員**（消費額達 **${tMem} 元**）`,
    `${EMO_VIP}  **黃金會員**（消費額達 **${tVip} 元**）`,
    `${EMO_SUPREME}  **尊爵會員**（消費額達 **${tSup} 元**）`,
    "",
    "**【💎 會員福利折扣】**",
    "",
    `**${EMO_MEMBER}  會員**`,
    "1. 參加抽獎活動",
    "2. 聊天大廳",
    "",
    `**${EMO_VIP}  黃金會員**`,
    "1. 參加抽獎活動",
    "2. 全館商品最高 **9 折** 優惠",
    "3. 一般抽獎增加 **2 倍機率**",
    "4. 參加專屬會員抽獎活動",
    "",
    `**${EMO_SUPREME}  尊爵會員**`,
    "1. 參加抽獎活動",
    "2. 全館商品最高 **8 折** 優惠",
    "3. 一般抽獎增加 **4 倍機率**",
    "4. 參加專屬會員抽獎活動",
    "5. 會員專屬抽獎增加 **1 倍機率**",
    "6. 客服優先服務",
    "7. 每月兩次免費遠端服務",
    "8. 不定時免費卡號",
    "",
    "⬇️ 請點擊下方 **【獲取會員】** 連接官網會員 ⬇️",
  ].join("\n");
}

function makeMemberPanelRow() {
  const getBtn = new ButtonBuilder()
    .setCustomId("member_get")
    .setLabel("獲取會員")
    .setStyle(ButtonStyle.Primary);

  const refreshBtn = new ButtonBuilder()
    .setCustomId("member_refresh")
    .setLabel("更新會員狀態")
    .setStyle(ButtonStyle.Success);

  return [new ActionRowBuilder().addComponents(getBtn, refreshBtn)];
}

function buildMemberGetModal() {
  const modal = new ModalBuilder()
    .setCustomId("member_get_modal")
    .setTitle("輸入官網註冊信箱");

  const email = new TextInputBuilder()
    .setCustomId("email")
    .setLabel("官網註冊 Email（只可綁定一次）")
    .setPlaceholder("example@gmail.com")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(email));
  return modal;
}


// =====================
// Ticket system (不靠訊息事件，避免 intents 問題)
// =====================
const AUTO_CLOSE_MS = Math.max(1, Number(AUTO_CLOSE_MINUTES ?? 60)) * 60_000;
const AUTO_DELETE_MS = Math.max(0, Number(AUTO_DELETE_AFTER_CLOSE_MINUTES ?? 10)) * 60_000;

const closeTimers = new Map();  // channelId -> timeout
const deleteTimers = new Map(); // channelId -> timeout

const TICKET_OPTIONS = [
  { label: "售前問題", value: "pre_sale", description: "購買/付款/商品諮詢等" },
  { label: "售後問題", value: "after_sale", description: "商品使用/遠端/售後問題" },
  { label: "訂單領取", value: "order_pickup", description: "訂單領取卡密/檔案" },
  { label: "卡密解綁", value: "unbind", description: "更換設備/重灌需解綁" },
  { label: "參數調整服務", value: "tuning", description: "AI自瞄參數調整(需先購買)" },
  { label: "人工解碼服務", value: "decode", description: "解機碼/人工處理" },
];

function makeTicketPanelComponents() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("ticket_select")
    .setPlaceholder("選擇服務項目｜系統將自動建立工單")
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
  const base = (topic ?? "").trim();
  const pairs = base ? base.split(";").map((s) => s.trim()).filter(Boolean) : [];

  const map = new Map();
  for (const p of pairs) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    map.set(p.slice(0, idx).trim(), p.slice(idx + 1).trim());
  }
  for (const [k, v] of Object.entries(kv)) map.set(k, String(v));

  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function ensureNoOpenTicket(guild, userId) {
  const chans = await guild.channels.fetch();
  return chans.find(
    (ch) =>
      ch?.type === ChannelType.GuildText &&
      ch?.topic?.includes(`ticket_owner=${userId}`) &&
      ch?.topic?.includes("ticket_status=open")
  );
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
    await channel.permissionOverwrites.edit(ownerId, { SendMessages: false }).catch(() => {});
  }

  const who = closedByUserId ? `<@${closedByUserId}>` : "系統";
  await channel.send({ content: `✅ 工單已關閉（由 ${who}）。` }).catch(() => {});

  scheduleAutoDelete(channel);
}

function scheduleAutoClose(channel) {
  clearTimer(closeTimers, channel.id);

  const topic = channel.topic ?? "";
  const createdAt = parseTopicValue(topic, "ticket_created_at") ?? Date.now();
  const closeAt = parseTopicValue(topic, "ticket_close_at") ?? (createdAt + AUTO_CLOSE_MS);

  channel.setTopic(upsertTopicKV(topic, { ticket_close_at: closeAt })).catch(() => {});

  const delay = Math.max(1000, closeAt - Date.now());
  const t = setTimeout(async () => {
    try {
      if (!channel.topic?.includes("ticket_status=open")) return;
      await channel.send("⏳ 此工單已超時，系統將自動關閉。如需再協助請重新開票。").catch(() => {});
      await closeTicket(channel, null);
    } finally {
      closeTimers.delete(channel.id);
    }
  }, delay);

  closeTimers.set(channel.id, t);
}

async function createTicketChannel(guild, member, categoryValue) {
  const opt = TICKET_OPTIONS.find((o) => o.value === categoryValue);
  const safeName =
    member.user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "user";
  const name = `ticket-${safeName}`;

  const createdAt = Date.now();
  const closeAt = createdAt + AUTO_CLOSE_MS;

  const topic = [
    `ticket_owner=${member.id}`,
    `ticket_type=${categoryValue}`,
    `ticket_status=open`,
    `ticket_created_at=${createdAt}`,
    `ticket_close_at=${closeAt}`,
  ].join("; ");

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: member.id,
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
    "2) 問題截圖/錄影（如有）",
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
    content: `<@${member.id}> <@&${SUPPORT_ROLE_ID}>`,
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
    if (ch.topic?.includes("ticket_status=closed")) scheduleAutoDelete(ch);
  }
}

// =====================
// Slash commands
// =====================
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName("memberpanel")
      .setDescription("發送會員綁定/更新面板（管理員用）"),
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("發送客服工單面板（管理員用）"),
  ];

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: cmds.map((c) => c.toJSON()),
  });
}

// =====================
// Events
// =====================
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const listenPort = Number(PORT || 8000);
  app.listen(listenPort, () => console.log(`✅ Web API listening on :${listenPort}`));

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
    console.error("❌ Ticket reschedule failed:", e);
  }
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    // =====================
    // /memberpanel
    // =====================
    if (i.isChatInputCommand() && i.commandName === "memberpanel") {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return i.reply({ content: "你沒有權限使用此指令。", ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle("REX 輔助商城｜會員系統")
        .setDescription(buildMemberPanelText());

      return i.reply({ content: buildMemberPanelText(), components: makeMemberPanelRow() });
    }

    // member_get -> modal
    if (i.isButton() && i.customId === "member_get") {
      return i.showModal(buildMemberGetModal());
    }

    // modal submit -> link
    if (i.isModalSubmit() && i.customId === "member_get_modal") {
      await i.deferReply({ ephemeral: true });

      const email = (i.fields.getTextInputValue("email") || "").trim().toLowerCase();
      if (!email.includes("@") || email.length < 6) {
        return i.editReply("❌ Email 格式不正確，請重新點【獲取會員】再輸入。");
      }

      const url = toApiUrl(WP_LINK_ENDPOINT);
      const data = await postJson(url, { discordUserId: i.user.id, email });

      const totalSpent = Number(data.totalSpent ?? 0);
      const guild = await client.guilds.fetch(GUILD_ID);

      const applied = await applyTierRoles(guild, i.user.id, totalSpent);
      if (!applied.ok) {
        return i.editReply(`❌ 綁定成功，但更新身分組失敗：${applied.error}`);
      }

      return i.editReply(`✅ 綁定成功！已同步累積消費 **${totalSpent}**，身分組已更新。`);
    }

    // member_refresh
    if (i.isButton() && i.customId === "member_refresh") {
      await i.deferReply({ ephemeral: true });

      const url = toApiUrl(WP_REFRESH_ENDPOINT);
      const data = await postJson(url, { discordUserId: i.user.id });

      const totalSpent = Number(data.totalSpent ?? 0);
      const guild = await client.guilds.fetch(GUILD_ID);

      const applied = await applyTierRoles(guild, i.user.id, totalSpent);
      if (!applied.ok) {
        return i.editReply(`❌ 更新失敗：${applied.error}`);
      }

      return i.editReply(`✅ 已更新！目前累積消費 **${totalSpent}**，身分組已同步。`);
    }

    // =====================
    // /panel (ticket)
    // =====================
    if (i.isChatInputCommand() && i.commandName === "panel") {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return i.reply({ content: "你沒有權限使用此指令。", ephemeral: true });
      }

      const lines = [
        "請在下方選擇服務項目，系統將自動建立客服工單頻道。",
      ];
      const links = makeGuideLinks();
      if (links) lines.push("", links);

      const embed = new EmbedBuilder()
        .setTitle("客服服務｜專人處理")
        .setDescription(lines.join("\n"));

      if (PANEL_LOGO_URL) embed.setThumbnail(PANEL_LOGO_URL);

      return i.reply({ embeds: [embed], components: makeTicketPanelComponents() });
    }

    // ticket_select
    if (i.isStringSelectMenu() && i.customId === "ticket_select") {
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

    // ticket_close
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
    const msg = `❌ 發生錯誤：${e?.message || "請稍後再試"}`;
    if (i.deferred || i.replied) i.editReply(msg).catch(() => {});
    else i.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
});

client.login(DISCORD_TOKEN).catch(console.error);
