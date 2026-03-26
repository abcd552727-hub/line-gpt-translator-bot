import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { Client, middleware } from '@line/bot-sdk';

dotenv.config();

const {
  PORT = 3000,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4.1-mini',
  DEFAULT_TARGET_LANG = 'zh-TW'
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !OPENAI_API_KEY) {
  console.error('Missing required environment variables. Check .env file.');
  process.exit(1);
}

const app = express();

const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};

const lineClient = new Client(lineConfig);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// 簡單記憶每個聊天室設定
const roomSettings = new Map();

function getSourceKey(event) {
  return (
    event.source?.groupId ||
    event.source?.roomId ||
    event.source?.userId ||
    'default'
  );
}

function getRoomSetting(event) {
  const key = getSourceKey(event);

  if (!roomSettings.has(key)) {
    roomSettings.set(key, {
      autoTranslate: true,
      targetLang: DEFAULT_TARGET_LANG
    });
  }

  return roomSettings.get(key);
}

function detectTargetLang(input) {
  const value = String(input || '').trim().toLowerCase();

  if (['zh', 'zh-tw', 'tw', '中文', '繁中', '繁體', '繁體中文'].includes(value)) {
    return 'zh-TW';
  }

  if (['th', 'thai', '泰文', '泰語'].includes(value)) {
    return 'th';
  }

  if (['en', 'english', '英文', '英語'].includes(value)) {
    return 'en';
  }

  return null;
}

function buildHelpText(setting) {
  return [
    '可用指令：',
    '/help',
    '/status',
    '/auto on',
    '/auto off',
    '/lang zh-TW',
    '/lang th',
    '/lang en',
    '',
    `目前自動翻譯：${setting.autoTranslate ? '開啟' : '關閉'}`,
    `目前目標語言：${setting.targetLang}`
  ].join('\n');
}

async function translateText(text, targetLang) {
  const prompt = [
    `你是專業翻譯助理。`,
    `請把使用者輸入翻譯成 ${targetLang}。`,
    `只輸出翻譯結果，不要加說明，不要加引號。`,
    '',
    text
  ].join('\n');

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: prompt
  });

  return (response.output_text || '').trim();
}

async function handleCommand(event, text) {
  const setting = getRoomSetting(event);
  const cmd = text.trim();

  if (cmd === '/help') {
    await lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: buildHelpText(setting)
    });
    return true;
  }

  if (cmd === '/status') {
    await lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: `自動翻譯：${setting.autoTranslate ? '開啟' : '關閉'}\n目標語言：${setting.targetLang}`
    });
    return true;
  }

  if (cmd === '/auto on') {
    setting.autoTranslate = true;
    await lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: '已開啟自動翻譯'
    });
    return true;
  }

  if (cmd === '/auto off') {
    setting.autoTranslate = false;
    await lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: '已關閉自動翻譯'
    });
    return true;
  }

  if (cmd.startsWith('/lang ')) {
    const rawLang = cmd.slice(6).trim();
    const targetLang = detectTargetLang(rawLang);

    if (!targetLang) {
      await lineClient.replyMessage(event.replyToken, {
        type: 'text',
        text: '語言不支援，請用：/lang zh-TW、/lang th、/lang en'
      });
      return true;
    }

    setting.targetLang = targetLang;
    await lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: `已切換目標語言為 ${targetLang}`
    });
    return true;
  }

  return false;
}

async function handleTextMessage(event) {
  const text = event.message?.text?.trim();

  if (!text) return;

  const isCommand = text.startsWith('/');
  if (isCommand) {
    const handled = await handleCommand(event, text);
    if (handled) return;
  }

  const setting = getRoomSetting(event);

  if (!setting.autoTranslate) {
    await lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: '目前自動翻譯已關閉。輸入 /auto on 可重新開啟。'
    });
    return;
  }

  const translated = await translateText(text, setting.targetLang);

  await lineClient.replyMessage(event.replyToken, {
    type: 'text',
    text: translated || '翻譯失敗，請稍後再試。'
  });
}

async function handleEvent(event) {
  if (event.type !== 'message') return;
  if (event.message?.type !== 'text') return;

  await handleTextMessage(event);
}

app.get('/', (_req, res) => {
  res.status(200).send('LINE GPT Translator Bot is running.');
});

app.post('/webhook', middleware(lineConfig), async (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];

    await Promise.all(events.map(handleEvent));
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook handling error:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
