import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

process.on("uncaughtException", (err) => {
  console.error("uncaughtException =", err);
  if (err?.stack) console.error(err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection =", reason);
  if (reason?.stack) console.error(reason.stack);
});

const { Pool } = pg;

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-5.4-mini",
  DATABASE_URL,
  PORT = 3000,
} = process.env;

const missingVars = [];
if (!LINE_CHANNEL_ACCESS_TOKEN) missingVars.push("LINE_CHANNEL_ACCESS_TOKEN");
if (!LINE_CHANNEL_SECRET) missingVars.push("LINE_CHANNEL_SECRET");
if (!OPENAI_API_KEY) missingVars.push("OPENAI_API_KEY");
if (!DATABASE_URL) missingVars.push("DATABASE_URL");

if (missingVars.length > 0) {
  console.error("Missing required environment variables:", missingVars.join(", "));
  process.exit(1);
}

const CONTACT_LINE_ID = "aszx88188";
const MEMBER_LIST_PAGE_SIZE = 10;

const FIXED_TERM_MAP = {
  "เหิงซุน": "เหิงซุน",
  "เฮงชุน": "恆春",
};

const CONTEXT_TYPO_MAP = [
  {
    wrong: "บอท",
    intended: "บอส",
    zh: "老闆",
    hint: "在真人聊天、服務、工作、陪聊、接客、請求對方配合的情境中，若出現「บอทคะ / บอทค่ะ / บอท」但上下文明顯是在稱呼真人，優先視為誤打的「บอส」，翻成「老闆」，不要翻成「機器人」。"
  },
  {
    wrong: "บอก",
    intended: "บอส",
    zh: "老闆",
    hint: "若句首出現「บอกคะ / บอกค่ะ」且後面接請求、稱呼、撒嬌、工作配合內容，優先視為誤打的「บอสคะ / บอสค่ะ」，翻成「老闆」。"
  }
];

const SUPER_ADMINS = [
  "U96da7afef783339acc1959c20b445f9c",
  "Uceba5819446e95c6cb0f12f8e27157aa",
];

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
  if (!plan) return false;

  if (plan.plan_type === "free_trial") {
    return true;
  }

  if (!plan.vip_expires_at) return false;
  return new Date(plan.vip_expires_at).getTime() > Date.now();
}

function canUseGroup(plan, groupId) {
  if (!plan) return false;

  if (plan.plan_type === "trial_7days") {
    return true;
  }

  if (plan.plan_type === "free_trial") {
    const groups = Array.isArray(plan.bound_groups) ? plan.bound_groups : [];
    if (groups.includes(groupId)) return true;
    return groups.length < 1;
  }

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

function detectSourceLangSimple(text = "") {
  const t = String(text || "").trim();

  if (!t) return "auto";

  const thaiCount = (t.match(/[\u0E00-\u0E7F]/g) || []).length;
  const chineseCount = (t.match(/[\u4E00-\u9FFF]/g) || []).length;
  const latinCount = (t.match(/[A-Za-z]/g) || []).length;
  const myCount = (t.match(/[\u1000-\u109F]/g) || []).length;
  const jaCount = (t.match(/[\u3040-\u30FF\u31F0-\u31FF]/g) || []).length;
  const koCount = (t.match(/[\uAC00-\uD7AF]/g) || []).length;
  const arCount = (t.match(/[\u0600-\u06FF]/g) || []).length;
  const hiCount = (t.match(/[\u0900-\u097F]/g) || []).length;
  const kmCount = (t.match(/[\u1780-\u17FF]/g) || []).length;
  const loCount = (t.match(/[\u0E80-\u0EFF]/g) || []).length;

  const counts = [
    ["th", thaiCount],
    ["zh-TW", chineseCount],
    ["en", latinCount],
    ["my", myCount],
    ["ja", jaCount],
    ["ko", koCount],
    ["ar", arCount],
    ["hi", hiCount],
    ["km", kmCount],
    ["lo", loCount],
  ].sort((a, b) => b[1] - a[1]);

  const [topLang, topCount] = counts[0];
  if (!topCount || topCount <= 0) return "auto";

  return topLang;
}

function getLangPureName(lang) {
  const map = {
    "zh-TW": "繁體中文",
    "zh-CN": "簡體中文",
    th: "泰文",
    en: "英文",
    vi: "越南文",
    id: "印尼文",
    my: "緬甸文",
    ja: "日文",
    ko: "韓文",
    tl: "菲律賓文",
    hi: "印度文",
    tr: "土耳其文",
    fr: "法文",
    ms: "馬來文",
    km: "高棉文",
    lo: "寮文",
    ar: "阿拉伯文",
  };
  return map[lang] || lang;
}

function hasChinese(text = "") {
  return /[\u4E00-\u9FFF]/.test(String(text || ""));
}

function hasThai(text = "") {
  return /[\u0E00-\u0E7F]/.test(String(text || ""));
}

function isMixedChineseThai(text = "") {
  return hasChinese(text) && hasThai(text);
}

function cleanupTranslation(text = "") {
  return String(text || "")
    .replace(/^\s*翻譯[:：]\s*/i, "")
    .replace(/^\s*translation[:：]\s*/i, "")
    .replace(/^["「『]+|["」』]+$/g, "")
    .trim();
}

function isVeryShortText(text = "") {
  const cleaned = String(text || "").trim().replace(/\s+/g, "");
  return cleaned.length > 0 && cleaned.length <= 14;
}

function looksLikeThaiShortChat(text = "") {
  if (!hasThai(text)) return false;

  const t = String(text || "").trim().toLowerCase();

  return (
    isVeryShortText(t) ||
    /^(ยัง|ยังคะ|ยังค่ะ|ยังครับ|ยังไหม|ยังมั้ย|ยังหรอ|ยังเหรอ|ได้|ได้ค่ะ|ได้คะ|ได้ครับ|ค่ะ|คะ|ครับ|หรอ|เหรอ|อ่อ|อืม|จ้า|จ๋า|นะ|น้า|อยู่ไหม|อยู่มั้ย|หายไปไหน|โอเคไหม|ได้ไหม|มาไหม)$/.test(
      t
    )
  );
}

function looksLikeThaiDialectText(text = "") {
  const t = String(text || "").trim();
  if (!hasThai(t)) return false;

  if (isVeryShortText(t)) return true;

  return /เด้อ|บ่|อีหลี|หลายอยู่|นิ|แหลง|หรอย|ก่อ|เน้อ|จะได|เฮา|ข้อย/.test(t);
}

function looksLikeNamedEntityShortText(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (!hasThai(t)) return false;

  const noSpace = t.replace(/\s+/g, "");
  return noSpace.length >= 2 && noSpace.length <= 30 && !/[。，！？.!?]/.test(t);
}

function looksLikePossiblePlaceName(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (!hasThai(t)) return false;
  if (t.includes(" ")) return false;

  const noSpaceLen = t.replace(/\s+/g, "").length;

  return (
    noSpaceLen >= 4 &&
    noSpaceLen <= 20 &&
    !/[0-9]/.test(t) &&
    !/[。，！？.!?]/.test(t)
  );
}

function getMatchedFixedTerms(text = "") {
  const matched = [];

  for (const [src, target] of Object.entries(FIXED_TERM_MAP)) {
    if (String(text || "").includes(src)) {
      matched.push({ src, target });
    }
  }

  return matched;
}

function buildFixedTermsHint(text = "") {
  const matched = getMatchedFixedTerms(text);
  if (!matched.length) return "";

  return [
    "【固定術語表】",
    ...matched.map((item) => `${item.src} => ${item.target}`),
    "以上詞語必須固定使用，不可改寫，不可換成其他猜測地名、人名或店名。"
  ].join("\n");
}

function getMatchedContextTypos(text = "") {
  const t = String(text || "");
  return CONTEXT_TYPO_MAP.filter(item => t.includes(item.wrong));
}

function buildContextTypoHint(text = "") {
  const matched = getMatchedContextTypos(text);
  if (!matched.length) return "";

  return [
    "【情境糾錯規則】",
    ...matched.map(item => `${item.wrong} 可能是 ${item.intended}，中文優先翻成「${item.zh}」`),
    ...matched.map(item => item.hint),
    "若上下文是在對真人說話，不可翻成機器人。"
  ].join("\n");
}

function normalizeLangList(langs = []) {
  const seen = new Set();
  const result = [];

  for (const lang of langs) {
    if (!LANG_LABELS[lang]) continue;
    if (seen.has(lang)) continue;
    seen.add(lang);
    result.push(lang);
  }

  return result;
}

function safeTranslatedLine(lang, translated) {
  const clean = cleanupTranslation(translated);
  if (!clean) return null;
  return `[${lang}] ${clean}`;
}

function getGroupLimitText(plan) {
  if (!plan) return "未設定";
  if (plan.plan_type === "unlimited_groups" || plan.plan_type === "trial_7days") return "不限";
  return String(plan.group_limit ?? "1");
}

function parsePositiveInt(value, defaultValue = 1) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return defaultValue;
  return num;
}

async function askModelTranslate({
  text,
  targetLang,
  sourceHint = "auto",
  specialHint = "",
}) {
  const targetName = getLangPureName(targetLang);
  const fixedTermsHint = buildFixedTermsHint(text);
  const contextTypoHint = buildContextTypoHint(text);

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    input: `
你是專業翻譯機器人，只能翻譯，不可聊天。

任務：
把以下內容翻譯成「${targetName}」。

翻譯規則：
1. 只做翻譯，不可回話
2. 不可腦補對話、人物關係、情緒
3. 保留原文語氣，口語就翻口語
4. 人名、暱稱、店名、地名、公司名、專有名詞、金額、時間，若能確認正式中文，直接使用正式中文
5. 若無法確認正式中文，但看起來像地名、人名、店名或其他專有名詞，不可直接整段不翻
6. 查不到正式名稱時，請優先用自然的中文音譯或諧音方式表達，讓讀者可依上下文猜測意思
7. 音譯後仍要保留整句語意，讓整句能看懂前後文
8. 不可自行捏造明確但錯誤的正式地名；若無把握，使用偏口語的音譯表達即可
9. 若原文是短句，請翻成最自然、最常見的聊天說法
10. 不可加前綴，不可解釋，不可摘要
11. 不可輸出「好的親愛的、Yes dear、OK honey」這種腦補內容
12. 原文可能是 LINE 對話、泰國口語、方言、混合語言
13. 若句意不完整，請忠實翻出最可能意思，但不要擴寫
14. 只輸出最終翻譯結果
15. 若固定術語表有指定詞語，必須優先使用，不可改寫
16. 若原文有常見誤拼、近音字、聊天誤打，必須優先依上下文修正後再翻譯
17. 在真人聊天情境中，若「บอท / บอก」更可能是誤打的「บอส」，優先翻成「老闆」，不要翻成「機器人」

來源語言提示：${sourceHint}
補充提示：${specialHint || "無"}

${fixedTermsHint || ""}
${contextTypoHint || ""}

內容：
${text}
    `.trim(),
  });

  return cleanupTranslation(response.output_text || "");
}

async function verifyPlaceNameOnline(text) {
  return {
    found: false,
    zhName: null,
    rawName: text,
    confidence: 0,
  };
}

async function translateThaiDialectToChinese(text, targetLang = "zh-TW") {
  const targetName = targetLang === "zh-CN" ? "簡體中文" : "繁體中文";
  const fixedTerms = getMatchedFixedTerms(text);
  const allowOriginalTerm = fixedTerms.some((item) => item.target === item.src);

  return await askModelTranslate({
    text,
    targetLang,
    sourceHint: "泰文或泰國方言",
    specialHint: `
這段可能含泰國各地口語或方言。
像「ยัง / ยังคะ / ยังค่ะ」這類超短句，優先理解成：
還嗎、還沒嗎、還在嗎、還有嗎。
不可亂翻成回答句。
若碰到無法確認正式中文的地名、人名、店名：
- 若固定術語表已指定，必須照固定術語表
- 若未指定，才可用中文諧音或音譯呈現
${allowOriginalTerm ? "若固定術語表指定保留原詞，可保留該原詞。" : `目標語言必須是純${targetName}。`}
    `.trim(),
  });
}

async function translateToTarget(text, targetLang) {
  const sourceLang = detectSourceLangSimple(text);
  const thaiShortChat = looksLikeThaiShortChat(text);
  const thaiDialect = looksLikeThaiDialectText(text);
  const mixedZhTh = isMixedChineseThai(text);
  const namedEntityShort = looksLikeNamedEntityShortText(text);
  const possiblePlaceName = looksLikePossiblePlaceName(text);
  const fixedTerms = getMatchedFixedTerms(text);

  if ((targetLang === "zh-TW" || targetLang === "zh-CN") && possiblePlaceName) {
    const verified = await verifyPlaceNameOnline(text);
    if (verified?.found && verified?.zhName && verified.confidence >= 0.85) {
      return verified.zhName;
    }
  }

  if ((targetLang === "zh-TW" || targetLang === "zh-CN") && (thaiShortChat || thaiDialect)) {
    return await translateThaiDialectToChinese(text, targetLang);
  }

  let specialHint = "";

  if (fixedTerms.length) {
    specialHint += " 這句包含固定術語，必須優先使用固定術語表，不可自行改寫。";
  }

  if (thaiShortChat) {
    specialHint += " 這是泰文超短聊天句，請翻成自然聊天語氣，不可腦補成回答句。";
  }

  if (mixedZhTh) {
    specialHint += " 這是中泰混合內容，請依整句語意整理成目標語言，不要漏掉任一部分。";
  }

  if (namedEntityShort) {
    specialHint += " 這句可能含專有名詞或聊天誤拼。若某個詞看似專有名詞，但依上下文更像是在稱呼真人，例如老闆、主管、客人、女生、男生，請優先依情境修正，不要只按字面翻譯。若無法確認正式中文，請優先遵守固定術語表；若固定術語表未指定，再用中文可讀諧音或音譯表達，並保留整句可理解的語意。";
  }

  if (targetLang === "th") {
    specialHint += " 請輸出自然泰文聊天用語，不要太書面。";
  }

  if (targetLang === "zh-TW") {
    specialHint += " 請輸出自然繁體中文，不要中國式生硬書面句。若遇到疑似地名、人名、店名但查不到正式中文，優先遵守固定術語表；若固定術語表未指定，再考慮中文諧音或音譯。";
  }

  if (targetLang === "zh-CN") {
    specialHint += " 請輸出自然简体中文。若遇到疑似地名、人名、店名但查不到正式中文，優先遵守固定術語表；若固定術語表未指定，再考慮中文諧音或音譯。";
  }

  if (targetLang === "en") {
    specialHint += " 請輸出自然英文聊天語氣。";
  }

  let output = await askModelTranslate({
    text,
    targetLang,
    sourceHint: sourceLang,
    specialHint: specialHint.trim(),
  });

  if (targetLang === "th" && hasChinese(output)) {
    output = await askModelTranslate({
      text,
      targetLang,
      sourceHint: sourceLang,
      specialHint: `${specialHint} 只可輸出純泰文，不可出現中文。`.trim(),
    });
  }

  if ((targetLang === "zh-TW" || targetLang === "zh-CN") && hasThai(output)) {
    const allowOriginalTerm = fixedTerms.some((item) => item.target === item.src);

    if (!allowOriginalTerm) {
      output = await askModelTranslate({
        text,
        targetLang,
        sourceHint: sourceLang,
        specialHint: `${specialHint} 只可輸出純中文，不可出現泰文；但若固定術語表指定保留原詞，則可保留該原詞。`.trim(),
      });
    }
  }

  if (targetLang === "en" && /[\u4E00-\u9FFF\u0E00-\u0E7F]/.test(output) && !/[A-Za-z]/.test(output)) {
    output = await askModelTranslate({
      text,
      targetLang,
      sourceHint: sourceLang,
      specialHint: `${specialHint} 只可輸出純英文，不可出現中文或泰文。`.trim(),
    });
  }

  return cleanupTranslation(output);
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
              {
                type: "text",
                text: "群組語言設定",
                weight: "bold",
                size: "lg",
                align: "center",
              },
              {
                type: "text",
                text: "只有授權管理人可設定",
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
              {
                type: "text",
                text: "更多語言 1",
                weight: "bold",
                size: "lg",
                align: "center",
              },
              {
                type: "text",
                text: "可複選",
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
              {
                type: "text",
                text: "更多語言 2",
                weight: "bold",
                size: "lg",
                align: "center",
              },
              {
                type: "text",
                text: "營運版擴充",
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
              addButton("韓文 ko", "ko"),
              addButton("菲律賓 tl", "tl"),
              addButton("印度 hi", "hi"),
              addButton("土耳其 tr", "tr"),
              removeButton("韓文 ko", "ko"),
              removeButton("菲律賓 tl", "tl"),
              removeButton("印度 hi", "hi"),
              removeButton("土耳其 tr", "tr"),
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
                text: "更多語言 3",
                weight: "bold",
                size: "lg",
                align: "center",
              },
              {
                type: "text",
                text: "其他常用語言",
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
              addButton("法文 fr", "fr"),
              addButton("馬來 ms", "ms"),
              addButton("高棉 km", "km"),
              addButton("寮文 lo", "lo"),
              removeButton("法文 fr", "fr"),
              removeButton("馬來 ms", "ms"),
              removeButton("高棉 km", "km"),
              removeButton("寮文 lo", "lo"),
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
    `試用類型：${plan?.trial_type || "無"}`,
    `每日上限：${plan?.daily_limit ?? "不限"}`,
    `群組上限：${getGroupLimitText(plan)}`,
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
    `試用類型：${plan.trial_type || "無"}`,
    `每日上限：${plan.daily_limit ?? "不限"}`,
    `群組上限：${getGroupLimitText(plan)}`,
    `已綁群組：${(plan.bound_groups || []).length}`,
    `到期時間：${plan.vip_expires_at ? formatDateTime(plan.vip_expires_at) : "未設定"}`,
    `VIP狀態：${isPlanActive(plan) ? "有效" : "已到期 / 未開通"}`,
  ].join("\n");
}

function buildUserHelpText() {
  return [
    "可用指令：",
    "/幫助",
    "/到期時間",
    "/價格",
    "/語言",
    "/我的方案",
    "/我的ID",
    "",
    "說明：",
    "新加入可先使用每日免費20句",
    "7天試用請聯絡管理員開通",
    `續費請聯絡 LINE：${CONTACT_LINE_ID}`,
  ].join("\n");
}

function buildAdminHelpText(superAdmin) {
  const lines = [
    "管理版指令：",
    "/幫助",
    "/狀態",
    "/語言",
    "/我的方案",
    "/到期時間",
    "/價格",
    "/我的ID",
    "/語言選單",
  ];

  if (superAdmin) {
    lines.push(
      "/綁定",
      "/解除綁定",
      "/1群方案",
      "/3群方案",
      "/5群方案",
      "/開通不限30",
      "/開通不限90",
      "/新增管理員 使用者ID",
      "/刪除管理員 使用者ID",
      "/設定擁有者 使用者ID",
      "/開通1群 使用者ID",
      "/開通3群 使用者ID",
      "/開通5群 使用者ID",
      "/試用7天 使用者ID",
      "/查方案 使用者ID",
      "/停用 使用者ID",
      "/全部會員 [頁數]",
      "/會員列表 [頁數]"
    );
  }

  return lines.join("\n");
}

function buildAllPlansText(plans = [], page = 1, totalPages = 1, totalCount = 0) {
  if (!plans.length) {
    return "目前沒有任何會員資料。";
  }

  const lines = [`會員列表（第 ${page}/${totalPages} 頁，共 ${totalCount} 筆）：`, ""];

  for (const plan of plans) {
    const boundCount = Array.isArray(plan.bound_groups) ? plan.bound_groups.length : 0;
    const vipStatus = isPlanActive(plan) ? "有效" : "已到期 / 未開通";

    lines.push(
      [
        `使用者：${plan.user_id}`,
        `方案：${plan.plan_type || "未開通"}`,
        `試用類型：${plan.trial_type || "無"}`,
        `每日上限：${plan.daily_limit ?? "不限"}`,
        `群組上限：${getGroupLimitText(plan)}`,
        `已綁群組：${boundCount}`,
        `到期時間：${plan.vip_expires_at ? formatDateTime(plan.vip_expires_at) : "未設定"}`,
        `VIP狀態：${vipStatus}`,
        "--------------------",
      ].join("\n")
    );
  }

  if (page < totalPages) {
    lines.push(`下一頁請輸入：/全部會員 ${page + 1}`);
  }

  return lines.join("\n");
}

async function replyText(replyToken, text) {
  return lineClient.replyMessage(replyToken, {
    type: "text",
    text: String(text || "").slice(0, 5000),
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
    ALTER TABLE plans
      ADD COLUMN IF NOT EXISTS daily_limit INTEGER;
  `);

  await pool.query(`
    ALTER TABLE plans
      ADD COLUMN IF NOT EXISTS trial_type TEXT;
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      date TEXT NOT NULL,
