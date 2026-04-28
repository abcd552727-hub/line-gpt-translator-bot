import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import pg from "pg";
import crypto from "crypto";

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

const OPENAI_TIMEOUT_MS = Math.max(
  8000,
  Number(process.env.OPENAI_TIMEOUT_MS || 20000)
);

const OPENAI_MAX_RETRIES = Math.max(
  0,
  Number(process.env.OPENAI_MAX_RETRIES || 1)
);

const OPENAI_REASONING_EFFORT =
  process.env.OPENAI_REASONING_EFFORT || "none";

const WEBHOOK_EVENT_CONCURRENCY = Math.max(
  1,
  Number(process.env.WEBHOOK_EVENT_CONCURRENCY || 2)
);

const MAX_TRANSLATION_RETRIES = Math.max(
  1,
  Number(process.env.MAX_TRANSLATION_RETRIES || 2)
);

const LOG_TIMING = process.env.LOG_TIMING !== "0";

const missingVars = [];
if (!LINE_CHANNEL_ACCESS_TOKEN) missingVars.push("LINE_CHANNEL_ACCESS_TOKEN");
if (!LINE_CHANNEL_SECRET) missingVars.push("LINE_CHANNEL_SECRET");
if (!OPENAI_API_KEY) missingVars.push("OPENAI_API_KEY");
if (!DATABASE_URL) missingVars.push("DATABASE_URL");

if (missingVars.length > 0) {
  console.error("Missing required environment variables:", missingVars.join(", "));
  process.exit(1);
}

const CONTACT_LINE_ID = process.env.CONTACT_LINE_ID || "aszx88188";
const GOOGLE_SHEETS_WEBHOOK_URL =
  process.env.GOOGLE_SHEETS_WEBHOOK_URL ||
  "https://script.google.com/macros/s/AKfycbwmiEMNs7_RpDTfhL01JnTamnhR7FgiwnWVjRDhQjIn1BO8x5Je50IIt9LcLRyfZ87E2Q/exec";

const MEMBER_LIST_PAGE_SIZE = 10;

// 有改翻譯規則就改版本，避免舊快取把錯誤翻譯拿出來
const CACHE_VERSION = "v11-strict-stable-translate-rules";

const FIXED_TERM_MAP = {
  \u0E40\u0E2B\u0E34\u0E07\u0E0B\u0E38\u0E19: "恆春",
  \u0E40\u0E2E\u0E07\u0E0A\u0E38\u0E19: "恆春",
};

// 只保留高信心糾錯。不要把所有「\u0E1A\u0E2D\u0E01」都當成老闆，因為 \u0E1A\u0E2D\u0E01 原意是「說 / 告訴」。
const CONTEXT_TYPO_RULES = [
  {
    name: "bot_to_boss",
    test: (text) => /(^|\s)\u0E1A\u0E2D\u0E17(\u0E04\u0E30|\u0E04\u0E48\u0E30|\u0E04\u0E23\u0E31\u0E1A|\u0E04\u0E31\u0E1A)?(\s|$)/i.test(String(text || "")),
    hint:
      "若「\u0E1A\u0E2D\u0E17/\u0E1A\u0E2D\u0E17\u0E04\u0E30/\u0E1A\u0E2D\u0E17\u0E04\u0E48\u0E30」出現在對真人說話、請求配合、工作服務聊天情境，通常是誤打「\u0E1A\u0E2D\u0E2A」，中文可翻「老闆」；若真的是機器人，才翻成機器人。",
  },
  {
    name: "bok_title_to_boss_only_at_beginning",
    test: (text) =>
      /^(\u0E1A\u0E2D\u0E01|\u0E1A\u0E2D\u0E01\u0E04\u0E30|\u0E1A\u0E2D\u0E01\u0E04\u0E48\u0E30|\u0E1A\u0E2D\u0E01\u0E04\u0E23\u0E31\u0E1A|\u0E1A\u0E2D\u0E01\u0E04\u0E31\u0E1A)(\s|$)/i.test(String(text || "").trim()) &&
      String(text || "").trim().length <= 40,
    hint:
      "只有句首短稱呼「\u0E1A\u0E2D\u0E01\u0E04\u0E30/\u0E1A\u0E2D\u0E01\u0E04\u0E48\u0E30/\u0E1A\u0E2D\u0E01\u0E04\u0E23\u0E31\u0E1A」且後面是請求或撒嬌語氣時，才可能是誤打「\u0E1A\u0E2D\u0E2A」，可依語境翻「老闆」。一般句子中的 \u0E1A\u0E2D\u0E01 必須照原意翻成「說/告訴」。"const THAI_SHORT_CHAT_DIRECT_ZH_MAP = {
  \u0E44\u0E21\u0E48\u0E04\u0E48\u0E30: "不是",
  \u0E44\u0E21\u0E48\u0E04\u0E30: "不是",
  \u0E44\u0E21\u0E48\u0E04\u0E23\u0E31\u0E1A: "不是",
  \u0E44\u0E21\u0E48\u0E19\u0E30\u0E04\u0E30: "不是",
  \u0E44\u0E21\u0E48\u0E19\u0E30\u0E04\u0E23\u0E31\u0E1A: "不是",
  \u0E44\u0E21\u0E48\u0E43\u0E0A\u0E48\u0E04\u0E48\u0E30: "不是",
  \u0E44\u0E21\u0E48\u0E43\u0E0A\u0E48\u0E04\u0E30: "不是",
  \u0E44\u0E21\u0E48\u0E43\u0E0A\u0E48\u0E04\u0E23\u0E31\u0E1A: "不是",
  \u0E44\u0E14\u0E49\u0E04\u0E48\u0E30: "可以",
  \u0E44\u0E14\u0E49\u0E04\u0E30: "可以",
  \u0E44\u0E14\u0E49\u0E04\u0E23\u0E31\u0E1A: "可以",
  \u0E42\u0E2D\u0E40\u0E04\u0E04\u0E48\u0E30: "好",
  \u0E42\u0E2D\u0E40\u0E04\u0E04\u0E30: "好",
  \u0E42\u0E2D\u0E40\u0E04\u0E04\u0E23\u0E31\u0E1A: "好",
  \u0E42\u0E2D\u0E40\u0E04: "好",
  \u0E43\u0E0A\u0E48\u0E04\u0E48\u0E30: "是",
  \u0E43\u0E0A\u0E48\u0E04\u0E30: "是",
  \u0E43\u0E0A\u0E48\u0E04\u0E23\u0E31\u0E1A: "是",
  \u0E2D\u0E22\u0E39\u0E48\u0E44\u0E2B\u0E21: "在嗎",
  \u0E2D\u0E22\u0E39\u0E48\u0E21\u0E31\u0E49\u0E22: "在嗎",
  \u0E44\u0E14\u0E49\u0E44\u0E2B\u0E21: "可以嗎",
  \u0E21\u0E32\u0E44\u0E2B\u0E21: "要來嗎",
  \u0E44\u0E21\u0E48\u0E40\u0E1B\u0E47\u0E19\u0E44\u0E23: "沒關係",
  \u0E44\u0E21\u0E48\u0E40\u0E1B\u0E47\u0E19\u0E44\u0E23\u0E04\u0E48\u0E30: "沒關係",
  \u0E44\u0E21\u0E48\u0E40\u0E1B\u0E47\u0E19\u0E44\u0E23\u0E04\u0E23\u0E31\u0E1A: "沒關係",
  \u0E22\u0E31\u0E07: "還沒",
  \u0E22\u0E31\u0E07\u0E04\u0E30: "還沒",
  \u0E22\u0E31\u0E07\u0E04\u0E48\u0E30: "還沒",
  \u0E22\u0E31\u0E07\u0E04\u0E23\u0E31\u0E1A: "還沒",
  \u0E22\u0E31\u0E07\u0E44\u0E2B\u0E21: "還沒嗎",
  \u0E22\u0E31\u0E07\u0E21\u0E31\u0E49\u0E22: "還沒嗎",
  \u0E22\u0E31\u0E07\u0E2B\u0E23\u0E2D: "還沒嗎",
  \u0E22\u0E31\u0E07\u0E40\u0E2B\u0E23\u0E2D: "還沒嗎",
};

"還沒嗎",
};

const SUPER_ADMINS = [
  "U96da7afef783339acc1959c20b445f9c",
  "Uceba5819446e95c6cb0f12f8e27157aa",
];

const LANG_LABELS = {
  "zh-TW": "繁體中文",
  "zh-CN": "简体中文",
  th: "\u0E44\u0E17\u0E22",
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

const app = express();

const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};

const lineClient = new Client(lineConfig);

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  timeout: OPENAI_TIMEOUT_MS,
  maxRetries: OPENAI_MAX_RETRIES,
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
 * 基礎工具
 * ======================================================= */

function logTiming(label, startAt, extra = "") {
  if (!LOG_TIMING) return;
  const ms = Date.now() - startAt;
  console.log(`[TIMING] ${label}: ${ms}ms${extra ? ` | ${extra}` : ""}`);
}

async function runWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;

      try {
        const value = await worker(items[currentIndex], currentIndex);
        results[currentIndex] = { status: "fulfilled", value };
      } catch (reason) {
        results[currentIndex] = { status: "rejected", reason };
      }
    }
  }

  const runnerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: runnerCount }, () => runner()));
  return results;
}

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

function parsePositiveInt(value, defaultValue = 1) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return defaultValue;
  return num;
}

function cleanupTranslation(text = "") {
  return String(text || "")
    .replace(/^\s*翻譯[:：]\s*/i, "")
    .replace(/^\s*translation[:：]\s*/i, "")
    .replace(/^\s*(繁體中文|繁中|中文|簡體中文|简体中文|泰文|\u0E44\u0E17\u0E22|英文|English|越南文|印尼文|日文|韓文|韩文)[:：]\s*/i, "")
    .replace(/^\s*【[^】]{1,20}】\s*/i, "")
    .replace(/^["「『]+|["」』]+$/g, "")
    .trim();
}

function normalizeComparableText(text = "") {
  return cleanupTranslation(text)
    .replace(/\s+/g, "")
    .replace(/[「」『』"'`]/g, "")
    .trim()
    .toLowerCase();
}

function isSameText(a = "", b = "") {
  return normalizeComparableText(a) === normalizeComparableText(b);
}

function hasChinese(text = "") {
  return /[\u4E00-\u9FFF]/.test(String(text || ""));
}

function hasThai(text = "") {
  return /[\u0E00-\u0E7F]/.test(String(text || ""));
}

function hasMyanmar(text = "") {
  return /[\u1000-\u109F]/.test(String(text || ""));
}

function hasJapanese(text = "") {
  return /[\u3040-\u30FF\u31F0-\u31FF]/.test(String(text || ""));
}

function hasKorean(text = "") {
  return /[\uAC00-\uD7AF]/.test(String(text || ""));
}

function hasArabic(text = "") {
  return /[\u0600-\u06FF]/.test(String(text || ""));
}

function hasHindi(text = "") {
  return /[\u0900-\u097F]/.test(String(text || ""));
}

function hasKhmer(text = "") {
  return /[\u1780-\u17FF]/.test(String(text || ""));
}

function hasLao(text = "") {
  return /[\u0E80-\u0EFF]/.test(String(text || ""));
}

function isMixedChineseThai(text = "") {
  return hasChinese(text) && hasThai(text);
}

function detectChineseVariant(text = "") {
  const t = String(text || "");

  // 常見繁體專用字
  const traditionalOnlyCount = (t.match(/[這個們來會說話間點後過還沒嗎麼為裡給買賣開關聽對應該讓辦幫頭裡臺灣]/g) || []).length;

  // 常見簡體專用字
  const simplifiedOnlyCount = (t.match(/[这个们来会说话间点后过还没吗么为里给买卖开关听对应该让办帮头里台湾]/g) || []).length;

  if (simplifiedOnlyCount > traditionalOnlyCount) return "zh-CN";
  if (traditionalOnlyCount > simplifiedOnlyCount) return "zh-TW";

  // 判斷不出來時，預設繁體，符合台灣使用場景
  return "zh-TW";
}

function detectLatinLangHeuristic(text = "") {
  const t = String(text || "").toLowerCase();

  // 越南文常見聲調字
  if (/[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(t)) {
    return "vi";
  }

  // 土耳其文特殊字
  if (/[çğıöşü]/i.test(t)) return "tr";

  // 法文常見字
  if (/[àâæçéèêëîïôœùûüÿ]/i.test(t)) return "fr";

  // 印尼 / 馬來常見詞，僅作弱判斷
  if (/\b(aku|gue|gua|saya|kamu|anda|dia|tidak|nggak|gak|bisa|terima|kasih|berapa|dimana|kenapa|karena|lagi|sudah|belum)\b/i.test(t)) {
    return "id";
  }
  if (/\b(saya|awak|anda|tidak|boleh|terima kasih|kenapa|kerana|berapa|sudah|belum)\b/i.test(t)) {
    return "ms";
  }

  return "en";
}

function detectSourceLangSimple(text = "") {
  const t = String(text || "").trim();
  if (!t) return "auto";

  const chineseCount = (t.match(/[\u4E00-\u9FFF]/g) || []).length;

  const counts = [
    ["th", (t.match(/[\u0E00-\u0E7F]/g) || []).length],
    ["zh", chineseCount],
    ["my", (t.match(/[\u1000-\u109F]/g) || []).length],
    ["ja", (t.match(/[\u3040-\u30FF\u31F0-\u31FF]/g) || []).length],
    ["ko", (t.match(/[\uAC00-\uD7AF]/g) || []).length],
    ["ar", (t.match(/[\u0600-\u06FF]/g) || []).length],
    ["hi", (t.match(/[\u0900-\u097F]/g) || []).length],
    ["km", (t.match(/[\u1780-\u17FF]/g) || []).length],
    ["lo", (t.match(/[\u0E80-\u0EFF]/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);

  const [topLang, topCount] = counts[0];

  if (topCount && topCount > 0) {
    if (topLang === "zh") return detectChineseVariant(t);
    return topLang;
  }

  if (/[A-Za-zÀ-ỹÇĞİÖŞÜçğıöşü]/.test(t)) {
    return detectLatinLangHeuristic(t);
  }

  return "auto";
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

function safeTranslatedLine(lang, translated, options = {}) {
  const clean = cleanupTranslation(translated);
  if (!clean) return null;

  if (options.original) {
    return `【${LANG_LABELS[lang] || lang}｜原文】\n${clean}`;
  }

  return `【${LANG_LABELS[lang] || lang}】\n${clean}`;
}

function dedupeTranslatedOutputs(blocks = []) {
  const seen = new Set();
  const result = [];

  for (const block of blocks) {
    const body = String(block || "")
      .split("\n")
      .slice(1)
      .join("\n")
      .trim();

    const key = normalizeComparableText(body);
    if (!key) continue;
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(block);
  }

  return result;
}

/* =========================================================
 * 翻譯判斷與防呆
 * ======================================================= */

function normalizeThaiShortKey(text = "") {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function getDirectThaiShortChinese(text = "", targetLang = "zh-TW") {
  const key = normalizeThaiShortKey(text);
  const translated = THAI_SHORT_CHAT_DIRECT_ZH_MAP[key] || null;
  if (!translated) return null;

  if (targetLang === "zh-CN") {
    return translated
      .replace(/還/g, "还")
      .replace(/沒/g, "没")
      .replace(/嗎/g, "吗")
      .replace(/係/g, "系");
  }

  return translated;
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
    /^(\u0E22\u0E31\u0E07|\u0E22\u0E31\u0E07\u0E04\u0E30|\u0E22\u0E31\u0E07\u0E04\u0E48\u0E30|\u0E22\u0E31\u0E07\u0E04\u0E23\u0E31\u0E1A|\u0E22\u0E31\u0E07\u0E44\u0E2B\u0E21|\u0E22\u0E31\u0E07\u0E21\u0E31\u0E49\u0E22|\u0E22\u0E31\u0E07\u0E2B\u0E23\u0E2D|\u0E22\u0E31\u0E07\u0E40\u0E2B\u0E23\u0E2D|\u0E44\u0E14\u0E49|\u0E44\u0E14\u0E49\u0E04\u0E48\u0E30|\u0E44\u0E14\u0E49\u0E04\u0E30|\u0E44\u0E14\u0E49\u0E04\u0E23\u0E31\u0E1A|\u0E04\u0E48\u0E30|\u0E04\u0E30|\u0E04\u0E23\u0E31\u0E1A|\u0E2B\u0E23\u0E2D|\u0E40\u0E2B\u0E23\u0E2D|\u0E2D\u0E48\u0E2D|\u0E2D\u0E37\u0E21|\u0E08\u0E49\u0E32|\u0E08\u0E4B\u0E32|\u0E19\u0E30|\u0E19\u0E49\u0E32|\u0E2D\u0E22\u0E39\u0E48\u0E44\u0E2B\u0E21|\u0E2D\u0E22\u0E39\u0E48\u0E21\u0E31\u0E49\u0E22|\u0E2B\u0E32\u0E22\u0E44\u0E1B\u0E44\u0E2B\u0E19|\u0E42\u0E2D\u0E40\u0E04\u0E44\u0E2B\u0E21|\u0E44\u0E14\u0E49\u0E44\u0E2B\u0E21|\u0E21\u0E32\u0E44\u0E2B\u0E21|\u0E44\u0E21\u0E48|\u0E44\u0E21\u0E48\u0E04\u0E30|\u0E44\u0E21\u0E48\u0E04\u0E48\u0E30|\u0E44\u0E21\u0E48\u0E04\u0E23\u0E31\u0E1A|\u0E44\u0E21\u0E48\u0E40\u0E2D\u0E32|\u0E40\u0E2D\u0E32)$/.test(
      t
    )
  );
}

function looksLikeThaiDialectText(text = "") {
  const t = String(text || "").trim();
  if (!hasThai(t)) return false;
  if (isVeryShortText(t)) return true;
  return /\u0E40\u0E14\u0E49\u0E2D|\u0E1A\u0E48|\u0E2D\u0E35\u0E2B\u0E25\u0E35|\u0E2B\u0E25\u0E32\u0E22\u0E2D\u0E22\u0E39\u0E48|\u0E19\u0E34|\u0E41\u0E2B\u0E25\u0E07|\u0E2B\u0E23\u0E2D\u0E22|\u0E01\u0E48\u0E2D|\u0E40\u0E19\u0E49\u0E2D|\u0E08\u0E30\u0E44\u0E14|\u0E40\u0E2E\u0E32|\u0E02\u0E49\u0E2D\u0E22|\u0E40\u0E08\u0E49\u0E32|\u0E08\u0E49\u0E32\u0E27/.test(t);
}

function looksLikeNamedEntityShortText(text = "") {
  const t = String(text || "").trim();
  if (!t || !hasThai(t)) return false;
  const noSpace = t.replace(/\s+/g, "");
  return noSpace.length >= 2 && noSpace.length <= 30 && !/[。，！？.!?]/.test(t);
}

function looksLikePossiblePlaceName(text = "") {
  const t = String(text || "").trim();
  if (!t || !hasThai(t)) return false;
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
    "以上詞語必須固定使用，不可改寫，不可換成其他猜測地名、人名或店名。",
  ].join("\n");
}

function buildContextTypoHint(text = "") {
  const matched = CONTEXT_TYPO_RULES.filter((item) => item.test(text));
  if (!matched.length) return "";

  return [
    "【情境糾錯規則】",
    ...matched.map((item) => item.hint),
    "若上下文不能確認，不要硬改；以原句正常意思為準。",
  ].join("\n");
}

function getScriptViolation(text = "", targetLang, fixedTerms = []) {
  const clean = cleanupTranslation(text);
  if (!clean) return null;

  const protectedTerms = new Set(
    fixedTerms
      .filter((item) => item?.src && item?.target === item?.src)
      .map((item) => item.src)
  );

  let checkText = clean;
  for (const term of protectedTerms) {
    checkText = checkText.split(term).join("");
  }

  if (targetLang === "th" && hasChinese(checkText)) {
    return "翻成泰文時不可殘留中文";
  }

  if ((targetLang === "zh-TW" || targetLang === "zh-CN") && hasThai(checkText)) {
    return "翻成中文時不可殘留泰文";
  }

  if (targetLang === "en" && /[\u4E00-\u9FFF\u0E00-\u0E7F]/.test(checkText)) {
    return "翻成英文時不可殘留中文或泰文";
  }

  return null;
}

function mustUseSingleTranslate(text = "", targetLangs = []) {
  if (looksLikeThaiShortChat(text)) return true;
  if (looksLikeThaiDialectText(text)) return true;
  if (isMixedChineseThai(text)) return true;
  if (looksLikeNamedEntityShortText(text)) return true;
  if (getMatchedFixedTerms(text).length) return true;

  // 只要目標含泰文且來源含中文，先走單語，避免「姐姐」這類中文殘留在泰文中
  if (hasChinese(text) && targetLangs.includes("th")) return true;

  return false;
}

function buildStableInstructions({ targetLang, specialHint = "" }) {
  const targetName = getLangPureName(targetLang);

  return `
你是專業聊天翻譯員，只做翻譯，不聊天，不解釋。

你的唯一任務：
把使用者內容完整翻成「${targetName}」。

硬性規則：
1. 只輸出最終翻譯結果
2. 不可加前綴，不可加「翻譯：」
3. 不可加引號、括號、註解、說明
4. 不可補內容，不可刪內容
5. 不可把原文和翻譯一起輸出
6. 要保留原句強度、語氣、簡短程度
7. 聊天句要自然，但不可擴寫，短句就翻短句
8. 不可把普通聊天句改成正式公告、道歉文、感謝文
9. 不可自行加「謝謝、辛苦了、拜託、麻煩你、親愛的」等客套，除非原文真的有
10. 必須完整翻成目標語言，不可漏字、不可漏否定、不可漏時間、金額、地址、房號、數字
11. 不可保留原文中的其他語言文字；普通稱呼、人稱、名詞都要翻成目標語言
12. 若目標語言是泰文，中文稱呼、人稱、一般名詞都必須翻成泰文，不可保留中文字
13. 若目標語言是中文，泰文語氣詞、人稱、一般名詞都必須翻成中文，不可保留泰文字
14. 若目標語言是英文，不可混入中文或泰文
15. 原文中的數字、金額、LINE ID、@帳號、電話、網址、房號、表情符號要保留，不可亂改
16. LINE、FB、IG、TikTok、Google、YouTube 等品牌名稱可保留原寫法
17. 泰文「\u0E17\u0E35\u0E48」在句首不一定是「因為」；只有出現「\u0E40\u0E1E\u0E23\u0E32\u0E30 / \u0E40\u0E19\u0E37\u0E48\u0E2D\u0E07\u0E08\u0E32\u0E01」等明確因果詞，才翻成因為
18. 「\u0E42\u0E2D\u0E40\u0E04 / ok / okay」只有表示同意時才翻成「好」；若只是語氣填充，可依語境省略
19. 若原文有口語、誤拼、方言，只能做合理語意修正，不可自行編故事
20. 專有名詞沒有正式譯名時，使用目標語言可讀的音譯或自然表達，不要原字照抄造成混語

補充提示：
${specialHint || "無"}
  `.trim();
}

function buildMultiStableInstructions({ targetLangs, specialHint = "" }) {
  return `
你是專業聊天翻譯員，只做翻譯，不聊天，不解釋。

請把同一段內容一次翻成多個語言。
你只能輸出 JSON。
不可輸出 markdown，不可輸出說明，不可輸出前後文。

輸出格式範例：
{
  "zh-TW": "...",
  "th": "...",
  "en": "..."
}

硬性規則：
1. 每個 key 的 value 只能是該語言的最終翻譯
2. 不可把原文和翻譯一起輸出
3. 不可加前綴、引號外說明、註解
4. 忠實保留原意，不增加、不刪減
5. 聊天句自然，但不可擴寫，短句就翻短句
6. 不可自行加客套、感謝、道歉、安撫語，除非原文真的有
7. 每個 value 都必須完整翻成對應目標語言，不可漏字、漏否定、漏時間、漏金額、漏地址
8. 不可在任何 value 中保留原文的其他語言文字；普通稱呼、人稱、名詞都要翻成該 value 的目標語言
9. 翻成泰文時，不可混入中文
10. 翻成中文時，不可殘留泰文
11. 數字、金額、LINE ID、@帳號、電話、網址、房號、表情符號要保留，不可亂改
12. LINE、FB、IG、TikTok、Google、YouTube 等品牌名稱可保留原寫法
13. 泰文「\u0E17\u0E35\u0E48」在句首不一定是「因為」；只有出現「\u0E40\u0E1E\u0E23\u0E32\u0E30 / \u0E40\u0E19\u0E37\u0E48\u0E2D\u0E07\u0E08\u0E32\u0E01」等明確因果詞，才翻成因為
14. 「\u0E42\u0E2D\u0E40\u0E04 / ok / okay」只有表示同意時才翻成「好」；若只是語氣填充，可依語境省略
15. 若有固定術語，必須遵守
16. 若有口語、短句、誤拼，依聊天語境自然翻譯，不可自行編故事

補充提示：
${specialHint || "無"}

目標語言：
${targetLangs.map((lang) => `${lang} = ${getLangPureName(lang)}`).join("\n")}
  `.trim();
}

function collectSpecialHint(text, targetLang = null) {
  const sourceLang = detectSourceLangSimple(text);
  const thaiShortChat = looksLikeThaiShortChat(text);
  const thaiDialect = looksLikeThaiDialectText(text);
  const mixedZhTh = isMixedChineseThai(text);
  const namedEntityShort = looksLikeNamedEntityShortText(text);
  const fixedTerms = getMatchedFixedTerms(text);

  let specialHint = "";

  if (fixedTerms.length) {
    specialHint += " 這句包含固定術語，必須優先使用固定術語表，不可自行改寫。";
  }

  if (thaiShortChat) {
    specialHint += " 這是泰文超短聊天句，請翻成自然口語，不可逐字硬翻。";
  }

  if (thaiDialect) {
    specialHint += " 這段可能是泰文口語或方言，請依對話情境翻譯成自然用語。";
  }

  if (mixedZhTh) {
    specialHint += " 這是中泰混合內容，請依整句語意整理成目標語言，不要漏掉任一部分。";
  }

  if (namedEntityShort) {
    specialHint +=
      " 這句可能含專有名詞或聊天誤拼。若某個詞看似專有名詞，但上下文更像在稱呼真人，請優先依情境修正。";
  }

  if (targetLang === "th") {
    specialHint +=
      " 請輸出純泰文，不可混入任何中文。中文稱呼、人稱、一般名詞都要翻成泰文，不可保留中文原字。LINE、FB、IG、網址、ID、電話、數字可保留原格式。";
  }

  if (targetLang === "zh-TW") {
    specialHint += " 請輸出自然繁體中文，不要中國式生硬書面句，不可殘留泰文，不可自行加客套。";
  }

  if (targetLang === "zh-CN") {
    specialHint += " 請輸出自然简体中文，不可殘留泰文，不可自行加客套。";
  }

  if (targetLang === "en") {
    specialHint += " 請輸出自然英文，但不可自行補成更完整或更客氣的句子，不可混入中文或泰文。";
  }

  return {
    sourceLang,
    thaiShortChat,
    thaiDialect,
    specialHint: specialHint.trim(),
  };
}

/* =========================================================
 * 快取
 * ======================================================= */

function buildCacheKey({
  text,
  targetLang,
  sourceHint = "auto",
  specialHint = "",
}) {
  return crypto
    .createHash("sha1")
    .update(
      [
        CACHE_VERSION,
        String(sourceHint),
        String(targetLang),
        "normal",
        String(specialHint),
        String(text),
      ].join("__")
    )
    .digest("hex");
}

async function getTranslationCache({
  text,
  targetLang,
  sourceHint = "auto",
  specialHint = "",
}) {
  const cacheKey = buildCacheKey({ text, targetLang, sourceHint, specialHint });

  const result = await pool.query(
    `SELECT translated_text FROM translation_cache WHERE cache_key = $1 LIMIT 1`,
    [cacheKey]
  );

  return result.rows?.[0]?.translated_text || null;
}

async function saveTranslationCache({
  text,
  translatedText,
  targetLang,
  sourceHint = "auto",
  specialHint = "",
}) {
  const cacheKey = buildCacheKey({ text, targetLang, sourceHint, specialHint });

  await pool.query(
    `
    INSERT INTO translation_cache (cache_key, source_text, target_lang, source_hint, tone_mode, translated_text)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (cache_key)
    DO UPDATE SET translated_text = EXCLUDED.translated_text, created_at = NOW()
    `,
    [cacheKey, text, targetLang, sourceHint, "normal", translatedText]
  );
}

function buildMultiTargetCacheKey({
  text,
  targetLangs,
  sourceHint = "auto",
  specialHint = "",
}) {
  return crypto
    .createHash("sha1")
    .update(
      [
        CACHE_VERSION,
        "multi",
        String(sourceHint),
        [...targetLangs].sort().join(","),
        String(specialHint),
        String(text),
      ].join("__")
    )
    .digest("hex");
}

async function getMultiTranslationCache({
  text,
  targetLangs,
  sourceHint = "auto",
  specialHint = "",
}) {
  const cacheKey = buildMultiTargetCacheKey({
    text,
    targetLangs,
    sourceHint,
    specialHint,
  });

  const result = await pool.query(
    `SELECT translated_text FROM translation_cache WHERE cache_key = $1 LIMIT 1`,
    [cacheKey]
  );

  if (!result.rows?.[0]?.translated_text) return null;

  try {
    return JSON.parse(result.rows[0].translated_text);
  } catch {
    return null;
  }
}

async function saveMultiTranslationCache({
  text,
  translatedMap,
  targetLangs,
  sourceHint = "auto",
  specialHint = "",
}) {
  const cacheKey = buildMultiTargetCacheKey({
    text,
    targetLangs,
    sourceHint,
    specialHint,
  });

  await pool.query(
    `
    INSERT INTO translation_cache (cache_key, source_text, target_lang, source_hint, tone_mode, translated_text)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (cache_key)
    DO UPDATE SET translated_text = EXCLUDED.translated_text, created_at = NOW()
    `,
    [
      cacheKey,
      text,
      `multi:${[...targetLangs].sort().join(",")}`,
      sourceHint,
      "normal",
      JSON.stringify(translatedMap),
    ]
  );
}

function safeJsonParse(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {}

  const fencedMatch =
    raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```([\s\S]*?)```/i);

  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {}
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }

  return null;
}

function extractOpenAIText(response) {
  const direct = cleanupTranslation(response?.output_text || "");
  if (direct) return direct;

  const chunks = [];

  try {
    for (const item of response?.output || []) {
      for (const content of item?.content || []) {
        if (content?.type === "output_text" && typeof content.text === "string") {
          chunks.push(content.text);
        } else if (typeof content?.text === "string") {
          chunks.push(content.text);
        }
      }
    }
  } catch (err) {
    console.error("extractOpenAIText error =", err);
    if (err?.stack) console.error(err.stack);
  }

  return cleanupTranslation(chunks.join("\n").trim());
}

/* =========================================================
 * OpenAI 翻譯
 * ======================================================= */

async function askModelTranslate({
  text,
  targetLang,
  sourceHint = "auto",
  specialHint = "",
  bypassCache = false,
}) {
  if (!bypassCache) {
    const cacheReadStart = Date.now();
    const cached = await getTranslationCache({
      text,
      targetLang,
      sourceHint,
      specialHint,
    });

    logTiming(
      "translation_cache_read",
      cacheReadStart,
      `target=${targetLang} hit=${!!cached} chars=${String(text || "").length}`
    );

    if (cached) return cleanupTranslation(cached);
  }

  const fixedTermsHint = buildFixedTermsHint(text);
  const contextTypoHint = buildContextTypoHint(text);

  const instructions = buildStableInstructions({
    targetLang,
    specialHint: `
來源語言提示：${sourceHint}
${specialHint || ""}
${fixedTermsHint || ""}
${contextTypoHint || ""}
    `.trim(),
  });

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0,
    input: [
      { role: "developer", content: instructions },
      { role: "user", content: String(text || "") },
    ],
  };

  if (OPENAI_REASONING_EFFORT && OPENAI_REASONING_EFFORT !== "none") {
    payload.reasoning = { effort: OPENAI_REASONING_EFFORT };
  }

  const openaiStart = Date.now();
  const response = await openai.responses.create(payload);

  logTiming(
    "openai_responses_create",
    openaiStart,
    `target=${targetLang} model=${OPENAI_MODEL} chars=${String(text || "").length}`
  );

  const output = extractOpenAIText(response);

  if (!output) {
    console.error("askModelTranslate empty output", {
      targetLang,
      sourceHint,
      specialHint,
      model: OPENAI_MODEL,
    });
    throw new Error(`Empty translation output for ${targetLang}`);
  }

  if (!bypassCache) {
    void saveTranslationCache({
      text,
      translatedText: output,
      targetLang,
      sourceHint,
      specialHint,
    }).catch((err) => {
      console.error("saveTranslationCache error =", err);
      if (err?.stack) console.error(err.stack);
    });
  }

  return cleanupTranslation(output);
}

async function askModelTranslateMulti({
  text,
  targetLangs,
  sourceHint = "auto",
  specialHint = "",
}) {
  const normalizedTargets = normalizeLangList(targetLangs || []);
  if (!normalizedTargets.length) return {};

  const cacheReadStart = Date.now();
  const cached = await getMultiTranslationCache({
    text,
    targetLangs: normalizedTargets,
    sourceHint,
    specialHint,
  });

  logTiming(
    "multi_translation_cache_read",
    cacheReadStart,
    `targets=${normalizedTargets.join(",")} hit=${!!cached} chars=${String(text || "").length}`
  );

  const fixedTerms = getMatchedFixedTerms(text);

  if (cached && typeof cached === "object") {
    let cacheOk = true;
    for (const lang of normalizedTargets) {
      const out = cleanupTranslation(cached?.[lang] || "");
      if (!out || getScriptViolation(out, lang, fixedTerms)) {
        cacheOk = false;
        break;
      }
    }

    if (cacheOk) return cached;

    console.warn("[multi-cache-bypass] cached result failed validation, re-translating");
  }

  const fixedTermsHint = buildFixedTermsHint(text);
  const contextTypoHint = buildContextTypoHint(text);

  const instructions = buildMultiStableInstructions({
    targetLangs: normalizedTargets,
    specialHint: `
來源語言提示：${sourceHint}
${specialHint || ""}
${fixedTermsHint || ""}
${contextTypoHint || ""}
    `.trim(),
  });

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0,
    input: [
      { role: "developer", content: instructions },
      { role: "user", content: String(text || "") },
    ],
  };

  if (OPENAI_REASONING_EFFORT && OPENAI_REASONING_EFFORT !== "none") {
    payload.reasoning = { effort: OPENAI_REASONING_EFFORT };
  }

  const openaiStart = Date.now();
  const response = await openai.responses.create(payload);

  logTiming(
    "openai_multi_responses_create",
    openaiStart,
    `targets=${normalizedTargets.join(",")} model=${OPENAI_MODEL} chars=${String(text || "").length}`
  );

  const raw = extractOpenAIText(response);
  const parsed = safeJsonParse(raw);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Multi-translation JSON parse failed");
  }

  // fixedTerms 已在快取驗證前建立
  const cleaned = {};

  for (const lang of normalizedTargets) {
    const out = cleanupTranslation(parsed[lang] || "");
    if (!out) {
      cleaned[lang] = "";
      continue;
    }

    const violation = getScriptViolation(out, lang, fixedTerms);
    if (violation) {
      throw new Error(`Multi-translation script violation: ${lang} ${violation}`);
    }

    cleaned[lang] = out;
  }

  void saveMultiTranslationCache({
    text,
    translatedMap: cleaned,
    targetLangs: normalizedTargets,
    sourceHint,
    specialHint,
  }).catch((err) => {
    console.error("saveMultiTranslationCache error =", err);
    if (err?.stack) console.error(err.stack);
  });

  return cleaned;
}

async function verifyPlaceNameOnline(text) {
  // 目前不做外部查詢，避免 webhook 變慢或外部服務不穩。
  // 若未來要做地名查詢，建議改成離線字典 + 快取。
  return {
    found: false,
    zhName: null,
    rawName: text,
    confidence: 0,
  };
}

async function translateThaiDialectToChinese(text, targetLang = "zh-TW") {
  const direct = getDirectThaiShortChinese(text, targetLang);
  if (direct) return direct;

  const targetName = targetLang === "zh-CN" ? "简体中文" : "繁體中文";

  return await askModelTranslate({
    text,
    targetLang,
    sourceHint: "泰文或泰國口語 / 方言",
    specialHint: `
這段很可能是泰文短句、聊天句、口語或方言，請翻成自然${targetName}對話。

重要規則：
1. 所有泰文都必須翻成中文，不可殘留任何泰文字
2. 包含語氣詞、禮貌詞如「\u0E04\u0E30 / \u0E04\u0E48\u0E30 / \u0E04\u0E23\u0E31\u0E1A」也必須翻掉，不可保留原文
3. 像「\u0E44\u0E21\u0E48\u0E04\u0E48\u0E30 / \u0E44\u0E21\u0E48\u0E04\u0E23\u0E31\u0E1A」這類否定短句，要翻成自然中文口語，例如「不是喔 / 沒有喔 / 不要喔」，依語境判斷，不可逐字硬翻
4. 像「\u0E44\u0E14\u0E49\u0E04\u0E48\u0E30 / \u0E44\u0E14\u0E49\u0E04\u0E23\u0E31\u0E1A」這類肯定短句，要翻成「可以喔 / 好喔 / 有喔」等自然中文
5. 像「\u0E22\u0E31\u0E07 / \u0E22\u0E31\u0E07\u0E04\u0E48\u0E30 / \u0E22\u0E31\u0E07\u0E04\u0E23\u0E31\u0E1A」這類短句非常依賴上下文：回答時通常是「還沒 / 還沒喔」；追問時依語境翻成「還沒嗎？/ 還在嗎？/ 還有嗎？/ 好了嗎？」
6. 不可逐字硬翻，要翻成自然聊天中文
輸出必須是純${targetName}。
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
  const allowWholeOriginalText = fixedTerms.some(
    (item) => item.target === item.src && isSameText(text, item.src)
  );
  const targetName = getLangPureName(targetLang);

  if ((targetLang === "zh-TW" || targetLang === "zh-CN") && possiblePlaceName) {
    const verified = await verifyPlaceNameOnline(text);
    if (verified?.found && verified?.zhName && verified.confidence >= 0.85) {
      return verified.zhName;
    }
  }

  const { specialHint } = collectSpecialHint(text, targetLang);

  const askOnce = async (extraHint = "", bypassCache = false) => {
    return await askModelTranslate({
      text,
      targetLang,
      sourceHint: sourceLang,
      specialHint: `${specialHint} ${extraHint}`.trim(),
      bypassCache,
    });
  };

  let output = "";

  if (
    (targetLang === "zh-TW" || targetLang === "zh-CN") &&
    (thaiShortChat || thaiDialect)
  ) {
    output = await translateThaiDialectToChinese(text, targetLang);
  } else {
    output = await askOnce();
  }

  const shouldRetrySameAsInput = (value) => {
    const clean = cleanupTranslation(value);
    if (!clean) return false;
    if (sourceLang === targetLang) return false;
    if (allowWholeOriginalText) return false;
    return isSameText(clean, text);
  };

  let retryCount = 0;

  while (retryCount < MAX_TRANSLATION_RETRIES) {
    const clean = cleanupTranslation(output);
    const sameAsInput = shouldRetrySameAsInput(clean);
    const violation = getScriptViolation(clean, targetLang, fixedTerms);

    if (!sameAsInput && !violation) {
      break;
    }

    const extraHints = [];

    if (sameAsInput) {
      extraHints.push(`這次必須真正翻成${targetName}，不可原樣輸出來源文字。`);
    }

    if (violation) {
      extraHints.push(`
上一版翻譯有問題：${violation}
請重新從原文翻譯，不要修補上一版。
目標語言是 ${targetName}。
只能輸出 ${targetName}。
不可保留原文中的其他語言文字。
中文、泰文、英文、人稱、稱呼、一般名詞都必須翻成目標語言。
不可混合語言。
      `.trim());
    }

    console.warn(
      `[translate-retry] target=${targetLang} retry=${retryCount + 1} sameAsInput=${sameAsInput} violation=${violation || "none"}`
    );

    output = await askOnce(extraHints.join("\n"), true);
    retryCount += 1;
  }

  const finalViolation = getScriptViolation(output, targetLang, fixedTerms);

  if (finalViolation) {
    console.warn(`[translate-final-violation] target=${targetLang} ${finalViolation} output=${output}`);

    // 不直接刪字，避免把意思刪掉。最後再請模型整理一次。
    output = await askModelTranslate({
      text,
      targetLang,
      sourceHint: sourceLang,
      bypassCache: true,
      specialHint: `
最後重翻。
上一版仍然混入錯誤語言文字：${finalViolation}
請從原文重新翻成「${targetName}」。
只輸出純「${targetName}」。
不可保留任何非目標語言文字。
不可解釋。
      `.trim(),
    });
  }

  return cleanupTranslation(output);
}

async function translateToTargets(text, targetLangs) {
  const normalizedTargets = normalizeLangList(targetLangs || []);
  if (!normalizedTargets.length) return {};

  const { sourceLang, specialHint } = collectSpecialHint(text, null);

  if (mustUseSingleTranslate(text, normalizedTargets)) {
    const singleResults = {};
    for (const lang of normalizedTargets) {
      singleResults[lang] = await translateToTarget(text, lang);
    }
    return singleResults;
  }

  try {
    const multiResult = await askModelTranslateMulti({
      text,
      targetLangs: normalizedTargets,
      sourceHint: sourceLang,
      specialHint,
    });

    const cleaned = {};
    for (const lang of normalizedTargets) {
      cleaned[lang] = cleanupTranslation(multiResult?.[lang] || "");
    }

    return cleaned;
  } catch (err) {
    console.error("askModelTranslateMulti failed, fallback to single:", err);
    if (err?.stack) console.error(err.stack);
  }

  const results = {};
  for (const lang of normalizedTargets) {
    try {
      results[lang] = await translateToTarget(text, lang);
    } catch (err) {
      console.error(`translateToTarget failed: ${lang}`, err);
      if (err?.stack) console.error(err.stack);
      results[lang] = "";
    }
  }

  return results;
}

/* =========================================================
 * LINE 選單
 * ======================================================= */

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
              { type: "text", text: "更多語言 3", weight: "bold", size: "lg", align: "center" },
              { type: "text", text: "其他常用語言", size: "sm", color: "#666666", align: "center", margin: "sm" },
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

/* =========================================================
 * DB
 * ======================================================= */

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

  await pool.query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS daily_limit INTEGER;`);
  await pool.query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS trial_type TEXT;`);

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
    ALTER TABLE group_subscriptions
      ADD COLUMN IF NOT EXISTS tone_mode TEXT NOT NULL DEFAULT 'normal';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, group_id, date)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS translation_cache (
      cache_key TEXT PRIMARY KEY,
      source_text TEXT NOT NULL,
      target_lang TEXT NOT NULL,
      source_hint TEXT,
      tone_mode TEXT NOT NULL DEFAULT 'normal',
      translated_text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_profiles (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      picture_url TEXT,
      status_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getGroup(chatId) {
  const result = await pool.query(
    `SELECT chat_id, owner_id, langs, admins, tone_mode, created_at
     FROM group_subscriptions
     WHERE chat_id = $1`,
    [chatId]
  );
  return result.rows[0] || null;
}

async function ensureGroupDb(chatId) {
  const existing = await getGroup(chatId);
  if (existing) return existing;

  await pool.query(
    `
    INSERT INTO group_subscriptions (chat_id, owner_id, langs, admins, tone_mode)
    VALUES ($1, NULL, '[]'::jsonb, '[]'::jsonb, 'normal')
    ON CONFLICT (chat_id) DO NOTHING
    `,
    [chatId]
  );

  return getGroup(chatId);
}

async function saveGroup(group) {
  group.langs = normalizeLangList(group.langs || []);
  group.admins = Array.isArray(group.admins)
    ? [...new Set(group.admins.filter(Boolean))]
    : [];

  await pool.query(
    `
    INSERT INTO group_subscriptions (chat_id, owner_id, langs, admins, tone_mode)
    VALUES ($1, $2, $3::jsonb, $4::jsonb, 'normal')
    ON CONFLICT (chat_id)
    DO UPDATE SET
      owner_id = EXCLUDED.owner_id,
      langs = EXCLUDED.langs,
      admins = EXCLUDED.admins,
      tone_mode = 'normal'
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
  if (!userId) return null;
  const result = await pool.query(
    `SELECT user_id, plan_type, group_limit, vip_expires_at, bound_groups, created_at, daily_limit, trial_type
     FROM plans
     WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function ensurePlanDb(userId) {
  const existing = await getPlan(userId);
  if (existing) return existing;

  await pool.query(
    `
    INSERT INTO plans (user_id, plan_type, group_limit, vip_expires_at, bound_groups, daily_limit, trial_type)
    VALUES ($1, NULL, NULL, NULL, '[]'::jsonb, NULL, NULL)
    ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );

  return getPlan(userId);
}

async function savePlan(plan) {
  await pool.query(
    `
    INSERT INTO plans (user_id, plan_type, group_limit, vip_expires_at, bound_groups, daily_limit, trial_type)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
    ON CONFLICT (user_id)
    DO UPDATE SET
      plan_type = EXCLUDED.plan_type,
      group_limit = EXCLUDED.group_limit,
      vip_expires_at = EXCLUDED.vip_expires_at,
      bound_groups = EXCLUDED.bound_groups,
      daily_limit = EXCLUDED.daily_limit,
      trial_type = EXCLUDED.trial_type
    `,
    [
      plan.user_id,
      plan.plan_type,
      plan.group_limit,
      plan.vip_expires_at,
      JSON.stringify(Array.isArray(plan.bound_groups) ? [...new Set(plan.bound_groups)] : []),
      plan.daily_limit ?? null,
      plan.trial_type ?? null,
    ]
  );
}

async function getMemberProfileDb(userId) {
  if (!userId) return null;
  const result = await pool.query(
    `SELECT user_id, display_name, picture_url, status_message, updated_at
     FROM member_profiles
     WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function saveMemberProfileDb({
  user_id,
  display_name = "",
  picture_url = "",
  status_message = "",
}) {
  if (!user_id) return;

  await pool.query(
    `
    INSERT INTO member_profiles (user_id, display_name, picture_url, status_message, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      display_name = EXCLUDED.display_name,
      picture_url = EXCLUDED.picture_url,
      status_message = EXCLUDED.status_message,
      updated_at = NOW()
    `,
    [user_id, display_name, picture_url, status_message]
  );
}

async function fetchUserProfileFromApiByUserId(userId) {
  if (!userId) return null;
  try {
    const p = await lineClient.getProfile(userId);
    return {
      user_id: userId,
      display_name: p?.displayName || "",
      picture_url: p?.pictureUrl || "",
      status_message: p?.statusMessage || "",
    };
  } catch {
    return null;
  }
}

async function fetchUserProfileFromEvent(event) {
  const userId = event?.source?.userId;
  if (!userId) return null;

  try {
    if (event.source.groupId) {
      const p = await lineClient.getGroupMemberProfile(event.source.groupId, userId);
      return {
        user_id: userId,
        display_name: p?.displayName || "",
        picture_url: p?.pictureUrl || "",
        status_message: p?.statusMessage || "",
      };
    }

    if (event.source.roomId) {
      const p = await lineClient.getRoomMemberProfile(event.source.roomId, userId);
      return {
        user_id: userId,
        display_name: p?.displayName || "",
        picture_url: p?.pictureUrl || "",
        status_message: p?.statusMessage || "",
      };
    }

    const p = await lineClient.getProfile(userId);
    return {
      user_id: userId,
      display_name: p?.displayName || "",
      picture_url: p?.pictureUrl || "",
      status_message: p?.statusMessage || "",
    };
  } catch {
    const fallback = await fetchUserProfileFromApiByUserId(userId);
    return fallback;
  }
}

async function captureEventUserProfile(event, { force = false } = {}) {
  const userId = event?.source?.userId;
  if (!userId) return null;

  if (!force) {
    const stored = await getMemberProfileDb(userId);
    if (stored?.display_name) return stored;
  }

  const profile = await fetchUserProfileFromEvent(event);
  if (profile?.display_name) {
    await saveMemberProfileDb(profile);
  }
  return profile;
}

async function resolveLineDisplayName({
  userId,
  event = null,
  lineDisplayName = "",
}) {
  if (lineDisplayName) return lineDisplayName;
  if (!userId) return "";

  if (event?.source?.userId === userId) {
    const eventProfile = await captureEventUserProfile(event);
    if (eventProfile?.display_name) return eventProfile.display_name;
  }

  const stored = await getMemberProfileDb(userId);
  if (stored?.display_name) return stored.display_name;

  const fetched = await fetchUserProfileFromApiByUserId(userId);
  if (fetched?.display_name) {
    await saveMemberProfileDb(fetched);
    return fetched.display_name;
  }

  return "";
}

function getNowTaipeiString() {
  return new Date().toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour12: false,
  });
}

async function syncMemberToGoogleSheet({
  userId,
  event = null,
  memberName = "",
  lineDisplayName = "",
  lineCustomId = "",
  note = "",
  openedAt = "",
} = {}) {
  try {
    if (!GOOGLE_SHEETS_WEBHOOK_URL || !userId) return;

    const plan = await getPlan(userId);
    if (!plan) return;

    const resolvedDisplayName = await resolveLineDisplayName({
      userId,
      event,
      lineDisplayName,
    });

    const payload = {
      userId,
      memberName: memberName || resolvedDisplayName || "",
      lineDisplayName: resolvedDisplayName || "",
      lineCustomId,
      planType: getPlanDisplayLabel(plan),
      planCode: plan.plan_type || "",
      trialType: plan.trial_type || "",
      groupLimit:
        plan.plan_type === "unlimited_groups" || plan.plan_type === "trial_7days"
          ? "不限"
          : String(plan.group_limit ?? "1"),
      boundGroupCount: Array.isArray(plan.bound_groups) ? plan.bound_groups.length : 0,
      openedAt: openedAt || getNowTaipeiString(),
      expiresAt: plan.vip_expires_at ? formatDateTime(plan.vip_expires_at) : "",
      vipStatus: isPlanActive(plan) ? "有效" : "已到期 / 未開通",
      note,
    };

    const resp = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) throw new Error(`Google Sheets webhook failed: ${resp.status}`);
  } catch (err) {
    console.error("syncMemberToGoogleSheet error =", err);
    if (err?.stack) console.error(err.stack);
  }
}

/* =========================================================
 * 方案
 * ======================================================= */

function getPlanTypeLabel(planType, groupLimit = null) {
  switch (planType) {
    case "free_trial":
      return "免費試用";
    case "trial_7days":
      return "7天試用";
    case "limited_groups":
      return groupLimit ? `${groupLimit}群方案` : "限制群組方案";
    case "unlimited_groups":
      return "不限群組方案";
    default:
      return planType || "未開通";
  }
}

function getPlanDisplayLabel(plan) {
  if (!plan) return "未開通";
  return getPlanTypeLabel(plan.plan_type, plan.group_limit);
}

function isPlanActive(plan) {
  if (!plan) return false;
  if (plan.plan_type === "free_trial") return true;
  if (!plan.vip_expires_at) return false;
  return new Date(plan.vip_expires_at).getTime() > Date.now();
}

function canUseGroup(plan, groupId) {
  if (!plan) return false;

  if (plan.plan_type === "trial_7days") return true;

  if (plan.plan_type === "free_trial") {
    const groups = Array.isArray(plan.bound_groups) ? plan.bound_groups : [];
    if (groups.includes(groupId)) return true;
    return groups.length < 1;
  }

  if (plan.plan_type === "unlimited_groups") return true;

  if (plan.plan_type === "limited_groups") {
    const groups = Array.isArray(plan.bound_groups) ? plan.bound_groups : [];
    const limit = Number(plan.group_limit || 0);
    if (groups.includes(groupId)) return true;
    return groups.length < limit;
  }

  return false;
}

function getGroupLimitText(plan) {
  if (!plan) return "未設定";
  if (plan.plan_type === "unlimited_groups" || plan.plan_type === "trial_7days") {
    return "不限";
  }
  return String(plan.group_limit ?? "1");
}

function createPaidPlanObject(
  userId,
  planType,
  groupLimit,
  days,
  oldPlan = null,
  options = {}
) {
  const { resetBoundGroups = false } = options;

  return {
    user_id: userId,
    plan_type: planType,
    group_limit: groupLimit,
    vip_expires_at: addDays(days),
    bound_groups: resetBoundGroups
      ? []
      : Array.isArray(oldPlan?.bound_groups)
      ? [...new Set(oldPlan.bound_groups)]
      : [],
    daily_limit: null,
    trial_type: null,
  };
}

function createFreeTrialPlanObject(userId, oldPlan = null) {
  return {
    user_id: userId,
    plan_type: "free_trial",
    group_limit: 1,
    vip_expires_at: null,
    bound_groups: Array.isArray(oldPlan?.bound_groups)
      ? [...new Set(oldPlan.bound_groups)].slice(0, 1)
      : [],
    daily_limit: 20,
    trial_type: "每日免費20句",
  };
}

function create7DayTrialPlanObject(userId, oldPlan = null) {
  return {
    user_id: userId,
    plan_type: "trial_7days",
    group_limit: null,
    vip_expires_at: addDays(7),
    bound_groups: Array.isArray(oldPlan?.bound_groups)
      ? [...new Set(oldPlan.bound_groups)]
      : [],
    daily_limit: null,
    trial_type: "7天試用不限群組不限句數",
  };
}

function disablePlanObject(plan, userId) {
  return {
    user_id: userId,
    plan_type: plan?.plan_type || null,
    group_limit: plan?.group_limit ?? null,
    vip_expires_at: new Date(Date.now() - 1000).toISOString(),
    bound_groups: Array.isArray(plan?.bound_groups) ? plan.bound_groups : [],
    daily_limit: plan?.daily_limit ?? null,
    trial_type: plan?.trial_type ?? null,
  };
}

function bindGroupToOwner(plan, groupId) {
  if (!plan.bound_groups) plan.bound_groups = [];
  if (!plan.bound_groups.includes(groupId)) plan.bound_groups.push(groupId);
}

function unbindGroupFromOwner(plan, groupId) {
  if (!plan?.bound_groups) return;
  plan.bound_groups = plan.bound_groups.filter((g) => g !== groupId);
}

async function getAllPlans(page = 1, pageSize = MEMBER_LIST_PAGE_SIZE) {
  const safePage = parsePositiveInt(page, 1);
  const safePageSize = parsePositiveInt(pageSize, MEMBER_LIST_PAGE_SIZE);
  const offset = (safePage - 1) * safePageSize;

  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM plans`);
  const total = countResult.rows?.[0]?.total || 0;

  const result = await pool.query(
    `
    SELECT user_id, plan_type, group_limit, vip_expires_at, bound_groups, daily_limit, trial_type, created_at
    FROM plans
    ORDER BY
      CASE WHEN vip_expires_at IS NULL THEN 1 ELSE 0 END,
      vip_expires_at DESC NULLS LAST,
      created_at DESC,
      user_id ASC
    LIMIT $1 OFFSET $2
    `,
    [safePageSize, offset]
  );

  return {
    rows: result.rows || [],
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(1, Math.ceil(total / safePageSize)),
  };
}

async function getAllPlansNoPaging() {
  const result = await pool.query(`
    SELECT user_id, plan_type, group_limit, vip_expires_at, bound_groups, daily_limit, trial_type, created_at
    FROM plans
    ORDER BY
      CASE WHEN vip_expires_at IS NULL THEN 1 ELSE 0 END,
      vip_expires_at DESC NULLS LAST,
      created_at DESC,
      user_id ASC
  `);

  return result.rows || [];
}

async function checkDailyLimit(userId, groupId, dailyLimit) {
  if (!dailyLimit) return { allowed: true, used: 0, limit: null };

  const today = new Date().toISOString().slice(0, 10);

  const result = await pool.query(
    `SELECT count FROM usage_logs WHERE user_id = $1 AND group_id = $2 AND date = $3`,
    [userId, groupId, today]
  );

  if (result.rows.length === 0) {
    await pool.query(
      `INSERT INTO usage_logs (user_id, group_id, date, count)
       VALUES ($1, $2, $3, 1)`,
      [userId, groupId, today]
    );
    return { allowed: true, used: 1, limit: dailyLimit };
  }

  const currentCount = result.rows[0].count;

  if (currentCount >= dailyLimit) {
    return { allowed: false, used: currentCount, limit: dailyLimit };
  }

  await pool.query(
    `UPDATE usage_logs
     SET count = count + 1
     WHERE user_id = $1 AND group_id = $2 AND date = $3`,
    [userId, groupId, today]
  );

  return { allowed: true, used: currentCount + 1, limit: dailyLimit };
}

function isAdmin(group, userId) {
  if (!userId) return false;
  return (group?.admins || []).includes(userId);
}

function canLanguageManage(group, plan, userId) {
  return isAdmin(group, userId) && isPlanActive(plan);
}

function addAdmin(group, userId) {
  if (!userId) return;
  if (!Array.isArray(group.admins)) group.admins = [];
  if (!group.admins.includes(userId)) group.admins.push(userId);
}

function removeAdmin(group, userId) {
  group.admins = (group.admins || []).filter((id) => id !== userId);
}

async function releaseGroupBinding(chatId, { deleteGroupRow = false } = {}) {
  if (!chatId) return;

  const group = await getGroup(chatId);
  if (!group) return;

  if (group.owner_id) {
    const ownerPlan = await getPlan(group.owner_id);
    if (ownerPlan) {
      unbindGroupFromOwner(ownerPlan, chatId);
      await savePlan(ownerPlan);
    }
  }

  if (deleteGroupRow) {
    await pool.query(`DELETE FROM group_subscriptions WHERE chat_id = $1`, [chatId]);
    return;
  }

  group.owner_id = null;
  group.admins = [];
  group.langs = [];
  await saveGroup(group);
}

async function clearAllBindingsByUserId(userId) {
  if (!userId) return { clearedGroups: 0 };

  await pool.query(
    `UPDATE plans SET bound_groups = '[]'::jsonb WHERE user_id = $1`,
    [userId]
  );

  const result = await pool.query(
    `
    UPDATE group_subscriptions
    SET owner_id = NULL,
        admins = '[]'::jsonb,
        langs = '[]'::jsonb,
        tone_mode = 'normal'
    WHERE owner_id = $1
    `,
    [userId]
  );

  return { clearedGroups: result.rowCount || 0 };
}

/* =========================================================
 * 文字回覆
 * ======================================================= */

function buildStatusText(group, plan) {
  return [
    `ownerId：${group?.owner_id || "未綁定"}`,
    `方案：${getPlanDisplayLabel(plan)}`,
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
    `方案：${getPlanDisplayLabel(plan)}`,
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
    "新加入：每日免費20句",
    "試用7天：不限群組 / 不限句數",
    "1群 / 月：500",
    "不限群 / 月：1500",
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
    "/重設語言",
  ];

  if (superAdmin) {
    lines.push(
      "/綁定",
      "/解除綁定",
      "/新增管理員 使用者ID",
      "/刪除管理員 使用者ID",
      "/設定擁有者 使用者ID",
      "/開通1群 使用者ID",
      "/開通不限30 使用者ID",
      "/試用7天 使用者ID",
      "/查方案 使用者ID",
      "/清空綁群 使用者ID",
      "/停用 使用者ID",
      "/全部會員 [頁數]",
      "/會員列表 [頁數]",
      "/同步全部會員"
    );
  }

  return lines.join("\n");
}

function buildAllPlansText(plans = [], page = 1, totalPages = 1, totalCount = 0) {
  if (!plans.length) return "目前沒有任何會員資料。";

  const lines = [`會員列表（第 ${page}/${totalPages} 頁，共 ${totalCount} 筆）：`, ""];

  for (const plan of plans) {
    const boundCount = Array.isArray(plan.bound_groups) ? plan.bound_groups.length : 0;
    const vipStatus = isPlanActive(plan) ? "有效" : "已到期 / 未開通";

    lines.push(
      [
        `使用者：${plan.user_id}`,
        `方案：${getPlanDisplayLabel(plan)}`,
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

  if (page < totalPages) lines.push(`下一頁請輸入：/全部會員 ${page + 1}`);
  return lines.join("\n");
}

/* =========================================================
 * LINE 事件
 * ======================================================= */

async function handleMemberLeft(event) {
  const chatId = getChatId(event);
  const group = await getGroup(chatId);
  if (!group) return;

  const leftMembers = Array.isArray(event.left?.members) ? event.left.members : [];
  const leftUserIds = leftMembers.map((m) => m.userId).filter(Boolean);

  if (!leftUserIds.length) return;

  let changed = false;

  for (const leftUserId of leftUserIds) {
    if ((group.admins || []).includes(leftUserId)) {
      removeAdmin(group, leftUserId);
      changed = true;
    }

    if (group.owner_id === leftUserId) {
      const ownerPlan = await getPlan(leftUserId);
      if (ownerPlan) {
        unbindGroupFromOwner(ownerPlan, chatId);
        await savePlan(ownerPlan);
      }

      group.owner_id = null;
      group.admins = [];
      group.langs = [];
      changed = true;
    }
  }

  if (changed) await saveGroup(group);
}

async function handleLeave(event) {
  const chatId = getChatId(event);
  await releaseGroupBinding(chatId, { deleteGroupRow: true });
}

async function handleJoin(event) {
  const chatId = getChatId(event);
  await ensureGroupDb(chatId);
  await pushLanguageMenu(chatId);
}

async function handleFollow(event) {
  const chatId = getChatId(event);
  const userId = event.source.userId;

  const group = await ensureGroupDb(chatId);

  if (!group.owner_id) group.owner_id = userId;
  addAdmin(group, userId);
  await saveGroup(group);

  let plan = await getPlan(userId);
  if (!plan) {
    plan = createFreeTrialPlanObject(userId);
    await savePlan(plan);
  }

  await replyMessages(event.replyToken, [
    buildLanguageMenuFlex(),
    { type: "text", text: "歡迎使用翻譯機器人。你目前可每日免費使用 20 句。" },
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

  let userPlan = await getPlan(userId);

  if (!userPlan) {
    userPlan = createFreeTrialPlanObject(userId);
    await savePlan(userPlan);
  }

  if (!group.owner_id) {
    if (!isPlanActive(userPlan)) {
      await replyText(event.replyToken, "你目前沒有有效方案，無法設定此群語言。");
      return;
    }

    if (!canUseGroup(userPlan, chatId)) {
      await replyText(event.replyToken, "你的方案可用群組數量已滿，無法綁定此群。");
      return;
    }

    group.owner_id = userId;
    addAdmin(group, userId);
    bindGroupToOwner(userPlan, chatId);

    if (action === "add_lang" && !group.langs.includes(lang)) {
      group.langs.push(lang);
    }

    await saveGroup(group);
    await savePlan(userPlan);

    await replyText(
      event.replyToken,
      `已完成群組綁定，你現在是此群管理人。\n已加入語言：${LANG_LABELS[lang]} (${lang})`
    );
    return;
  }

  const ownerPlan = await getPlan(group.owner_id);

  if (!isSuperAdmin(userId) && !canLanguageManage(group, ownerPlan, userId)) {
    await replyText(event.replyToken, "只有此群的授權管理人可以設定語言，或方案可能已到期。");
    return;
  }

  if (action === "add_lang") {
    if (!group.langs.includes(lang)) group.langs.push(lang);
    group.langs = normalizeLangList(group.langs);
    await saveGroup(group);
    await replyText(
      event.replyToken,
      `已加入語言：${LANG_LABELS[lang]} (${lang})\n目前語言：${group.langs.join(", ")}`
    );
    return;
  }

  if (action === "remove_lang") {
    group.langs = normalizeLangList(group.langs).filter((l) => l !== lang);
    await saveGroup(group);
    await replyText(
      event.replyToken,
      `已移除語言：${LANG_LABELS[lang]} (${lang})\n目前語言：${
        group.langs.length ? group.langs.join(", ") : "無"
      }`
    );
    return;
  }

  await replyText(event.replyToken, "未知操作。");
}

async function handleCommand(event, rawText) {
  const text = rawText.trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0];
  const arg = parts[1] || null;

  const chatId = getChatId(event);
  const userId = event.source.userId;
  const chatType = getChatType(event);

  const group = await ensureGroupDb(chatId);

  if (chatType === "user") {
    if (!group.owner_id && userId) group.owner_id = userId;
    if ((group.admins || []).length === 0 && userId) addAdmin(group, userId);
    await saveGroup(group);
  }

  const ownerId = group.owner_id;
  let plan = ownerId ? await getPlan(ownerId) : null;

  if (ownerId && !plan) {
    plan = createFreeTrialPlanObject(ownerId);
    await savePlan(plan);
  }

  const admin = isAdmin(group, userId);
  const superAdmin = isSuperAdmin(userId);

  if (cmd === "/help" || cmd === "/幫助") {
    await replyText(event.replyToken, admin || superAdmin ? buildAdminHelpText(superAdmin) : buildUserHelpText());
    return true;
  }

  if (cmd === "/myid" || cmd === "/我的ID") {
    await replyText(event.replyToken, `你的 userId：${userId || "目前抓不到 userId"}`);
    return true;
  }

  if (cmd === "/status" || cmd === "/狀態") {
    await replyText(event.replyToken, buildStatusText(group, plan));
    return true;
  }

  if (cmd === "/langs" || cmd === "/語言") {
    await replyText(
      event.replyToken,
      group.langs.length
        ? `本群語言：${group.langs.map((l) => `${LANG_LABELS[l]}(${l})`).join("、")}`
        : `本群尚未設定語言。`
    );
    return true;
  }

  if (cmd === "/expire" || cmd === "/取得時間" || cmd === "/到期時間") {
    await replyText(
      event.replyToken,
      plan?.vip_expires_at
        ? `你的使用期限到：${formatDateTime(plan.vip_expires_at)}`
        : `目前方案：${getPlanDisplayLabel(plan)}`
    );
    return true;
  }

  if (cmd === "/price" || cmd === "/價格") {
    await replyText(
      event.replyToken,
      [
        "翻譯機器人方案",
        "新加入：每日免費20句",
        "試用7天：不限群組 / 不限句數",
        "1群 / 月：500",
        "不限群 / 月：1500",
        "",
        `詳情與開通請聯絡管理員 LINE：${CONTACT_LINE_ID}`,
      ].join("\n")
    );
    return true;
  }

  if (cmd === "/myplan" || cmd === "/我的方案") {
    await replyText(event.replyToken, buildStatusText(group, plan));
    return true;
  }

  if (cmd === "/menu" || cmd === "/語言選單") {
    if (!group.owner_id && chatType !== "user") {
      await replyMessages(event.replyToken, [
        buildLanguageMenuFlex(),
        { type: "text", text: "本群尚未設定管理人。請直接按語言，第一個成功設定的人會成為此群管理人。" },
      ]);
      return true;
    }

    if (!superAdmin && !canLanguageManage(group, plan, userId)) {
      await replyText(event.replyToken, "你目前不能設定語言，可能是權限不足或方案已到期。");
      return true;
    }

    await replyMessages(event.replyToken, [
      buildLanguageMenuFlex(),
      { type: "text", text: "請加入或移除本群要輸出的語言。" },
    ]);
    return true;
  }

  if (cmd === "/重設語言" || cmd === "/resetlangs") {
    if (chatType === "user") {
      await replyText(event.replyToken, "此功能只適用於群組或多人聊天室。");
      return true;
    }

    if (group.owner_id && !superAdmin && !canLanguageManage(group, plan, userId)) {
      await replyText(event.replyToken, "你目前不能重設語言，可能是權限不足或方案已到期。");
      return true;
    }

    group.langs = [];
    await saveGroup(group);

    await replyMessages(event.replyToken, [
      { type: "text", text: "已重設本群語言設定，請重新選擇語言。" },
      buildLanguageMenuFlex(),
    ]);
    return true;
  }

  if (cmd === "/全部會員" || cmd === "/會員列表") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    const page = parsePositiveInt(arg, 1);
    const result = await getAllPlans(page, MEMBER_LIST_PAGE_SIZE);

    if (page > result.totalPages && result.total > 0) {
      await replyText(event.replyToken, `頁數超出範圍，目前只有 ${result.totalPages} 頁。`);
      return true;
    }

    await replyText(event.replyToken, buildAllPlansText(result.rows, result.page, result.totalPages, result.total));
    return true;
  }

  if (cmd === "/同步全部會員") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    const allPlans = await getAllPlansNoPaging();

    if (!allPlans.length) {
      await replyText(event.replyToken, "目前沒有任何會員資料可同步。");
      return true;
    }

    let successCount = 0;
    for (const planItem of allPlans) {
      await syncMemberToGoogleSheet({ userId: planItem.user_id });
      successCount += 1;
    }

    await replyText(event.replyToken, `已同步全部會員到 Google 試算表\n共 ${successCount} 筆`);
    return true;
  }

  if (cmd === "/bind" || cmd === "/綁定") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
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

  if (cmd === "/unbind" || cmd === "/解除綁定") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!ownerId) {
      await replyText(event.replyToken, "尚未綁定方案。");
      return true;
    }

    await releaseGroupBinding(chatId);
    await replyText(event.replyToken, "本群已解除綁定，並清除群組綁定資料。");
    return true;
  }

  if (cmd === "/setadmin" || cmd === "/新增管理員") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/新增管理員 使用者ID");
      return true;
    }

    addAdmin(group, arg);
    await saveGroup(group);
    await replyText(event.replyToken, `已新增管理員：${arg}`);
    return true;
  }

  if (cmd === "/deladmin" || cmd === "/刪除管理員") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/刪除管理員 使用者ID");
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

  if (cmd === "/setowner" || cmd === "/設定擁有者") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/設定擁有者 使用者ID");
      return true;
    }

    group.owner_id = arg;
    addAdmin(group, arg);
    await saveGroup(group);

    let targetPlan = await getPlan(arg);
    if (!targetPlan) {
      targetPlan = createFreeTrialPlanObject(arg);
      await savePlan(targetPlan);
    }

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

    const oldPlan = await getPlan(arg);
    const nextPlan = createPaidPlanObject(arg, "limited_groups", 1, 30, oldPlan, {
      resetBoundGroups: true,
    });

    await savePlan(nextPlan);
    await syncMemberToGoogleSheet({ userId: arg, event, openedAt: getNowTaipeiString() });

    await replyText(
      event.replyToken,
      `已開通 1群 / 30天（已清空舊綁定群）\n使用者：${arg}\n到期：${formatDateTime(nextPlan.vip_expires_at)}`
    );
    return true;
  }

  if (cmd === "/planu30" || cmd === "/開通不限30") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!ownerId && !arg) {
      await replyText(event.replyToken, "本群尚未設定 owner，或用法：/開通不限30 使用者ID");
      return true;
    }

    const targetUserId = arg || ownerId;
    const oldPlan = await getPlan(targetUserId);
    const nextPlan = createPaidPlanObject(targetUserId, "unlimited_groups", null, 30, oldPlan);

    await savePlan(nextPlan);
    await syncMemberToGoogleSheet({ userId: targetUserId, event, openedAt: getNowTaipeiString() });

    await replyText(
      event.replyToken,
      `已開通 不限群組 / 30天\n使用者：${targetUserId}\n到期：${formatDateTime(nextPlan.vip_expires_at)}`
    );
    return true;
  }

  if (cmd === "/試用7天") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/試用7天 使用者ID");
      return true;
    }

    const oldPlan = await getPlan(arg);
    const nextPlan = create7DayTrialPlanObject(arg, oldPlan);
    await savePlan(nextPlan);
    await syncMemberToGoogleSheet({ userId: arg, event, openedAt: getNowTaipeiString() });

    await replyText(
      event.replyToken,
      `已開通 7天試用（不限群組 / 不限句數）\n使用者：${arg}\n到期：${formatDateTime(nextPlan.vip_expires_at)}`
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

  if (cmd === "/清空綁群") {
    if (!superAdmin) {
      await replyText(event.replyToken, "只有最高管理員可以操作。");
      return true;
    }

    if (!arg) {
      await replyText(event.replyToken, "用法：/清空綁群 使用者ID");
      return true;
    }

    const result = await clearAllBindingsByUserId(arg);
    await replyText(event.replyToken, `已清空使用者綁群資料\n使用者：${arg}\n清除群數：${result.clearedGroups}`);
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
    await syncMemberToGoogleSheet({ userId: arg, event });

    await replyText(event.replyToken, `已停用方案：${arg}`);
    return true;
  }

  return false;
}

async function handleTextMessage(event) {
  const startedAt = Date.now();
  const chatId = getChatId(event);
  const userId = event?.source?.userId || "-";

  try {
    const text = (event.message?.text || "").trim();
    if (!text) return;

    if (text.startsWith("/")) {
      const handled = await handleCommand(event, text);
      if (handled) return;
    }

    const chatType = getChatType(event);
    const group = await ensureGroupDb(chatId);

    let actingPlan = null;
    let limitUserId = userId;

    if (chatType === "user") {
      actingPlan = await getPlan(userId);
      if (!actingPlan) {
        actingPlan = createFreeTrialPlanObject(userId);
        await savePlan(actingPlan);
      }
    } else {
      const ownerId = group.owner_id;
      if (!ownerId) {
        await replyText(event.replyToken, "本群尚未設定管理人，請先按語言選單。");
        return;
      }

      actingPlan = await getPlan(ownerId);
      if (!actingPlan) {
        actingPlan = createFreeTrialPlanObject(ownerId);
        await savePlan(actingPlan);
      }
      limitUserId = ownerId;
    }

    if (!isPlanActive(actingPlan)) {
      await replyText(
        event.replyToken,
        [
          "本群翻譯方案已到期",
          "目前無法使用語言設定與自動翻譯",
          "",
          "如需續費開通",
          `請聯絡管理員 LINE：${CONTACT_LINE_ID}`,
        ].join("\n")
      );
      return;
    }

    if (chatType !== "user" && !canUseGroup(actingPlan, chatId)) {
      await replyText(event.replyToken, "此方案可用群組數量已滿，請升級方案。");
      return;
    }

    if (chatType !== "user" && !(actingPlan.bound_groups || []).includes(chatId)) {
      bindGroupToOwner(actingPlan, chatId);
      await savePlan(actingPlan);
    }

    if (actingPlan.daily_limit) {
      const limitResult = await checkDailyLimit(limitUserId, chatId, actingPlan.daily_limit);

      if (!limitResult.allowed) {
        await replyText(
          event.replyToken,
          [
            "你目前為免費試用方案",
            `今日免費 ${actingPlan.daily_limit} 句已用完`,
            "",
            "如需升級或開通 7 天試用",
            `請聯絡管理員 LINE：${CONTACT_LINE_ID}`,
          ].join("\n")
        );
        return;
      }
    }

    if (chatType === "user") {
      const sourceLang = detectSourceLangSimple(text);

      let targetLangs = [];

      if (sourceLang === "th") {
        targetLangs = ["zh-TW", "en"];
      } else if (sourceLang === "zh-TW" || sourceLang === "zh-CN") {
        targetLangs = ["th", "en"];
      } else if (sourceLang === "en") {
        targetLangs = ["zh-TW", "th"];
      } else {
        targetLangs = ["zh-TW", "th", "en"].filter((lang) => lang !== sourceLang);
      }

      let translatedMap = {};
      try {
        translatedMap = await translateToTargets(text, targetLangs);
      } catch (err) {
        console.error("translateToTargets private error:", err);
        if (err?.stack) console.error(err.stack);
        translatedMap = {};
      }

      const outputs = dedupeTranslatedOutputs(
        targetLangs
          .map((lang) => safeTranslatedLine(lang, translatedMap?.[lang] || ""))
          .filter(Boolean)
      );

      if (!outputs.length) {
        try {
          const fallbackLang =
            sourceLang === "th"
              ? "zh-TW"
              : sourceLang === "zh-TW" || sourceLang === "zh-CN"
              ? "th"
              : "zh-TW";

          const fallbackText = await translateToTarget(text, fallbackLang);
          if (fallbackText) {
            await replyText(event.replyToken, safeTranslatedLine(fallbackLang, fallbackText) || "暫時無法翻譯");
            return;
          }
        } catch (err) {
          console.error("private fallback translate error =", err);
          if (err?.stack) console.error(err.stack);
        }

        await replyText(event.replyToken, "目前翻譯暫時不穩，請重送一次。");
        return;
      }

      await replyText(event.replyToken, outputs.join("\n\n"));
      return;
    }

    const targetLangs = normalizeLangList(group.langs || []);
    if (!targetLangs.length) {
      await replyText(event.replyToken, "本群尚未設定語言，請管理人按語言選單設定。");
      return;
    }

    const sourceLang = detectSourceLangSimple(text);
    const langsToTranslate = targetLangs.filter((lang) => lang !== sourceLang);

    if (!langsToTranslate.length) return;

    let translatedMap = {};

    try {
      translatedMap = await translateToTargets(text, langsToTranslate);
    } catch (err) {
      console.error("translateToTargets group error:", err);
      if (err?.stack) console.error(err.stack);

      try {
        const fallbackLang = langsToTranslate[0];
        if (fallbackLang) {
          const fallbackText = await translateToTarget(text, fallbackLang);
          if (fallbackText) {
            await replyText(event.replyToken, safeTranslatedLine(fallbackLang, fallbackText) || "暫時無法翻譯");
            return;
          }
        }
      } catch (fallbackErr) {
        console.error("group fallback translate error:", fallbackErr);
        if (fallbackErr?.stack) console.error(fallbackErr.stack);
      }

      await replyText(event.replyToken, "目前翻譯暫時不穩，請重送一次。");
      return;
    }

    const outputs = dedupeTranslatedOutputs(
      langsToTranslate
        .map((lang) => safeTranslatedLine(lang, translatedMap?.[lang] || ""))
        .filter(Boolean)
    );

    if (!outputs.length) return;

    await replyText(event.replyToken, outputs.join("\n\n"));
  } finally {
    logTiming("handleTextMessage", startedAt, `chatId=${chatId} userId=${userId}`);
  }
}

async function handleEvent(event) {
  const startedAt = Date.now();
  const chatId =
    event?.source?.groupId || event?.source?.roomId || event?.source?.userId || "-";
  const userId = event?.source?.userId || "-";
  const eventType = event?.type || "unknown";

  try {
    if (event?.source?.userId) {
      void captureEventUserProfile(event).catch((profileErr) => {
        console.error("captureEventUserProfile error =", profileErr);
        if (profileErr?.stack) console.error(profileErr.stack);
      });
    }

    if (event.type === "join") {
      await handleJoin(event);
      return;
    }

    if (event.type === "follow") {
      await handleFollow(event);
      return;
    }

    if (event.type === "memberLeft") {
      await handleMemberLeft(event);
      return;
    }

    if (event.type === "leave") {
      await handleLeave(event);
      return;
    }

    if (event.type === "postback") {
      await handlePostback(event);
      return;
    }

    if (event.type === "message" && event.message?.type === "text") {
      await handleTextMessage(event);
    }
  } catch (err) {
    console.error("handleEvent error =", err);
    if (err?.stack) console.error(err.stack);

    if (event?.replyToken) {
      try {
        await replyText(event.replyToken, "系統處理失敗，請稍後再試。");
      } catch (replyErr) {
        console.error("reply fallback error =", replyErr);
      }
    }
  } finally {
    logTiming("handleEvent", startedAt, `type=${eventType} chatId=${chatId} userId=${userId}`);
  }
}

/* =========================================================
 * HTTP
 * ======================================================= */

app.get("/", (_req, res) => {
  res.status(200).send("LINE translator bot is running.");
});

app.get("/health", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.status(200).json({ ok: true, time: result.rows?.[0]?.now || null });
  } catch (err) {
    console.error("/health error =", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/webhook", middleware(lineConfig), (req, res) => {
  // 先回 200，避免 LINE 等翻譯等太久而重送 webhook
  res.sendStatus(200);

  const startedAt = Date.now();
  const events = req.body.events || [];

  void runWithConcurrency(events, WEBHOOK_EVENT_CONCURRENCY, handleEvent)
    .then((results) => {
      const failed = results.filter((r) => r?.status === "rejected");

      if (failed.length) {
        console.error(`Webhook batch failed count=${failed.length}`);
        for (const item of failed) {
          console.error(item.reason);
          if (item.reason?.stack) console.error(item.reason.stack);
        }
      }

      logTiming(
        "webhook_batch",
        startedAt,
        `events=${events.length} concurrency=${WEBHOOK_EVENT_CONCURRENCY}`
      );
    })
    .catch((err) => {
      console.error("Webhook error:", err);
      if (err?.stack) console.error(err.stack);
    });
});

initDb()
  .then(async () => {
    try {
      await pool.query("SELECT NOW()");
    } catch (dbTestErr) {
      console.error("DB connection test failed =", dbTestErr);
      process.exit(1);
    }

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(
        `OpenAI model=${OPENAI_MODEL}, timeout=${OPENAI_TIMEOUT_MS}ms, retries=${OPENAI_MAX_RETRIES}, reasoning=${OPENAI_REASONING_EFFORT}`
      );
      console.log(
        `Webhook concurrency=${WEBHOOK_EVENT_CONCURRENCY}, translation retries=${MAX_TRANSLATION_RETRIES}, timing=${LOG_TIMING}`
      );
      console.log(`Cache version=${CACHE_VERSION}`);
    });
  })
  .catch((err) => {
    console.error("DB init error full =", err);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  });
