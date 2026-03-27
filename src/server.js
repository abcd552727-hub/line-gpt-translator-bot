import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-5.4-mini",
  DATABASE_URL,
  PORT = 3000,
} = process.env;

const CONTACT_LINE_ID = "aszx88188";

const SUPER_ADMINS = [
  "U96da7afef783339acc1959c20b445f9c",
  "Uceba5819446e95c6cb0f12f8e27157aa",
];

if (
  !LINE_CHANNEL_ACCESS_TOKEN ||
  !LINE_CHANNEL_SECRET ||
  !OPENAI_API_KEY ||
  !DATABASE_URL
) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const app = express();

const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};

const lineClient = new Client(lineConfig);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const LANG_LABELS = {
  "zh-TW": "繁體中文",
  "zh-CN": "简体中文",
  th: "ไทย",
  en: "English",
  vi: "Tiếng Việt",
  id: "Bahasa Indonesia",
  my: "မြန်မာ",
  ja: "日本語",
  ko: "한국어",
  tl: "Filipino",
  hi: "हिन्दी",
  tr: "Türkçe",
  fr: "Français",
  ms: "Bahasa Melayu",
  km: "ភាសាខ្មែរ",
  lo: "ລາວ",
  ar: "العربية",
};

function isSuperAdmin(userId) {
  return SUPER_ADMINS.includes(userId);
}

function getChatId(event) {
  return event.source.groupId || event.source.roomId || event.source.userId;
}

function getChatType(event) {
  if (event.source.groupId) return "group";
  if (event.source.roomId) return "room";
  return "user";
}

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function formatDateTime(dateString) {
  if (!dateString) return "未設定";
  return new Date(dateString).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour12: false,
  });
}

function isPlanActive(plan) {
  if (!plan || !plan.vip_expires_at) return false;
  return new Date(plan.vip_expires_at).getTime() > Date.now();
}

function canUseGroup(plan, groupId) {
  if (!plan) return false;

  if (plan.plan_type === "unlimited_groups") {
    return true;
  }

  if (plan.plan_type === "limited_groups") {
    const groups = Array.isArray(plan.bound_groups) ? plan.bound_groups : [];
    const limit = Number(plan.group_limit || 0);

    if (groups.includes(groupId)) return true;
    return groups.length < limit;
  }

  return false;
}

function detectSourceLangSimple(text) {
  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
  if (/[\u1000-\u109F]/.test(text)) return "my";
  if (/[\u3040-\u30FF\u31F0-\u31FF]/.test(text)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(text)) return "ko";
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[\u0900-\u097F]/.test(text)) return "hi";
  if (/[\u1780-\u17FF]/.test(text)) return "km";
  if (/[\u0E80-\u0EFF]/.test(text)) return "lo";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh-TW";
  if (/[A-Za-z]/.test(text)) return "en";
  return "auto";
}

async function translateToTarget(text, targetLang) {
  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: `
你是一個翻譯機器，只負責翻譯，不解釋、不改寫、不加前言。

規則：
1. 只輸出 ${targetLang} 的翻譯結果
2. 保留原本語氣
3. 不要加引號
4. 不要加「翻譯：」這類字樣
5. 翻譯要自然、簡潔、口語

請翻譯以下內容：
${text}
    `.trim(),
  });

  return (response.output_text || "").trim();
}

function parsePostbackData(data) {
  const params = new URLSearchParams(data);
  return {
    action: params.get("action"),
    lang: params.get("lang"),
  };
}

function buildLanguageMenuFlex() {
  const addButton = (label, lang) => ({
    type: "button",
    style: "primary",
    action: {
      type: "postback",
      label,
      data: `action=add_lang&lang=${lang}`,
      displayText: `加入 ${label}`,
    },
  });

  const removeButton = (label, lang) => ({
    type: "button",
    style: "secondary",
    action: {
      type: "postback",
      label,
      data: `action=remove_lang&lang=${lang}`,
      displayText: `移除 ${label}`,
    },
  });

  return {
    type: "flex",
    altText: "請選擇群組語言",
    contents: {
      type: "carousel",
      contents: [
        {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "群組語言設定", weight: "bold", size: "lg", align: "center" },
              { type: "text", text: "只有授權管理人可設定", size: "sm", color: "#666666", align: "center", margin: "sm" },
            ],
          },
          footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              addButton("繁中 zh-TW", "zh-TW"),
              addButton("簡中 zh-CN", "zh-CN"),
              addButton("泰文 th", "th"),
              addButton("英文 en", "en"),
              removeButton("繁中 zh-TW", "zh-TW"),
              removeButton("簡中 zh-CN", "zh-CN"),
              removeButton("泰文 th", "th"),
              removeButton("英文 en", "en"),
            ],
          },
        },
        {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "更多語言 1", weight: "bold", size: "lg", align: "center" },
              { type: "text", text: "可複選", size: "sm", color: "#666666", align: "center", margin: "sm" },
            ],
          },
          footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              addButton("越南 vi", "vi"),
              addButton("印尼 id", "id"),
              addButton("緬甸 my", "my"),
              addButton("日本 ja", "ja"),
              removeButton("越南 vi", "vi"),
              removeButton("印尼 id", "id"),
              removeButton("緬甸 my", "my"),
              removeButton("日本 ja", "ja"),
            ],
          },
        },
        {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "更多語言 2", weight: "bold", size: "lg", align: "center" },
              { type: "text", text: "營運版擴充", size: "sm", color: "#666666", align: "center", margin: "sm" },
            ],
          },
          footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              addButton("菲律賓 tl", "tl"),
              addButton("印度 hi", "hi"),
              addButton("土耳其 tr", "tr"),
              addButton("法文 fr", "fr"),
              removeButton("菲律賓 tl", "tl"),
              removeButton("印度 hi", "hi"),
              removeButton("土耳其 tr", "tr"),
              removeButton("法文 fr", "fr"),
            ],
          },
        },
      ],
    },
  };
}

function buildStatusText(group, plan) {
  return [
    `ownerId：${group?.owner_id || "未綁定"}`,
    `方案：${plan?.plan_type || "未開通"}`,
    `群組上限：${plan?.plan_type === "unlimited_groups" ? "不限" : (plan?.group_limit ?? "未設定")}`,
    `已綁群組：${(plan?.bound_groups || []).length}`,
    `目前語言：${group?.langs?.length ? group.langs.join(", ") : "尚未設定"}`,
    `管理員數量：${group?.admins?.length || 0}`,
    `到期時間：${plan?.vip_expires_at ? formatDateTime(plan.vip_expires_at) : "未設定"}`,
    `VIP狀態：${isPlanActive(plan) ? "有效" : "已到期 / 未開通"}`,
  ].join("\n");
}

function buildPlanText(userId, plan) {
  if (!plan || !plan.plan_type) {
    return `使用者：${userId}\n目前尚未開通方案。`;
  }

  return [
    `使用者：${userId}`,
    `方案：${plan.plan_type}`,
    `群組上限：${plan.plan_type === "unlimited_groups" ? "不限" : (plan.group_limit ?? "未設定")}`,
    `已綁群組：${(plan.bound_groups || []).length}`,
    `到期時間：${plan.vip_expires_at ? formatDateTime(plan.vip_expires_at) : "未設定"}`,
    `VIP狀態：${isPlanActive(plan) ? "有效" : "已到期 / 未開通"}`,
  ].join("\n");
}

function buildUserHelpText() {
  return [
    "可用指令：",
    "/help",
    "/取得時間",
    "/price",
    "/langs",
    "",
    "說明：",
    "群組翻譯由管理人設定語言",
    "方案到期後會自動停用",
    `續費請聯絡 LINE：${CONTACT_LINE_ID}`,
  ].join("\n");
}

function buildAdminHelpText(superAdmin) {
  const lines = [
    "管理版指令：",
    "/help",
    "/status",
    "/langs",
    "/myplan",
    "/取得時間",
    "/price",
    "/myid",
    "/menu",
    "/bind",
    "/unbind",
    "/trial3",
    "/plan1",
    "/plan3",
    "/plan5",
    "/planu30",
    "/planu90",
    "/setadmin 使用者ID",
    "/deladmin 使用者ID",
    "/setowner 使用者ID",
  ];

  if (superAdmin) {
    lines.push(
      "/開通1群 使用者ID",
      "/開通3群 使用者ID",
      "/開通5群 使用者ID",
      "/開通不限30 使用者ID",
      "/查方案 使用者ID",
      "/停用 使用者ID"
    );
  }

  return lines.join("\n");
}

async function replyText(replyToken, text) {
  return lineClient.replyMessage(replyToken, {
    type: "text",
    text: text.slice(0, 5000),
  });
}

async function replyMessages(replyToken, messages) {
  return lineClient.replyMessage(replyToken, messages);
}

async function pushLanguageMenu(to) {
  return lineClient.pushMessage(to, [
    buildLanguageMenuFlex(),
    { type: "text", text: "請直接按語言。第一個成功設定的人會成為此群管理人。" },
  ]);
}

/* =========================
   DB HELPERS
========================= */

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plans (
      user_id TEXT PRIMARY KEY,
      plan_type TEXT,
      group_limit INTEGER,
      vip_expires_at TIMESTAMPTZ,
      bound_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_subscriptions (
      chat_id TEXT PRIMARY KEY,
      owner_id TEXT,
      langs JSONB NOT NULL DEFAULT '[]'::jsonb,
      admins JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getGroup(chatId) {
  const result = await pool.query(
    `SELECT chat_id, owner_id, langs, admins, created_at
     FROM group_subscriptions
     WHERE chat_id = $1`,
    [chatId]
  );
  return result.rows[0] || null;
}

async function ensureGroupDb(chatId) {
  await pool.query(
    `
    INSERT INTO group_subscriptions (chat_id, owner_id, langs, admins)
    VALUES ($1, NULL, '[]'::jsonb, '[]'::jsonb)
    ON CONFLICT (chat_id) DO NOTHING
    `,
    [chatId]
  );

  return getGroup(chatId);
}

async function saveGroup(group) {
  await pool.query(
    `
    INSERT INTO group_subscriptions (chat_id, owner_id, langs, admins)
    VALUES ($1, $2, $3::jsonb, $4::jsonb)
    ON CONFLICT (chat_id)
    DO UPDATE SET
      owner_id = EXCLUDED.owner_id,
      langs = EXCLUDED.langs,
      admins = EXCLUDED.admins
    `,
    [
      group.chat_id,
      group.owner_id,
      JSON.stringify(group.langs || []),
      JSON.stringify(group.admins || []),
    ]
  );
}

async function getPlan(userId) {
  const result = await pool.query(
    `SELECT user_id, plan_type, group_limit, vip_expires_at, bound_groups, created_at
     FROM plans
     WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function ensurePlanDb(userId) {
  await pool.query(
    `
    INSERT INTO plans (user_id, plan_type, group_limit, vip_expires_at, bound_groups)
    VALUES ($1, NULL, NULL, NULL, '[]'::jsonb)
    ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );

  return getPlan(userId);
}

async function savePlan(plan) {
  await pool.query(
    `
    INSERT INTO plans (user_id, plan_type, group_limit, vip_expires_at, bound_groups)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    ON CONFLICT (user_id)
    DO UPDATE SET
      plan_type = EXCLUDED.plan_type,
      group_limit = EXCLUDED.group_limit,
      vip_expires_at = EXCLUDED.vip_expires_at,
      bound_groups = EXCLUDED.bound_groups
    `,
    [
      plan.user_id,
      plan.plan_type,
      plan.group_limit,
      plan.vip_expires_at,
      JSON.stringify(plan.bound_groups || []),
    ]
  );
}

function isAdmin(group, userId) {
  if (!userId) return false;
  return (group?.admins || []).includes(userId);
}

function canManageGroup(group, plan, userId) {
  return isAdmin(group, userId) && isPlanActive(plan);
}

function addAdmin(group, userId) {
  if (!userId) return;
  if (!group.admins.includes(userId)) {
    group.admins.push(userId);
  }
}

function removeAdmin(group, userId) {
  group.admins = group.admins.filter((id) => id !== userId);
}

function bindGroupToOwner(plan, groupId) {
  if (!plan.bound_groups) {
    plan.bound_groups = [];
  }

  if (!plan.bound_groups.includes(groupId)) {
    plan.bound_groups.push(groupId);
  }
}

function unbindGroupFromOwner(plan, groupId) {
  if (!plan?.bound_groups) return;
  plan.bound_groups = plan.bound_groups.filter((g) => g !== groupId);
}

function createPlanObject(userId, planType, groupLimit, days) {
  return {
    user_id: userId,
    plan_type: planType,
    group_limit: groupLimit,
    vip_expires_at: addDays(days),
    bound_groups: [],
  };
}

function disablePlanObject(plan, userId) {
  return {
    user_id: userId,
    plan_type: plan?.plan_type || null,
    group_limit: plan?.group_limit ?? null,
    vip_expires_at: new Date(Date.now() - 1000).toISOString(),
    bound_groups: Array.isArray(plan?.bound_groups) ? plan.bound_groups : [],
  };
}

/* =========================
   EVENTS
========================= */

async function handleJoin(event) {
  const chatId = getChatId(event);
  await ensureGroupDb(chatId);
  await pushLanguageMenu(chatId);
}

async function handleFollow(event) {
  const chatId = getChatId(event);
  const userId = event.source.userId;

  const group = await ensureGroupDb(chatId);

  if (!group.owner_id) {
    group.owner_id = userId;
  }
  addAdmin(group, userId);

  await saveGroup(group);

  await replyMessages(event.replyToken, [
    buildLanguageMenuFlex(),
    { type: "text", text: "歡迎使用翻譯機器人。你目前是管理員，可以設定語言與方案。" },
  ]);
}

async function handlePostback(event) {
  const chatId = getChatId(event);
  const userId = event.source.userId;

  const group = await ensureGroupDb(chatId);
  const { action, lang } = parsePostbackData(event.postback.data || "");

  if (!LANG_LABELS[lang]) {
    await replyText(event.replyToken, "語言不支援。");
    return;
  }

  if (!group.owner_id) {
    const candidatePlan = await getPlan(userId);

    if (!isPlanActive(candidatePlan)) {
      await replyText(event.replyToken, "你目前沒有有效方案，無法設定此群語言。");
      return;
    }

    if (!canUseGroup(candidatePlan, chatId)) {
      await replyText(event.replyToken, "你的方案可用群組數量已滿，無法綁定此群。");
      return;
    }

    group.owner_id = userId;
    addAdmin(group, userId);
    bindGroupToOwner(candidatePlan, chatId);

    if (action === "add_lang" && !group.langs.includes(lang)) {
      group.langs.push(lang);
    }

    await saveGroup(group);
    await savePlan(candidatePlan);

    await replyText(
      event.replyToken,
      `已完成群組綁定，你現在是此群管理人。\n已加入語言：${LANG_LABELS[lang]} (${lang})`
    );
    return;
  }

  const ownerPlan = await getPlan(group.owner_id);

  if (!isSuperAdmin(userId) && !canManageGroup(group, ownerPlan, userId)) {
    await replyText(event.replyToken, "只有此群的授權管理人可以設定語言，或方案可能已到期。");
    return;
  }

  if (action === "add_lang") {
    if (!group.langs.includes(lang)) {
      group.langs.push(lang);
    }
    await saveGroup(group);
    await replyText(
      event.replyToken,
      `已加入語言：${LANG_LABELS[lang]} (${lang})\n目前語言：${group.langs.join(", ")}`
    );
    return;
  }

  if (action === "remove_lang") {
    group.langs = group.langs.filter((l) => l !== lang);
    await saveGroup(group);
    await replyText(
      event.replyToken,
      `已移除語言：${LANG_LABELS[lang]} (${lang})\n目前語言：${group.langs.length ? group.langs.join(", ") : "無"}`
    );
    return;
  }

  await replyText(event.replyToken, "未知操作。");
}

async function handleCommand(event, rawText) {
  const text = rawText.trim();
  const [cmd, arg] = text.split(/\s+/, 2);

  const chatId = getChatId(event);
  const userId = event.source.userId;

  const group = await ensureGroupDb(chatId);

  if (!group.owner_id && userId) {
    group.owner_id = userId;
  }
  if ((group.admins || []).length === 0 && userId) {
    addAdmin(group, userId);
  }

  await saveGroup(group);

  const ownerId = group.owner_id;
  const plan = ownerId ? await ensurePlanDb(ownerId) : null;
  const admin = isAdmin(group, userId);
  const superAdmin = isSuperAdmin(userId);
  const canAdmin = admin || superAdmin;

  if (cmd === "/help") {
    if (canAdmin) {
      await replyText(event.replyToken, buildAdminHelpText(superAdmin));
    } else {
      await replyText(event.replyToken, buildUserHelpText());
    }
    return true;
  }

  if (cmd === "/myid") {
    await replyText(event.replyToken, `你的 userId：${userId || "目前抓不到 userId"}`);
    return true;
  }

  if (cmd === "/status") {
    await replyText(event.replyToken, buildStatusText(group, plan));
    return true;
  }

  if (cmd === "/langs") {
    await replyText(
      event.replyToken,
      group.langs.length
        ? `本群語言：${group.langs.map((l) => `${LANG_LABELS[l]}(${l})`).join("、")}`
        : "本群尚未設定語言。"
    );
    return true;
  }

  if (cmd === "/expire" || cmd === "/取得時間") {
    await replyText(
      event.replyToken,
      plan?.vip_expires_at
        ? `你的使用期限到：${formatDateTime(plan.vip_expires_at)}`
        : "目前尚未開通方案。"
    );
    return true;
  }

  if (cmd === "/price") {
    await replyText(
      event.replyToken,
      [
        "翻譯機器人方案",
        "1群 / 30天",
        "3群 / 30天",
        "5群 / 30天",
        "30天不限群組",
        "90天不限群組",
        "",
        `詳情與開通請聯絡管理員 LINE：${CONTACT_LINE_ID}`,
      ].join("\n")
    );
    return true;
  }

  if (cmd === "/myplan") {
    await replyText(event.replyToken, buildStatusText(group, plan));
    return true;
  }

  if (cmd === "/menu") {
    if (!superAdmin && !canManageGroup(group, plan, userId)) {
      await replyText(event.replyToken, "你目前不能設定語言，可能是權限不足或方案已到期。");
      return true;
    }
    await replyMessages(event.replyToken, [
      buildLanguageMenuFlex(),
      { type: "text", text: "請加入或移除本群要輸出的語言。" },
    ]);
    return true;
  }

  if (cmd === "/bind") {
    if (!canAdmin) {
      await replyText(event.replyToken, "只有管理員可以綁定群組。");
      return true;
    }

    if (!ownerId) {
      await replyText(event.replyToken, "本群尚未設定 owner。");
      return true;
    }

    const currentPlan = await ensurePlanDb(ownerId);

    if (!isPlanActive(currentPlan)) {
      await replyText(event.replyToken, "此 owner 方案已到期或未開通。");
      return true;
    }

    if (!canUseGroup(currentPlan, chatId)) {
      await replyText(event.replyToken, "此方案的群組數量已滿，無法再綁定新群。");
      return true;
    }

    bindGroupToOwner(currentPlan, chatId);
    await savePlan(currentPlan);

    await replyText(event.replyToken, `綁定成功。\n目前已綁群組數：${currentPlan.bound_groups.length}`);
    return true;
  }

  if (cmd === "/unbind") {
    if (!canAdmin) {
      await replyText(event.replyToken, "只有管理員可以解除綁定。");
      return true;
    }

    if (!ownerId) {
      await replyText(event.replyToken, "尚未綁定方案。");
      return true;
    }

    const currentPlan = await ensurePlanDb(ownerId);
    unbindGroupFromOwner(currentPlan, chatId);
    await savePlan(currentPlan);

    await replyText(event.replyToken, "本群已解除綁定。");
    return true;
  }

  if (cmd === "/trial3") {
    if (!canAdmin) {
      await replyText(event.replyToken, "只有管理員可以開通試用。");
      return true;
    }

    const nextPlan = createPlanObject(ownerId, "limited_groups", 1, 3);
    await savePlan(nextPlan);

    await replyText(
      event.replyToken,
      `已開通 3 天試用\n到期：${formatDateTime(nextPlan.vip_expires_at)}`
    );
    return true;
  }

  if (cmd === "/plan1") {
    if (!canAdmin) {
      await replyText(event.replyToken, "只有管理員可以設定方案。");
      return true;
    }

    const nextPlan = createPlanObject(ownerId, "limited_groups", 1, 30);
    await savePlan(nextPlan);

    await replyText(event.replyToken, `已開通 1 群 / 30 天\n到期：${formatDateTime(nextPlan.vip_expires_at)}`);
    return true;
  }

  if (cmd === "/plan3") {
    if (!canAdmin) {
      await replyText(event.replyToken, "只有管理員可以設定方案。");
      return true;
    }

    const nextPlan = createPlanObject(ownerId, "limited_groups", 3, 30);
    await savePlan(nextPlan);

    await replyText(event.replyToken, `已開通 3 群 / 30 天\n到期：${formatDateTime(nextPlan.vip_expires_at)}`);
    return true;
  }

  if (cmd === "/plan5") {
    if (!canAdmin) {
      await replyText(event.replyToken, "只有管理員可以設定方案。");
      return true;
    }

    const nextPlan = createPlanObject(ownerId, "limited_groups", 5, 30);
    await savePlan(nextPlan);

    await replyText(event.replyToken, `已開通 5 群 / 30 天\n到期：${formatDateTime(nextPlan.vip_expires_at)}`);
    return true;
  }

  if (cmd === "/planu30") {
    if (!canAdmin) {
      await replyText(event.replyToken, "只有管理員可以設定方案。");
      return true;
    }

    const nextPlan = createPlanObject(ownerId, "unlimited_groups", null, 30);
    await savePlan(nextPlan);

    await replyText(event.replyToken, `已開通 30 天不限群組\n到期：${formatDateTime(nextPlan.vip_expires_at)}`);
    return true;
  }

  if (cmd === "/planu90") {
    if (!canAdmin) {
      await replyText(event.replyToken, "只有管理員可以設定方案。");
      return true;
    }

    const nextPlan = createPlanObject(ownerId, "unlimited_groups", null, 90);
    await savePlan(nextPlan);

    await replyText(event.replyToken, `已開通 90 天不限群組\n到期：${formatDateTime(nextPlan.vip_expires_at)}`);
    return true;
  }

  if (cmd === "/setadmin") {
    if (!canAdmin) {
      await replyText(event.replyToken, "只有管理員可以新增管理員。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/setadmin 使用者ID");
      return true;
    }

    addAdmin(group, arg);
    await saveGroup(group);

    await replyText(event.replyToken, `已新增管理員：${arg}`);
    return true;
  }

  if (cmd === "/deladmin") {
    if (!canAdmin) {
      await replyText(event.replyToken, "只有管理員可以移除管理員。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/deladmin 使用者ID");
      return true;
    }

    if (group.owner_id === arg) {
      await replyText(event.replyToken, "不能移除 owner 的管理員權限。");
      return true;
    }

    removeAdmin(group, arg);
    await saveGroup(group);

    await replyText(event.replyToken, `已移除管理員：${arg}`);
    return true;
  }

  if (cmd === "/setowner") {
    if (!canAdmin) {
      await replyText(event.replyToken, "只有管理員可以設定 owner。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/setowner 使用者ID");
      return true;
    }

    group.owner_id = arg;
    addAdmin(group, arg);
    await saveGroup(group);
    await ensurePlanDb(arg);

    await replyText(event.replyToken, `已設定 owner：${arg}`);
    return true;
  }

  if (cmd === "/開通1群") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/開通1群 使用者ID");
      return true;
    }

    const nextPlan = createPlanObject(arg, "limited_groups", 1, 30);
    await savePlan(nextPlan);

    await replyText(
      event.replyToken,
      `已開通 1群 / 30天\n使用者：${arg}\n到期：${formatDateTime(nextPlan.vip_expires_at)}`
    );
    return true;
  }

  if (cmd === "/開通3群") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/開通3群 使用者ID");
      return true;
    }

    const nextPlan = createPlanObject(arg, "limited_groups", 3, 30);
    await savePlan(nextPlan);

    await replyText(
      event.replyToken,
      `已開通 3群 / 30天\n使用者：${arg}\n到期：${formatDateTime(nextPlan.vip_expires_at)}`
    );
    return true;
  }

  if (cmd === "/開通5群") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/開通5群 使用者ID");
      return true;
    }

    const nextPlan = createPlanObject(arg, "limited_groups", 5, 30);
    await savePlan(nextPlan);

    await replyText(
      event.replyToken,
      `已開通 5群 / 30天\n使用者：${arg}\n到期：${formatDateTime(nextPlan.vip_expires_at)}`
    );
    return true;
  }

  if (cmd === "/開通不限30") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/開通不限30 使用者ID");
      return true;
    }

    const nextPlan = createPlanObject(arg, "unlimited_groups", null, 30);
    await savePlan(nextPlan);

    await replyText(
      event.replyToken,
      `已開通 不限群組 / 30天\n使用者：${arg}\n到期：${formatDateTime(nextPlan.vip_expires_at)}`
    );
    return true;
  }

  if (cmd === "/查方案") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/查方案 使用者ID");
      return true;
    }

    const targetPlan = await getPlan(arg);
    await replyText(event.replyToken, buildPlanText(arg, targetPlan));
    return true;
  }

  if (cmd === "/停用") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/停用 使用者ID");
      return true;
    }

    const current = await getPlan(arg);
    const disabled = disablePlanObject(current, arg);
    await savePlan(disabled);

    await replyText(event.replyToken, `已停用方案：${arg}`);
    return true;
  }

  return false;
}

async function handleTextMessage(event) {
  const text = (event.message?.text || "").trim();
  if (!text) return;

  if (text.startsWith("/")) {
    const handled = await handleCommand(event, text);
    if (handled) return;
  }

  const chatType = getChatType(event);
  const chatId = getChatId(event);

  const group = await ensureGroupDb(chatId);

  if (chatType === "user") {
    const sourceLang = detectSourceLangSimple(text);
    const targetLangs = ["zh-TW", "th"].filter((lang) => lang !== sourceLang);

    const outputs = [];
    for (const lang of targetLangs) {
      try {
        const translated = await translateToTarget(text, lang);
        outputs.push(`[${lang}] ${translated}`);
      } catch (err) {
        console.error(`translate ${lang} error:`, err);
      }
    }

    if (!outputs.length) {
      await replyText(event.replyToken, "翻譯失敗，請稍後再試。");
      return;
    }

    await replyText(event.replyToken, outputs.join("\n"));
    return;
  }

  const ownerId = group.owner_id;
  const plan = ownerId ? await getPlan(ownerId) : null;

  if (!ownerId) {
    await replyText(event.replyToken, "本群尚未設定管理人，請先按語言選單。");
    return;
  }

  if (!isPlanActive(plan)) {
    await replyText(
      event.replyToken,
      [
        "本群翻譯方案已到期",
        "目前無法使用語言設定與自動翻譯",
        "",
        `如需續費開通`,
        `請聯絡管理員 LINE：${CONTACT_LINE_ID}`,
      ].join("\n")
    );
    return;
  }

  if (!canUseGroup(plan, chatId)) {
    await replyText(event.replyToken, "此方案可用群組數量已滿，請升級方案。");
    return;
  }

  if (!(plan.bound_groups || []).includes(chatId)) {
    bindGroupToOwner(plan, chatId);
    await savePlan(plan);
  }

  const targetLangs = group.langs || [];
  if (!targetLangs.length) {
    await replyText(event.replyToken, "本群尚未設定語言，請管理人按語言選單設定。");
    return;
  }

  const sourceLang = detectSourceLangSimple(text);
  const langsToTranslate = targetLangs.filter((lang) => lang !== sourceLang);

  if (!langsToTranslate.length) {
    await replyText(event.replyToken, "目前沒有需要翻譯的新語言。");
    return;
  }

  const outputs = [];
  for (const lang of langsToTranslate) {
    try {
      const translated = await translateToTarget(text, lang);
      outputs.push(`[${lang}] ${translated}`);
    } catch (err) {
      console.error(`translate ${lang} error:`, err);
    }
  }

  if (!outputs.length) {
    await replyText(event.replyToken, "翻譯失敗，請稍後再試。");
    return;
  }

  await replyText(event.replyToken, outputs.join("\n"));
}

async function handleEvent(event) {
  if (event.type === "join") {
    await handleJoin(event);
    return;
  }

  if (event.type === "follow") {
    await handleFollow(event);
    return;
  }

  if (event.type === "postback") {
    await handlePostback(event);
    return;
  }

  if (event.type === "message" && event.message?.type === "text") {
    await handleTextMessage(event);
  }
}

app.get("/", (_req, res) => {
  res.status(200).send("LINE translator bot is running.");
});

app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);

  try {
    const events = req.body.events || [];
    for (const event of events) {
      await handleEvent(event);
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("DB init error:", err);
    process.exit(1);
  });
