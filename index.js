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
} from "discord.js";

// =====================
// ENV
// =====================
const {
  DISCORD_TOKEN,
  GUILD_ID,

  // Website
  SITE_BASE_URL, // https://rexcheat.com
  API_SECRET, // 和官網 API 共同的密鑰

  // Roles
  ROLE_MEMBER_ID,
  ROLE_VIP_ID,
  ROLE_SUPREME_ID,
  THRESHOLD_MEMBER,
  THRESHOLD_VIP,
  THRESHOLD_SUPREME,

  // Web Service port for Koyeb healthcheck
  PORT,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !SITE_BASE_URL || !API_SECRET) {
  console.error("❌ Missing env: DISCORD_TOKEN / GUILD_ID / SITE_BASE_URL / API_SECRET");
  process.exit(1);
}

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// =====================
// Discord client (minimal intents)
// =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

// =====================
// Web server for healthcheck
// =====================
const app = express();
app.get("/", (req, res) => res.status(200).send("OK"));

function toApiUrl(path) {
  const base = SITE_BASE_URL.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

// 官網 WordPress API（下面我會給你 code snippets）
// - POST /wp-json/rex/v1/discord/link
// - POST /wp-json/rex/v1/discord/refresh
const WP_LINK_ENDPOINT = "/wp-json/rex/v1/discord/link";
const WP_REFRESH_ENDPOINT = "/wp-json/rex/v1/discord/refresh";

async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Secret": API_SECRET,
    },
    body: JSON.stringify(body),
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
// Tier role logic
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

  // remove other tiers
  for (const rid of tierRoles) {
    if (rid !== targetRoleId && member.roles.cache.has(rid)) {
      await member.roles.remove(rid).catch(() => {});
    }
  }
  // add target tier
  if (!member.roles.cache.has(targetRoleId)) {
    await member.roles.add(targetRoleId);
  }

  return { ok: true, targetRoleId };
}

// =====================
// UI builders
// =====================
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
// Slash commands
// =====================
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName("memberpanel")
      .setDescription("發送會員綁定/更新面板（管理員用）"),
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
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    // /memberpanel (admin only)
    if (i.isChatInputCommand() && i.commandName === "memberpanel") {
      if (!i.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return i.reply({ content: "你沒有權限使用此指令。", ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle("會員系統｜自助領取/更新")
        .setDescription(
          [
            "✅ **獲取會員**：輸入官網註冊信箱，綁定 Discord（只可綁定一次）",
            "✅ **更新會員狀態**：直接同步你的累積消費 → 自動更新身分組",
          ].join("\n")
        );

      return i.reply({ embeds: [embed], components: makeMemberPanelRow() });
    }

    // Button: member_get -> show modal
    if (i.isButton() && i.customId === "member_get") {
      return i.showModal(buildMemberGetModal());
    }

    // Modal submit: member_get_modal
    if (i.isModalSubmit() && i.customId === "member_get_modal") {
      await i.deferReply({ ephemeral: true });

      const email = (i.fields.getTextInputValue("email") || "").trim().toLowerCase();

      // simple email check
      if (!email.includes("@") || email.length < 6) {
        return i.editReply("❌ Email 格式不正確，請重新點【獲取會員】再輸入。");
      }

      // call website link api
      const url = toApiUrl(WP_LINK_ENDPOINT);
      const data = await postJson(url, {
        discordUserId: i.user.id,
        email,
      });

      const totalSpent = Number(data.totalSpent ?? 0);

      const guild = await client.guilds.fetch(GUILD_ID);
      const applied = await applyTierRoles(guild, i.user.id, totalSpent);
      if (!applied.ok) {
        return i.editReply(`❌ 綁定成功，但更新身分組失敗：${applied.error}`);
      }

      return i.editReply(
        `✅ 綁定成功！已同步累積消費 **${totalSpent}**，身分組已更新。`
      );
    }

    // Button: member_refresh
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
  } catch (e) {
    console.error(e);
    const msg = `❌ 發生錯誤：${e?.message || "請稍後再試"}`;
    if (i.deferred || i.replied) {
      i.editReply(msg).catch(() => {});
    } else {
      i.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN).catch(console.error);
