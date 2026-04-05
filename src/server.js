import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const app = express();
const { Pool } = pg;

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const MODEL = "gpt-5.4-mini";
const CONTACT_LINE_ID = "aszx88188";

// =========================
// 🔥 翻譯核心（最穩定）
// =========================

async function translate(text, targetLang) {
  const prompt = `
你是專業翻譯器。

規則：
1. 只翻譯，不聊天
2. 不可增加內容
3. 不可刪減內容（每個字都要處理）
4. 可依上下文理解，但不可改寫原意
5. 語氣詞可省略（例如 ค่ะ / โอเค），但不可亂補
6. 不可補「謝謝、辛苦了」
7. 不可亂翻「ที่」為因為
8. 不可漏翻任何詞語

重要：
- 不可輸出原文語言
- 英文必須是純英文

目標語言：${targetLang}

內容：
${text}
`;

  let res = await openai.responses.create({
    model: MODEL,
    temperature: 0.2,
    input: prompt,
  });

  let output = res.output_text.trim();

  // 🔥 英文強制修正
  if (targetLang === "English") {
    if (/[\u4E00-\u9FFF\u0E00-\u0E7F]/.test(output)) {
      res = await openai.responses.create({
        model: MODEL,
        temperature: 0,
        input: `Translate into natural English only:\n${text}`,
      });
      output = res.output_text.trim();
    }
  }

  return output;
}

// =========================
// 🔥 語言判斷
// =========================

function detectLang(text) {
  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  return "en";
}

// =========================
// 🔥 DB 初始化
// =========================

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plans (
      user_id TEXT PRIMARY KEY,
      plan_type TEXT,
      vip_expires_at TIMESTAMPTZ,
      daily_limit INTEGER,
      trial_type TEXT,
      bound_groups JSONB DEFAULT '[]'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      chat_id TEXT PRIMARY KEY,
      owner_id TEXT,
      langs JSONB DEFAULT '[]',
      is_trial_group BOOLEAN DEFAULT FALSE
    );
  `);
}

// =========================
// 🔥 試用方案
// =========================

function createTrial(userId, days) {
  return {
    user_id: userId,
    plan_type: `trial_${days}`,
    vip_expires_at: new Date(Date.now() + days * 86400000),
    daily_limit: null,
    trial_type: `${days}天試用`,
    bound_groups: [],
  };
}

// =========================
// 🔥 指令處理
// =========================

async function handleCommand(event, text) {
  const userId = event.source.userId;
  const chatId = event.source.groupId || userId;

  const groupRes = await pool.query(
    "SELECT * FROM groups WHERE chat_id=$1",
    [chatId]
  );
  let group = groupRes.rows[0];

  if (!group) {
    await pool.query(
      "INSERT INTO groups(chat_id, langs) VALUES($1,'[]')",
      [chatId]
    );
    group = { langs: [], is_trial_group: false };
  }

  if (text === "/設為試用群") {
    await pool.query(
      "UPDATE groups SET is_trial_group=TRUE WHERE chat_id=$1",
      [chatId]
    );
    return "已設為試用群";
  }

  if (text === "/取消試用群") {
    await pool.query(
      "UPDATE groups SET is_trial_group=FALSE WHERE chat_id=$1",
      [chatId]
    );
    return "已取消試用群";
  }

  if (text.startsWith("/試用7天")) {
    const id = text.split(" ")[1];
    const plan = createTrial(id, 7);

    await pool.query(
      `INSERT INTO plans(user_id,plan_type,vip_expires_at,daily_limit,trial_type,bound_groups)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(user_id) DO UPDATE SET plan_type=$2,vip_expires_at=$3`,
      [
        plan.user_id,
        plan.plan_type,
        plan.vip_expires_at,
        plan.daily_limit,
        plan.trial_type,
        JSON.stringify([]),
      ]
    );

    return "已開通7天試用";
  }

  if (text.startsWith("/試用14天")) {
    const id = text.split(" ")[1];
    const plan = createTrial(id, 14);

    await pool.query(
      `INSERT INTO plans(user_id,plan_type,vip_expires_at,daily_limit,trial_type,bound_groups)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(user_id) DO UPDATE SET plan_type=$2,vip_expires_at=$3`,
      [
        plan.user_id,
        plan.plan_type,
        plan.vip_expires_at,
        plan.daily_limit,
        plan.trial_type,
        JSON.stringify([]),
      ]
    );

    return "已開通14天試用";
  }

  if (text === "/價格") {
    if (group.is_trial_group) {
      return `
試用方案
7天試用（不限群組）
14天試用（不限群組）
聯絡LINE：${CONTACT_LINE_ID}
`;
    }

    return `
翻譯機器人方案
試用7天
試用14天
1群/月 500
不限群/月 1500
LINE：${CONTACT_LINE_ID}
`;
  }

  return null;
}

// =========================
// 🔥 訊息處理
// =========================

async function handleMessage(event) {
  const text = event.message.text;

  if (text.startsWith("/")) {
    const res = await handleCommand(event, text);
    if (res) {
      await lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: res,
      });
      return;
    }
  }

  const source = detectLang(text);

  let targets = [];
  if (source === "th") targets = ["繁體中文"];
  else if (source === "zh") targets = ["泰文"];
  else targets = ["繁體中文"];

  const results = await Promise.all(
    targets.map(async (lang) => {
      const t = await translate(text, lang);
      return `[${lang}] ${t}`;
    })
  );

  await lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: results.join("\n"),
  });
}

// =========================
// webhook
// =========================

app.post("/webhook", middleware({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
}), async (req, res) => {

  res.sendStatus(200);

  for (const event of req.body.events) {
    if (event.type === "message" && event.message.type === "text") {
      await handleMessage(event);
    }
  }
});

initDb().then(() => {
  app.listen(process.env.PORT || 3000, () => {
    console.log("🔥 最終版運行中");
  });
});
