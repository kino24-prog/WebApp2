function extractJson(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  }
}

function normalizeImage(image) {
  if (!image?.data) return null;
  return {
    inline_data: {
      mime_type: image.mimeType || 'image/png',
      data: image.data,
    },
  };
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'POSTのみ対応しています。' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    response.status(500).json({ error: 'Gemini APIキーが設定されていません。' });
    return;
  }

  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const body = request.body || {};
  const {
    questionText = '',
    questionImage,
    modelAnswer = '',
    modelAnswerImage,
    rubricText = '',
    maxScore = 10,
    answerImage,
  } = body;

  if (!questionText.trim() && !questionImage?.data) {
    response.status(400).json({ error: '問題文または問題画像を入力してください。' });
    return;
  }

  if (!modelAnswer.trim() && !modelAnswerImage?.data) {
    response.status(400).json({ error: '模範解答または模範解答画像を入力してください。' });
    return;
  }

  if (!answerImage?.data) {
    response.status(400).json({ error: '答案画像がありません。' });
    return;
  }

  const prompt = `
あなたは数学答案の採点者です。
問題画像または問題文を読み取り、手書き答案画像を採点してください。
模範解答と採点基準に基づいて、厳密に採点してください。
読み取れない文字を推測しすぎないでください。
読み取りが不確実な場合は confidence を low にしてください。

採点ルール:
- 最終解答の正誤を最優先で判定してください。
- resultType を correct にしてよいのは、最終解答が模範解答と数学的に等価で、かつ問題で求められた全項目が一致する場合だけです。
- 複素数では、実部、虚部、符号、係数、分母、分子を別々に照合してください。1つでも違えば correct にしてはいけません。
- 分数、平方根、指数、添字、符号、括弧、単位、条件の違いを小さな違いとして無視しないでください。
- 途中式が正しくても、最終解答に数値・符号・係数の誤りがある場合は partial または incorrect にしてください。
- 答案に複数小問がある場合は、小問ごとに最終解答を比較し、1問でも誤りがあれば満点にしないでください。
- 認識した答案と模範解答を見比べ、最終解答の差分を finalAnswerComparison に必ず書いてください。
- 模範解答の形式と答案の形式が違う場合は、必要なら同値変形して比較してください。ただし同値性を確認できない場合は correct にしないでください。

問題文:
${questionText || '問題画像を参照してください。'}

模範解答:
${modelAnswer || '模範解答画像を参照してください。'}

採点基準:
${rubricText || '部分点を考慮し、途中式と最終解答を総合的に採点してください。'}

満点:
${maxScore}

出力は必ず次のJSON形式のみとしてください。説明文やMarkdownは付けないでください。
{
  "recognizedQuestion": "読み取った問題内容",
  "recognizedAnswer": "読み取った答案内容",
  "recognizedLatex": "読み取った主要な数式のLaTeX。なければ空文字",
  "expectedFinalAnswer": "模範解答から抽出した最終解答。小問がある場合は小問ごとに書く",
  "studentFinalAnswer": "答案から抽出した最終解答。小問がある場合は小問ごとに書く",
  "finalAnswerComparison": [
    {
      "item": "小問番号や比較対象",
      "expected": "模範解答の該当部分",
      "student": "答案の該当部分",
      "isEquivalent": false,
      "difference": "実部・虚部・符号・係数など、違いがあれば具体的に書く"
    }
  ],
  "score": 0,
  "maxScore": ${Number(maxScore) || 10},
  "resultType": "correct | partial | incorrect | unreadable",
  "feedback": "学習者向けの短い日本語フィードバック",
  "mistakes": ["誤りや不足点"],
  "improvements": ["次に直すべきポイント"],
  "confidence": "high | medium | low"
}
`;

  const parts = [{ text: prompt }];
  const normalizedQuestionImage = normalizeImage(questionImage);
  if (normalizedQuestionImage) {
    parts.push({ text: '問題画像:' });
    parts.push(normalizedQuestionImage);
  }

  const normalizedModelAnswerImage = normalizeImage(modelAnswerImage);
  if (normalizedModelAnswerImage) {
    parts.push({ text: '模範解答画像:' });
    parts.push(normalizedModelAnswerImage);
  }

  parts.push({ text: '手書き答案画像:' });
  parts.push(normalizeImage(answerImage));

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
    },
  );

  const geminiBody = await geminiResponse.json();

  if (!geminiResponse.ok) {
    response.status(geminiResponse.status).json({
      error:
        geminiResponse.status === 429
          ? '無料枠またはレート制限に達した可能性があります。'
          : geminiBody.error?.message || 'Gemini APIで採点に失敗しました。',
    });
    return;
  }

  const rawText = geminiBody.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
  const result = extractJson(rawText);

  if (!result) {
    response.status(502).json({
      error: 'GeminiのJSON結果を解析できませんでした。',
      rawText,
    });
    return;
  }

  response.status(200).json({
    result,
    rawText,
    modelName,
  });
}
