function hasChinese(text = "") {
  return /[\u4E00-\u9FFF]/.test(text);
}

function hasThai(text = "") {
  return /[\u0E00-\u0E7F]/.test(text);
}

function looksLikeThaiFamilyText(text = "") {
  return /[\u0E00-\u0E7F]/.test(text);
}

function cleanupTranslation(text = "") {
  return text
    .replace(/^\s*翻譯[:：]\s*/i, "")
    .replace(/^\s*translation[:：]\s*/i, "")
    .replace(/\[.*?\]/g, "")
    .replace(/【.*?】/g, "")
    .replace(/^["「『]+|["」』]+$/g, "")
    .trim();
}

function isVeryShortText(text = "") {
  const cleaned = text.trim();
  if (!cleaned) return false;
  const noSpace = cleaned.replace(/\s+/g, "");
  return noSpace.length <= 12;
}

function looksLikeThaiShortChat(text = "") {
  if (!hasThai(text)) return false;

  const t = text.trim().toLowerCase();

  return (
    isVeryShortText(t) ||
    /^(ยัง|ยังคะ|ยังค่ะ|ยังครับ|ยังไหม|ยังมั้ย|ยังหรอ|ยังเหรอ|ได้|ได้ค่ะ|ได้คะ|ได้ครับ|ค่ะ|คะ|ครับ|หรอ|เหรอ|อ่อ|อืม|จ้า|จ๋า|นะ|น้า|อยู่ไหม|อยู่มั้ย|หายไปไหน)$/.test(
      t
    )
  );
}

async function translateThaiDialectToChinese(text, targetLang = "zh-TW") {
  const chineseName = targetLang === "zh-CN" ? "简体中文" : "繁體中文";

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: `
你是翻譯機器人，不是聊天機器人。

任務：
把使用者輸入的內容，從泰語或泰國各地區常見說法，翻譯成自然的${chineseName}。

你必須先在內部理解這段內容比較接近：
- 標準泰語
- 北部說法
- 東北 Isan 說法
- 南部說法
- 混合說法
但不要把判斷結果顯示出來。

嚴格規則：
1. 你只能做翻譯，不可回話
2. 不可把原文當成對你說話
3. 不可自行補成完整對話
4. 不可添加原文沒有的情緒、稱呼、人物關係
5. 不可輸出像「好的親愛的、Yes dear、OK honey」這類腦補內容
6. 如果原文是超短聊天句，請依最常見聊天語境翻成自然口語
7. 像「ยัง」「ยังคะ」「ยังค่ะ」這類短句，優先理解為「還、還沒、還在、還有嗎」這類語意，不可亂翻成回答句
8. 只輸出${chineseName}
9. 不可輸出泰文原文
10. 不可解釋
11. 不可標註方言類型
12. 只輸出最終翻譯結果

內容：
${text}
    `.trim(),
  });

  let output = cleanupTranslation(response.output_text || "");

  if (hasThai(output)) {
    const retry = await openai.responses.create({
      model: OPENAI_MODEL,
      input: `
你上一版翻譯不合格，因為結果裡還有泰文。

現在請重新把下面內容翻成${chineseName}。

規則：
1. 只能輸出${chineseName}
2. 不可出現任何泰文
3. 不可回話
4. 不可腦補對話
5. 像「ยังคะ」優先翻成「還在嗎／還沒嗎／還有嗎」這類自然聊天句
6. 不可解釋
7. 只輸出翻譯結果

內容：
${text}
      `.trim(),
    });

    output = cleanupTranslation(retry.output_text || output);
  }

  return output;
}

async function translateToTarget(text, targetLang) {
  const targetName = getLangPureName(targetLang);
  const thaiShortChat = looksLikeThaiShortChat(text);

  if ((targetLang === "zh-TW" || targetLang === "zh-CN") && looksLikeThaiFamilyText(text)) {
    return await translateThaiDialectToChinese(text, targetLang);
  }

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: `
你是翻譯機器人，不是聊天機器人。

任務：
把使用者提供的內容，完整翻譯成「${targetName}」。

嚴格規則：
1. 你只能翻譯，不可回覆使用者
2. 不可把原文當成在跟你對話
3. 不可自行補成完整對話
4. 不可添加原文沒有的情緒、稱呼、人物關係
5. 不可輸出像 Yes, dear? / OK honey / 好的寶貝 這類腦補內容
6. 保留原本語氣，翻譯要自然口語
7. 若原文是超短聊天句，請依最常見聊天語境翻譯，不可自由創作
8. ${
      thaiShortChat
        ? `這句屬於泰文超短聊天句，像「ยัง」「ยังคะ」「ยังค่ะ」應優先理解成「還、還沒、還在、還有嗎」這類意思，不可翻成回答句。`
        : `如果原文很短，也仍然只能忠實翻譯，不可亂補內容。`
    }
9. 只能輸出 ${targetName}
10. 不可夾雜原文
11. 不可保留其他語言詞
12. 不可解釋、不可補充、不可摘要
13. 不要加引號
14. 不要加「翻譯：」這類前綴
15. 只輸出最終翻譯結果

要翻譯的內容：
${text}
    `.trim(),
  });

  let output = cleanupTranslation(response.output_text || "");

  if (targetLang === "th" && hasChinese(output)) {
    const retry = await openai.responses.create({
      model: OPENAI_MODEL,
      input: `
你上一版翻譯不合格，因為結果裡還有中文。

現在請重新把下面內容完整翻譯成泰文。

嚴格規則：
1. 只能輸出純泰文
2. 不可出現任何中文
3. 不可出現英文原文
4. 不可回話
5. 不可腦補對話
6. 只輸出翻譯結果

內容：
${text}
      `.trim(),
    });

    output = cleanupTranslation(retry.output_text || output);
  }

  if ((targetLang === "zh-TW" || targetLang === "zh-CN") && hasThai(output)) {
    const retry = await openai.responses.create({
      model: OPENAI_MODEL,
      input: `
你上一版翻譯不合格，因為結果裡還有泰文。

現在請重新把下面內容完整翻譯成${targetName}。

嚴格規則：
1. 只能輸出${targetName}
2. 不可出現泰文
3. 不可出現其他原文
4. 不可回話
5. 不可腦補對話
6. 只輸出翻譯結果

內容：
${text}
      `.trim(),
    });

    output = cleanupTranslation(retry.output_text || output);
  }

  if (targetLang === "en" && /[\u4E00-\u9FFF\u0E00-\u0E7F]/.test(output) && !/[A-Za-z]/.test(output)) {
    const retry = await openai.responses.create({
      model: OPENAI_MODEL,
      input: `
你上一版翻譯不合格，因為結果不是純英文。

現在請重新把下面內容完整翻譯成英文。

嚴格規則：
1. 只能輸出純英文
2. 不可出現中文或泰文
3. 不可回話
4. 不可腦補對話
5. 若原文是泰文短句，例如「ยังคะ」，應翻成自然英文，如 "Are you still there?" 或 "Not yet?"，不可翻成 "Yes, dear?"
6. 只輸出翻譯結果

內容：
${text}
      `.trim(),
    });

    output = cleanupTranslation(retry.output_text || output);
  }

  return output;
}
