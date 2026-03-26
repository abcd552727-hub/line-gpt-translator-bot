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

const SUBS_FILE = "./group_subscriptions.json";

const LANG_LABELS = {
  "zh-TW": "繁體中文",
  "zh-CN": "简体中文",
  th: "ไทย",
  en: "English",
  vi: "Tiếng Việt",
  id: "Bahasa Indonesia",
  ja: "日本語",
  ko: "한국어",
};

function readSubs() {
  try {
    if (!fs.existsSync(SUBS_FILE)) {
      fs.writeFileSync(SUBS_FILE, "{}", "utf8");
    }
    return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  } catch (err) {
    console.error("readSubs error:", err);
    return {};
  }
}

function saveSubs(data) {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("saveSubs error:", err);
  }
}

function getChatId(event) {
  return event.source.groupId || event.source.roomId || event.source.userId;
}

function getChatType(event) {
  if (event.source.groupId) return "group";
  if (event.source.roomId) return "room";
  return "user";
}

function ensureChat(data, chatId) {
  if (!data[chatId]) {
    data[chatId] = {
      members: {},
    };
  }
}

function setMemberLang(data, chatId, userId, lang) {
  ensureChat(data, chatId);
  data[chatId].members[userId] = lang;
}

function getMemberLang(data, chatId, userId) {
  return data?.[chatId]?.members?.[userId] || null;
}

function getUniqueLangsInChat(data, chatId) {
  const members = data?.[chatId]?.members || {};
  return [...new Set(Object.values(members).filter(Boolean))];
}

function detectSourceLangSimple(text) {
  const hasThai = /[\u0E00-\u0E7F]/.test(text);
  const hasCJK = /[\u4E00-\u9FFF]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);

  if (hasThai) return "th";
  if (hasCJK) return "zh-TW";
  if (hasLatin) return "en";
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
5. 如果原文本來就是 ${targetLang}，也請自然重述成 ${targetLang} 常用表達

請翻譯以下內容：
${text}
    `.trim(),
  });

  return (response.output_text || "").trim();
}

function buildLanguageMenuFlex() {
  return {
    type: "flex",
    altText: "請選擇你的語言",
    contents: {
      type: "carousel",
      contents: [
        {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "text",
                text: "Choose Your Language",
                weight: "bold",
                size: "lg",
                align: "center",
              },
              {
                type: "text",
                text: "選一個你要看的語言",
                size: "sm",
                color: "#666666",
                align: "center",
                margin: "sm",
              },
            ],
          },
          footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              {
                type: "button",
                style: "primary",
                action: {
                  type: "postback",
                  label: "繁體中文 zh-TW",
                  data: "action=set_lang&lang=zh-TW",
                  displayText: "我選擇 繁體中文",
                },
              },
              {
                type: "button",
                style: "primary",
                action: {
                  type: "postback",
                  label: "ไทย th",
                  data: "action=set_lang&lang=th",
                  displayText: "我選擇 泰文",
                },
              },
              {
                type: "button",
                style: "primary",
                action: {
                  type: "postback",
                  label: "English en",
                  data: "action=set_lang&lang=en",
                  displayText: "I choose English",
                },
              },
              {
                type: "button",
                style: "primary",
                action: {
                  type: "postback",
                  label: "Tiếng Việt vi",
                  data: "action=set_lang&lang=vi",
                  displayText: "Tôi chọn tiếng Việt",
                },
              },
            ],
          },
        },
        {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "text",
                text: "More Languages",
                weight: "bold",
                size: "lg",
                align: "center",
              },
              {
                type: "text",
                text: "每個人都可以自己選",
                size: "sm",
                color: "#666666",
                align: "center",
                margin: "sm",
              },
            ],
          },
          footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              {
                type: "button",
                style: "primary",
                action: {
                  type: "postback",
                  label: "简体中文 zh-CN",
                  data: "action=set_lang&lang=zh-CN",
                  displayText: "我選擇 简体中文",
                },
              },
              {
                type: "button",
                style: "primary",
                action: {
                  type: "postback",
                  label: "Bahasa Indonesia id",
                  data: "action=set_lang&lang=id",
                  displayText: "Saya pilih Bahasa Indonesia",
                },
              },
              {
                type: "button",
                style: "primary",
                action: {
                  type: "postback",
                  label: "日本語 ja",
                  data: "action=set_lang&lang=ja",
                  displayText: "日本語を選択",
                },
              },
              {
                type: "button",
                style: "primary",
                action: {
                  type: "postback",
                  label: "한국어 ko",
                  data: "action=set_lang&lang=ko",
                  displayText: "한국어 선택",
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function buildChooseHintText() {
  return [
    "請先選擇你的語言。",
    "每個人都可以各自選一個語言，之後群組會自動翻譯。",
    "",
    "若要重選，輸入：/menu",
  ].join("\n");
}

function parsePostbackData(data) {
  const params = new URLSearchParams(data);
  return {
    action: params.get("action"),
    lang: params.get("lang"),
  };
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
    {
      type: "text",
      text: buildChooseHintText(),
    },
  ]);
}

async function handleJoin(event) {
  const chatId = getChatId(event);
  await pushLanguageMenu(chatId);
}

async function handleFollow(event) {
  await lineClient.replyMessage(event.replyToken, [
    buildLanguageMenuFlex(),
    {
      type: "text",
      text: "歡迎使用翻譯機器人，先選你的語言，之後我會自動翻譯。",
    },
  ]);
}

async function handlePostback(event) {
  const userId = event.source.userId;
  const chatId = getChatId(event);

  if (!userId || !chatId) {
    await replyText(event.replyToken, "無法辨識使用者或聊天室。");
    return;
  }

  const { action, lang } = parsePostbackData(event.postback.data || "");
  if (action !== "set_lang" || !LANG_LABELS[lang]) {
    await replyText(event.replyToken, "語言設定失敗，請重試。");
    return;
  }

  const subs = readSubs();
  setMemberLang(subs, chatId, userId, lang);
  saveSubs(subs);

  await replyText(
    event.replyToken,
    `已幫你設定為：${LANG_LABELS[lang]} (${lang})\n之後群組訊息會自動提供這個語言版本。`
  );
}

async function handleCommand(event, text) {
  const cmd = text.trim().toLowerCase();
  const chatId = getChatId(event);

  if (cmd === "/menu") {
    await replyMessages(event.replyToken, [
      buildLanguageMenuFlex(),
      { type: "text", text: buildChooseHintText() },
    ]);
    return true;
  }

  if (cmd === "/my") {
    const subs = readSubs();
    const lang = getMemberLang(subs, chatId, event.source.userId);
    await replyText(
      event.replyToken,
      lang
        ? `你目前設定的語言是：${LANG_LABELS[lang]} (${lang})`
        : "你還沒選語言，請輸入 /menu"
    );
    return true;
  }

  if (cmd === "/langs") {
    const subs = readSubs();
    const langs = getUniqueLangsInChat(subs, chatId);
    await replyText(
      event.replyToken,
      langs.length
        ? `本群目前已訂閱語言：${langs.map((l) => `${LANG_LABELS[l]}(${l})`).join("、")}`
        : "本群還沒有人訂閱語言，請輸入 /menu"
    );
    return true;
  }

  return false;
}

async function handleTextMessage(event) {
  const text = (event.message?.text || "").trim();
  if (!text) return;

  const isCommand = text.startsWith("/");
  if (isCommand) {
    const handled = await handleCommand(event, text);
    if (handled) return;
  }

  const chatType = getChatType(event);
  const chatId = getChatId(event);

  const subs = readSubs();

  if (chatType !== "user") {
    const myLang = getMemberLang(subs, chatId, event.source.userId);
    if (!myLang) {
      await replyMessages(event.replyToken, [
        buildLanguageMenuFlex(),
        {
          type: "text",
          text: "你還沒選語言，先按一個語言。之後群組就會自動翻譯。",
        },
      ]);
      return;
    }
  }

  const targetLangs =
    chatType === "user"
      ? ["zh-TW", "th"]
      : getUniqueLangsInChat(subs, chatId);

  if (!targetLangs.length) {
    await replyText(event.replyToken, "本群還沒有人選語言，請先輸入 /menu");
    return;
  }

  const sourceLang = detectSourceLangSimple(text);

  const langsToTranslate = targetLangs.filter((lang) => lang !== sourceLang);

  if (!langsToTranslate.length) {
    await replyText(
      event.replyToken,
      "目前群組訂閱的語言和原文相同，沒有需要翻譯的新語言。"
    );
    return;
  }

  const translations = [];
  for (const lang of langsToTranslate) {
    try {
      const translated = await translateToTarget(text, lang);
      translations.push(`【${LANG_LABELS[lang]} ${lang}】\n${translated}`);
    } catch (err) {
      console.error(`translate ${lang} error:`, err);
    }
  }

  if (!translations.length) {
    await replyText(event.replyToken, "翻譯失敗，請稍後再試。");
    return;
  }

  const output = translations.join("\n\n");
  await replyText(event.replyToken, output);
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
  res.status(200).send("LINE group subscription translator bot is running.");
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
