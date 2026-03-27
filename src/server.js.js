import express from "express";
import fs from "fs";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4.1-mini",
  PORT = 3000,
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !OPENAI_API_KEY) {
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

const GROUP_FILE = "./group_subscriptions.json";
const PLAN_FILE = "./plans.json";

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

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "{}", "utf8");
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`readJson error (${filePath}):`, err);
    return {};
  }
}

function saveJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`saveJson error (${filePath}):`, err);
  }
}

function readGroups() {
  return readJson(GROUP_FILE);
}

function saveGroups(data) {
  saveJson(GROUP_FILE, data);
}

function readPlans() {
  return readJson(PLAN_FILE);
}

function savePlans(data) {
  saveJson(PLAN_FILE, data);
}

function getChatId(event) {
  return event.source.groupId || event.source.roomId || event.source.userId;
}

function getChatType(event) {
  if (event.source.groupId) return "group";
  if (event.source.roomId) return "room";
  return "user";
}

function ensureGroup(groups, chatId) {
  if (!groups[chatId]) {
    groups[chatId] = {
      ownerId: null,
      langs: [],
      admins: [],
      createdAt: new Date().toISOString(),
    };
  }
}

function ensurePlan(plans, ownerId) {
  if (!plans[ownerId]) {
    plans[ownerId] = {
      planType: null,
      groupLimit: null,
      vipExpiresAt: null,
      boundGroups: [],
      createdAt: new Date().toISOString(),
    };
  }
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

function getRemainingDays(dateString) {
  if (!dateString) return null;
  const diff = new Date(dateString).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function isPlanActive(plan) {
  if (!plan || !plan.vipExpiresAt) return false;
  return new Date(plan.vipExpiresAt).getTime() > Date.now();
}

function canUseGroup(plan, groupId) {
  if (!plan) return false;

  if (plan.planType === "unlimited_groups") {
    return true;
  }

  if (plan.planType === "limited_groups") {
    const groups = plan.boundGroups || [];
    const limit = Number(plan.groupLimit || 0);

    if (groups.includes(groupId)) return true;
    return groups.length < limit;
  }

  return false;
}

function bindGroupToOwner(plans, ownerId, groupId) {
  ensurePlan(plans, ownerId);

  if (!plans[ownerId].boundGroups) {
    plans[ownerId].boundGroups = [];
  }

  if (!plans[ownerId].boundGroups.includes(groupId)) {
    plans[ownerId].boundGroups.push(groupId);
  }
}

function unbindGroupFromOwner(plans, ownerId, groupId) {
  if (!plans[ownerId]?.boundGroups) return;
  plans[ownerId].boundGroups = plans[ownerId].boundGroups.filter((g) => g !== groupId);
}

function isAdmin(groups, chatId, userId) {
  if (!userId) return false;
  return (groups?.[chatId]?.admins || []).includes(userId);
}

function canManageGroup(groups, plans, chatId, userId) {
  const ownerId = groups?.[chatId]?.ownerId;
  const plan = ownerId ? plans?.[ownerId] : null;
  return isAdmin(groups, chatId, userId) && isPlanActive(plan);
}

function addAdmin(groups, chatId, userId) {
  ensureGroup(groups, chatId);
  if (!userId) return;
  if (!groups[chatId].admins.includes(userId)) {
    groups[chatId].admins.push(userId);
  }
}

function removeAdmin(groups, chatId, userId) {
  ensureGroup(groups, chatId);
  groups[chatId].admins = groups[chatId].admins.filter((id) => id !== userId);
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
    `ownerId：${group?.ownerId || "未綁定"}`,
    `方案：${plan?.planType || "未開通"}`,
    `群組上限：${plan?.planType === "unlimited_groups" ? "不限" : (plan?.groupLimit ?? "未設定")}`,
    `已綁群組：${(plan?.boundGroups || []).length}`,
    `目前語言：${group?.langs?.length ? group.langs.join(", ") : "尚未設定"}`,
    `管理員數量：${group?.admins?.length || 0}`,
    `到期時間：${plan?.vipExpiresAt ? formatDateTime(plan.vipExpiresAt) : "未設定"}`,
    `VIP狀態：${isPlanActive(plan) ? "有效" : "已到期 / 未開通"}`,
  ].join("\n");
}

function buildHelpText(admin) {
  return [
    "可用指令：",
    "/help",
    "/status",
    "/langs",
    "/myplan",
    "/取得時間",
    "/price",
    "/myid",
    admin ? "/menu" : "",
    admin ? "/bind" : "",
    admin ? "/unbind" : "",
    admin ? "/trial3" : "",
    admin ? "/plan1" : "",
    admin ? "/plan3" : "",
    admin ? "/plan5" : "",
    admin ? "/planu30" : "",
    admin ? "/planu90" : "",
    admin ? "/setadmin 使用者ID" : "",
    admin ? "/deladmin 使用者ID" : "",
    admin ? "/setowner 使用者ID" : "",
  ].filter(Boolean).join("\n");
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

async function handleJoin(event) {
  const chatId = getChatId(event);
  const groups = readGroups();

  ensureGroup(groups, chatId);
  saveGroups(groups);

  await pushLanguageMenu(chatId);
}

async function handleFollow(event) {
  const chatId = getChatId(event);
  const userId = event.source.userId;

  const groups = readGroups();
  ensureGroup(groups, chatId);
  addAdmin(groups, chatId, userId);

  if (!groups[chatId].ownerId) {
    groups[chatId].ownerId = userId;
  }

  saveGroups(groups);

  await replyMessages(event.replyToken, [
    buildLanguageMenuFlex(),
    { type: "text", text: "歡迎使用翻譯機器人。你目前是管理員，可以設定語言與方案。" },
  ]);
}

async function handlePostback(event) {
  const chatId = getChatId(event);
  const userId = event.source.userId;

  const groups = readGroups();
  const plans = readPlans();

  ensureGroup(groups, chatId);

  const { action, lang } = parsePostbackData(event.postback.data || "");

  if (!LANG_LABELS[lang]) {
    await replyText(event.replyToken, "語言不支援。");
    return;
  }

  if (!groups[chatId].ownerId) {
    const candidatePlan = plans[userId];

    if (!isPlanActive(candidatePlan)) {
      await replyText(event.replyToken, "你目前沒有有效方案，無法設定此群語言。");
      return;
    }

    if (!canUseGroup(candidatePlan, chatId)) {
      await replyText(event.replyToken, "你的方案可用群組數量已滿，無法綁定此群。");
      return;
    }

    groups[chatId].ownerId = userId;
    addAdmin(groups, chatId, userId);
    bindGroupToOwner(plans, userId, chatId);

    if (action === "add_lang" && !groups[chatId].langs.includes(lang)) {
      groups[chatId].langs.push(lang);
    }

    saveGroups(groups);
    savePlans(plans);

    await replyText(
      event.replyToken,
      `已完成群組綁定，你現在是此群管理人。\n已加入語言：${LANG_LABELS[lang]} (${lang})`
    );
    return;
  }

  if (!canManageGroup(groups, plans, chatId, userId)) {
    await replyText(event.replyToken, "只有此群的授權管理人可以設定語言，或方案可能已到期。");
    return;
  }

  if (action === "add_lang") {
    if (!groups[chatId].langs.includes(lang)) {
      groups[chatId].langs.push(lang);
    }
    saveGroups(groups);
    await replyText(
      event.replyToken,
      `已加入語言：${LANG_LABELS[lang]} (${lang})\n目前語言：${groups[chatId].langs.join(", ")}`
    );
    return;
  }

  if (action === "remove_lang") {
    groups[chatId].langs = groups[chatId].langs.filter((l) => l !== lang);
    saveGroups(groups);
    await replyText(
      event.replyToken,
      `已移除語言：${LANG_LABELS[lang]} (${lang})\n目前語言：${groups[chatId].langs.length ? groups[chatId].langs.join(", ") : "無"}`
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

  const groups = readGroups();
  const plans = readPlans();

  ensureGroup(groups, chatId);

  if (!groups[chatId].ownerId && userId) {
    groups[chatId].ownerId = userId;
  }
  if ((groups[chatId].admins || []).length === 0 && userId) {
    addAdmin(groups, chatId, userId);
  }

  saveGroups(groups);

  const ownerId = groups[chatId].ownerId;
  if (ownerId) ensurePlan(plans, ownerId);

  const plan = ownerId ? plans[ownerId] : null;
  const admin = isAdmin(groups, chatId, userId);

  if (cmd === "/help") {
    await replyText(event.replyToken, buildHelpText(admin));
    return true;
  }

  if (cmd === "/myid") {
    await replyText(event.replyToken, `你的 userId：${userId || "目前抓不到 userId"}`);
    return true;
  }

  if (cmd === "/status") {
    await replyText(event.replyToken, buildStatusText(groups[chatId], plan));
    return true;
  }

  if (cmd === "/langs") {
    await replyText(
      event.replyToken,
      groups[chatId].langs.length
        ? `本群語言：${groups[chatId].langs.map((l) => `${LANG_LABELS[l]}(${l})`).join("、")}`
        : "本群尚未設定語言。"
    );
    return true;
  }

  if (cmd === "/expire" || cmd === "/取得時間") {
    await replyText(
      event.replyToken,
      plan?.vipExpiresAt
        ? `你的使用期限到：${formatDateTime(plan.vipExpiresAt)}`
        : "目前尚未開通方案。"
    );
    return true;
  }

  if (cmd === "/price") {
    await replyText(
      event.replyToken,
      [
        "方案價格：",
        "1群 / 30天",
        "3群 / 30天",
        "5群 / 30天",
        "30天不限群組",
        "90天不限群組",
        "",
        "詳細價格請聯絡管理員",
      ].join("\n")
    );
    return true;
  }

  if (cmd === "/myplan") {
    await replyText(event.replyToken, buildStatusText(groups[chatId], plan));
    return true;
  }

  if (cmd === "/menu") {
    if (!canManageGroup(groups, plans, chatId, userId)) {
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
    if (!admin) {
      await replyText(event.replyToken, "只有管理員可以綁定群組。");
      return true;
    }

    if (!ownerId) {
      await replyText(event.replyToken, "本群尚未設定 owner。");
      return true;
    }

    ensurePlan(plans, ownerId);
    const currentPlan = plans[ownerId];

    if (!isPlanActive(currentPlan)) {
      await replyText(event.replyToken, "此 owner 方案已到期或未開通。");
      return true;
    }

    if (!canUseGroup(currentPlan, chatId)) {
      await replyText(event.replyToken, "此方案的群組數量已滿，無法再綁定新群。");
      return true;
    }

    bindGroupToOwner(plans, ownerId, chatId);
    savePlans(plans);

    await replyText(event.replyToken, `綁定成功。\n目前已綁群組數：${plans[ownerId].boundGroups.length}`);
    return true;
  }

  if (cmd === "/unbind") {
    if (!admin) {
      await replyText(event.replyToken, "只有管理員可以解除綁定。");
      return true;
    }

    if (!ownerId || !plans[ownerId]) {
      await replyText(event.replyToken, "尚未綁定方案。");
      return true;
    }

    unbindGroupFromOwner(plans, ownerId, chatId);
    savePlans(plans);

    await replyText(event.replyToken, "本群已解除綁定。");
    return true;
  }

  if (cmd === "/trial3") {
    if (!admin) {
      await replyText(event.replyToken, "只有管理員可以開通試用。");
      return true;
    }

    ensurePlan(plans, ownerId);
    plans[ownerId].planType = "limited_groups";
    plans[ownerId].groupLimit = 1;
    plans[ownerId].vipExpiresAt = addDays(3);
    plans[ownerId].boundGroups = [];
    savePlans(plans);

    await replyText(
      event.replyToken,
      `已開通 3 天試用\n到期：${formatDateTime(plans[ownerId].vipExpiresAt)}`
    );
    return true;
  }

  if (cmd === "/plan1") {
    if (!admin) {
      await replyText(event.replyToken, "只有管理員可以設定方案。");
      return true;
    }

    ensurePlan(plans, ownerId);
    plans[ownerId].planType = "limited_groups";
    plans[ownerId].groupLimit = 1;
    plans[ownerId].vipExpiresAt = addDays(30);
    plans[ownerId].boundGroups = [];
    savePlans(plans);

    await replyText(event.replyToken, `已開通 1 群 / 30 天\n到期：${formatDateTime(plans[ownerId].vipExpiresAt)}`);
    return true;
  }

  if (cmd === "/plan3") {
    if (!admin) {
      await replyText(event.replyToken, "只有管理員可以設定方案。");
      return true;
    }

    ensurePlan(plans, ownerId);
    plans[ownerId].planType = "limited_groups";
    plans[ownerId].groupLimit = 3;
    plans[ownerId].vipExpiresAt = addDays(30);
    plans[ownerId].boundGroups = [];
    savePlans(plans);

    await replyText(event.replyToken, `已開通 3 群 / 30 天\n到期：${formatDateTime(plans[ownerId].vipExpiresAt)}`);
    return true;
  }

  if (cmd === "/plan5") {
    if (!admin) {
      await replyText(event.replyToken, "只有管理員可以設定方案。");
      return true;
    }

    ensurePlan(plans, ownerId);
    plans[ownerId].planType = "limited_groups";
    plans[ownerId].groupLimit = 5;
    plans[ownerId].vipExpiresAt = addDays(30);
    plans[ownerId].boundGroups = [];
    savePlans(plans);

    await replyText(event.replyToken, `已開通 5 群 / 30 天\n到期：${formatDateTime(plans[ownerId].vipExpiresAt)}`);
    return true;
  }

  if (cmd === "/planu30") {
    if (!admin) {
      await replyText(event.replyToken, "只有管理員可以設定方案。");
      return true;
    }

    ensurePlan(plans, ownerId);
    plans[ownerId].planType = "unlimited_groups";
    plans[ownerId].groupLimit = null;
    plans[ownerId].vipExpiresAt = addDays(30);
    plans[ownerId].boundGroups = [];
    savePlans(plans);

    await replyText(event.replyToken, `已開通 30 天不限群組\n到期：${formatDateTime(plans[ownerId].vipExpiresAt)}`);
    return true;
  }

  if (cmd === "/planu90") {
    if (!admin) {
      await replyText(event.replyToken, "只有管理員可以設定方案。");
      return true;
    }

    ensurePlan(plans, ownerId);
    plans[ownerId].planType = "unlimited_groups";
    plans[ownerId].groupLimit = null;
    plans[ownerId].vipExpiresAt = addDays(90);
    plans[ownerId].boundGroups = [];
    savePlans(plans);

    await replyText(event.replyToken, `已開通 90 天不限群組\n到期：${formatDateTime(plans[ownerId].vipExpiresAt)}`);
    return true;
  }

  if (cmd === "/setadmin") {
    if (!admin) {
      await replyText(event.replyToken, "只有管理員可以新增管理員。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/setadmin 使用者ID");
      return true;
    }

    addAdmin(groups, chatId, arg);
    saveGroups(groups);

    await replyText(event.replyToken, `已新增管理員：${arg}`);
    return true;
  }

  if (cmd === "/deladmin") {
    if (!admin) {
      await replyText(event.replyToken, "只有管理員可以移除管理員。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/deladmin 使用者ID");
      return true;
    }

    if (groups[chatId].ownerId === arg) {
      await replyText(event.replyToken, "不能移除 owner 的管理員權限。");
      return true;
    }

    removeAdmin(groups, chatId, arg);
    saveGroups(groups);

    await replyText(event.replyToken, `已移除管理員：${arg}`);
    return true;
  }

  if (cmd === "/setowner") {
    if (!admin) {
      await replyText(event.replyToken, "只有管理員可以設定 owner。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/setowner 使用者ID");
      return true;
    }

    groups[chatId].ownerId = arg;
    addAdmin(groups, chatId, arg);
    saveGroups(groups);

    ensurePlan(plans, arg);
    savePlans(plans);

    await replyText(event.replyToken, `已設定 owner：${arg}`);
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

  const groups = readGroups();
  const plans = readPlans();

  ensureGroup(groups, chatId);
  saveGroups(groups);

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

  const ownerId = groups[chatId].ownerId;
  const plan = ownerId ? plans[ownerId] : null;

  if (!ownerId) {
    await replyText(event.replyToken, "本群尚未設定管理人，請先按語言選單。");
    return;
  }

  if (!isPlanActive(plan)) {
    await replyText(event.replyToken, "本群方案已到期或未開通，請管理人續費。");
    return;
  }

  if (!canUseGroup(plan, chatId)) {
    await replyText(event.replyToken, "此方案可用群組數量已滿，請升級方案。");
    return;
  }

  if (!(plan.boundGroups || []).includes(chatId)) {
    bindGroupToOwner(plans, ownerId, chatId);
    savePlans(plans);
  }

  const remainingDays = getRemainingDays(plan?.vipExpiresAt);
  if (remainingDays === 3) {
    await replyText(event.replyToken, `提醒：本群方案剩下 3 天到期\n到期時間：${formatDateTime(plan.vipExpiresAt)}`);
    return;
  }
  if (remainingDays === 1) {
    await replyText(event.replyToken, `提醒：本群方案剩下 1 天到期\n到期時間：${formatDateTime(plan.vipExpiresAt)}`);
    return;
  }

  const targetLangs = groups[chatId].langs || [];
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});