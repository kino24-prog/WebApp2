import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './styles.css';
import { deleteRecord, getAllRecords, getUsage, saveRecord, saveUsage } from './storage.js';

const timezoneBasis = 'America/Los_Angeles';
const defaultDailyLimit = 50;

const emptyDraft = () => ({
  id: crypto.randomUUID(),
  title: '',
  questionText: '',
  questionImageDataUrl: '',
  questionImageName: '',
  questionImageMimeType: '',
  questionImageImportedAt: '',
  modelAnswer: '',
  modelAnswerImageDataUrl: '',
  modelAnswerImageName: '',
  modelAnswerImageMimeType: '',
  modelAnswerImageImportedAt: '',
  rubricText: '',
  maxScore: 10,
  strokes: [],
  answerImageDataUrl: '',
  gradingResult: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

function getUsageDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezoneBasis,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function imageDataUrlToPayload(dataUrl) {
  if (!dataUrl) return null;
  const [header, data] = dataUrl.split(',');
  const match = header.match(/data:(.*?);base64/);
  return {
    mimeType: match?.[1] || 'image/png',
    data,
  };
}

function FormulaPreview({ formula, emptyText = 'LaTeXプレビュー' }) {
  const html = useMemo(() => {
    if (!formula?.trim()) {
      return `<span class="preview-empty">${emptyText}</span>`;
    }

    return katex.renderToString(formula, {
      throwOnError: false,
      displayMode: true,
      strict: false,
    });
  }, [emptyText, formula]);

  return <div className="formula-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

function UsageMeter({ usage, dailyLimit }) {
  const used = usage?.successfulRequests || 0;
  const limit = Math.max(1, Number(dailyLimit) || defaultDailyLimit);
  const remaining = Math.max(0, limit - used);
  const rate = Math.min(1, used / limit);
  const degrees = Math.round(rate * 360);
  const tone = rate >= 0.9 ? 'danger' : rate >= 0.8 ? 'warning' : 'normal';

  return (
    <section className={`usage-meter ${tone}`}>
      <div
        className="usage-ring"
        style={{
          background: `conic-gradient(var(--meter-color) ${degrees}deg, #e8ddcc ${degrees}deg)`,
        }}
        aria-label={`Gemini無料枠の使用目安 ${used}/${limit}`}
      >
        <span>{Math.round(rate * 100)}%</span>
      </div>
      <div>
        <strong>Gemini無料枠</strong>
        <p>{used} / {limit} 回</p>
        <small>残り目安: {remaining}回 / RPD基準: 太平洋時間0:00</small>
      </div>
    </section>
  );
}

function DrawingCanvas({ strokes, setStrokes, tool, penSize, eraserSize }) {
  const canvasRef = useRef(null);
  const currentStrokeRef = useRef(null);
  const activePointerIdRef = useRef(null);
  const activePointersRef = useRef(new Set());
  const multiTouchBlockedRef = useRef(false);
  const [eraserPoint, setEraserPoint] = useState(null);

  const distanceToSegment = (point, start, end) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
      return Math.hypot(point.x - start.x, point.y - start.y);
    }

    const t = Math.max(
      0,
      Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
    );

    return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
  };

  const strokeHitsEraser = (stroke, point, radius) => {
    if (stroke.points.some((strokePoint) => Math.hypot(strokePoint.x - point.x, strokePoint.y - point.y) <= radius)) {
      return true;
    }

    for (let index = 1; index < stroke.points.length; index += 1) {
      if (distanceToSegment(point, stroke.points[index - 1], stroke.points[index]) <= radius) {
        return true;
      }
    }

    return false;
  };

  const drawStroke = useCallback((context, stroke) => {
    if (stroke.points.length < 2) return;

    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.width;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(stroke.points[0].x, stroke.points[0].y);

    for (let index = 1; index < stroke.points.length; index += 1) {
      const point = stroke.points[index];
      context.lineTo(point.x, point.y);
    }

    context.stroke();
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * scale);
    canvas.height = Math.floor(rect.height * scale);

    const context = canvas.getContext('2d');
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    strokes.forEach((stroke) => drawStroke(context, stroke));
  }, [drawStroke, strokes]);

  useEffect(() => {
    redraw();
    window.addEventListener('resize', redraw);
    return () => window.removeEventListener('resize', redraw);
  }, [redraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const blockBrowserGesture = (event) => {
      event.preventDefault();
    };

    canvas.addEventListener('contextmenu', blockBrowserGesture);
    canvas.addEventListener('selectstart', blockBrowserGesture);
    canvas.addEventListener('touchstart', blockBrowserGesture, { passive: false });
    canvas.addEventListener('touchmove', blockBrowserGesture, { passive: false });

    return () => {
      canvas.removeEventListener('contextmenu', blockBrowserGesture);
      canvas.removeEventListener('selectstart', blockBrowserGesture);
      canvas.removeEventListener('touchstart', blockBrowserGesture);
      canvas.removeEventListener('touchmove', blockBrowserGesture);
    };
  }, []);

  const getPoint = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const finishCurrentStroke = () => {
    const completedStroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    activePointerIdRef.current = null;
    document.body.classList.remove('is-drawing');

    if (!completedStroke) return;

    if (completedStroke.points.length === 1) {
      const point = completedStroke.points[0];
      completedStroke.points.push({ x: point.x + 0.1, y: point.y + 0.1 });
    }

    setStrokes((current) => [...current, completedStroke]);
  };

  const cancelCurrentStroke = () => {
    currentStrokeRef.current = null;
    activePointerIdRef.current = null;
    document.body.classList.remove('is-drawing');
    setEraserPoint(null);
    redraw();
  };

  const eraseAtPoint = (point) => {
    setStrokes((current) =>
      current.filter((stroke) => !strokeHitsEraser(stroke, point, Number(eraserSize) / 2)),
    );
  };

  const startDrawing = (event) => {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();

    activePointersRef.current.add(event.pointerId);

    if (activePointersRef.current.size > 1 || !event.isPrimary) {
      multiTouchBlockedRef.current = true;
      cancelCurrentStroke();
      return;
    }

    multiTouchBlockedRef.current = false;
    document.body.classList.add('is-drawing');
    canvasRef.current.setPointerCapture(event.pointerId);
    activePointerIdRef.current = event.pointerId;

    if (tool === 'eraser') {
      const point = getPoint(event);
      setEraserPoint(point);
      eraseAtPoint(point);
      return;
    }

    currentStrokeRef.current = {
      color: '#1d1d1d',
      width: Number(penSize),
      points: [getPoint(event)],
    };
  };

  const continueDrawing = (event) => {
    event.preventDefault();
    if (multiTouchBlockedRef.current || event.pointerId !== activePointerIdRef.current) {
      return;
    }

    const point = getPoint(event);

    if (tool === 'eraser') {
      setEraserPoint(point);
      eraseAtPoint(point);
      return;
    }

    if (!currentStrokeRef.current) {
      return;
    }

    currentStrokeRef.current.points.push(point);

    const context = canvasRef.current.getContext('2d');
    const points = currentStrokeRef.current.points;
    const previous = points[points.length - 2];

    context.strokeStyle = currentStrokeRef.current.color;
    context.lineWidth = currentStrokeRef.current.width;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
  };

  const endDrawing = (event) => {
    event.preventDefault();
    activePointersRef.current.delete(event.pointerId);

    if (event.pointerId !== activePointerIdRef.current) {
      if (activePointersRef.current.size === 0) {
        multiTouchBlockedRef.current = false;
      }
      return;
    }

    if (multiTouchBlockedRef.current) {
      cancelCurrentStroke();
      if (activePointersRef.current.size === 0) {
        multiTouchBlockedRef.current = false;
      }
      return;
    }

    if (tool === 'eraser') {
      activePointerIdRef.current = null;
      document.body.classList.remove('is-drawing');
      setEraserPoint(null);
      return;
    }

    finishCurrentStroke();
  };

  return (
    <div className="canvas-touch-layer">
      <canvas
        ref={canvasRef}
        className={`drawing-canvas ${tool === 'eraser' ? 'is-eraser' : ''}`}
        aria-label="手書き答案入力エリア"
        onContextMenu={(event) => event.preventDefault()}
        onSelect={(event) => event.preventDefault()}
        onPointerDown={startDrawing}
        onPointerMove={continueDrawing}
        onPointerUp={endDrawing}
        onPointerCancel={endDrawing}
        onPointerLeave={endDrawing}
      />
      {tool === 'eraser' && eraserPoint && (
        <span
          className="eraser-cursor"
          style={{
            width: `${eraserSize}px`,
            height: `${eraserSize}px`,
            left: `${eraserPoint.x}px`,
            top: `${eraserPoint.y}px`,
          }}
        />
      )}
    </div>
  );
}

function QuestionPanel({ draft, updateDraft }) {
  const questionFileInputRef = useRef(null);
  const modelAnswerFileInputRef = useRef(null);

  const importImage = async (event, target) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('対応していない画像形式です。');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (target === 'question') {
        updateDraft({
          questionImageDataUrl: reader.result,
          questionImageName: file.name,
          questionImageMimeType: file.type,
          questionImageImportedAt: new Date().toISOString(),
        });
      } else {
        updateDraft({
          modelAnswerImageDataUrl: reader.result,
          modelAnswerImageName: file.name,
          modelAnswerImageMimeType: file.type,
          modelAnswerImageImportedAt: new Date().toISOString(),
        });
      }
    };
    reader.onerror = () => alert('画像を読み込めませんでした。');
    reader.readAsDataURL(file);
  };

  return (
    <section className="panel question-panel">
      <div className="panel-heading">
        <h2>問題入力</h2>
        <input
          className="compact-input"
          value={draft.title}
          onChange={(event) => updateDraft({ title: event.target.value })}
          placeholder="タイトル"
        />
      </div>

      <label>
        問題文
        <textarea
          value={draft.questionText}
          onChange={(event) => updateDraft({ questionText: event.target.value })}
          placeholder="問題文を入力、または下のボタンから問題画像を追加"
        />
      </label>

      <div className="image-import-row">
        <button type="button" onClick={() => questionFileInputRef.current?.click()}>
          問題画像を追加
        </button>
        <input
          ref={questionFileInputRef}
          type="file"
          accept="image/*"
          onChange={(event) => importImage(event, 'question')}
          hidden
        />
        {draft.questionImageDataUrl && (
          <button
            className="delete-button"
            type="button"
            onClick={() =>
              updateDraft({
                questionImageDataUrl: '',
                questionImageName: '',
                questionImageMimeType: '',
                questionImageImportedAt: '',
              })
            }
          >
            画像削除
          </button>
        )}
      </div>

      {draft.questionImageDataUrl && (
        <figure className="image-preview">
          <img src={draft.questionImageDataUrl} alt="取り込んだ問題" />
          <figcaption>{draft.questionImageName || '問題画像'}</figcaption>
        </figure>
      )}

      <label>
        模範解答
        <textarea
          value={draft.modelAnswer}
          onChange={(event) => updateDraft({ modelAnswer: event.target.value })}
          placeholder="正答、解法、期待する答え。画像だけでも可"
        />
      </label>

      <div className="image-import-row">
        <button type="button" onClick={() => modelAnswerFileInputRef.current?.click()}>
          模範解答画像を追加
        </button>
        <input
          ref={modelAnswerFileInputRef}
          type="file"
          accept="image/*"
          onChange={(event) => importImage(event, 'modelAnswer')}
          hidden
        />
        {draft.modelAnswerImageDataUrl && (
          <button
            className="delete-button"
            type="button"
            onClick={() =>
              updateDraft({
                modelAnswerImageDataUrl: '',
                modelAnswerImageName: '',
                modelAnswerImageMimeType: '',
                modelAnswerImageImportedAt: '',
              })
            }
          >
            画像削除
          </button>
        )}
      </div>

      {draft.modelAnswerImageDataUrl && (
        <figure className="image-preview">
          <img src={draft.modelAnswerImageDataUrl} alt="取り込んだ模範解答" />
          <figcaption>{draft.modelAnswerImageName || '模範解答画像'}</figcaption>
        </figure>
      )}

      <div className="score-row">
        <label>
          配点
          <input
            type="number"
            min="1"
            value={draft.maxScore}
            onChange={(event) => updateDraft({ maxScore: Number(event.target.value) })}
          />
        </label>
      </div>

      <label>
        採点基準
        <textarea
          value={draft.rubricText}
          onChange={(event) => updateDraft({ rubricText: event.target.value })}
          placeholder="部分点、減点条件、重視点"
        />
      </label>
    </section>
  );
}

function AnswerPanel({ draft, setDraft, tool, setTool, penSize, setPenSize, eraserSize, setEraserSize, canvasHostRef }) {
  const undo = () => {
    setDraft((current) => ({ ...current, strokes: current.strokes.slice(0, -1) }));
  };

  const clear = () => {
    if (!draft.strokes.length) return;
    if (confirm('答案をすべて消しますか？')) {
      setDraft((current) => ({ ...current, strokes: [] }));
    }
  };

  return (
    <section className="panel answer-panel">
      <div className="panel-heading">
        <h2>答案入力</h2>
      </div>
      <div className="tool-row">
        <div className="tool-actions">
          <button type="button" onClick={undo} disabled={!draft.strokes.length}>
            戻る
          </button>
          <button type="button" onClick={clear} disabled={!draft.strokes.length}>
            クリア
          </button>
        </div>
        <div className="tool-switch" aria-label="描画ツール">
          <button className={tool === 'pen' ? 'active-tool' : ''} type="button" onClick={() => setTool('pen')}>
            ペン
          </button>
          <button className={tool === 'eraser' ? 'active-tool' : ''} type="button" onClick={() => setTool('eraser')}>
            消しゴム
          </button>
        </div>
        <label className="size-control">
          {tool === 'pen' ? 'ペン太さ' : '消しゴム'}
          <input
            type="range"
            min={tool === 'pen' ? '2' : '16'}
            max={tool === 'pen' ? '12' : '90'}
            value={tool === 'pen' ? penSize : eraserSize}
            onChange={(event) =>
              tool === 'pen' ? setPenSize(event.target.value) : setEraserSize(event.target.value)
            }
          />
          <span>{tool === 'pen' ? penSize : eraserSize}</span>
        </label>
      </div>
      <div className="paper-canvas" ref={canvasHostRef}>
        <DrawingCanvas
          strokes={draft.strokes}
          setStrokes={(updater) => {
            setDraft((current) => ({
              ...current,
              strokes: typeof updater === 'function' ? updater(current.strokes) : updater,
            }));
          }}
          tool={tool}
          penSize={penSize}
          eraserSize={eraserSize}
        />
      </div>
    </section>
  );
}

function GradingPanel({ result, status, rawText }) {
  return (
    <section className="panel grading-panel">
      <div className="panel-heading">
        <h2>採点結果</h2>
      </div>
      {status && <p className="status-message">{status}</p>}
      {!result ? (
        <div className="empty-result">採点すると結果がここに表示されます。</div>
      ) : (
        <div className="result-stack">
          <div className={`score-badge ${result.resultType || ''}`}>
            <span>{result.score ?? '-'} / {result.maxScore ?? '-'}</span>
            <small>{result.resultType || 'result'}</small>
          </div>
          <section>
            <h3>読み取り問題</h3>
            <p>{result.recognizedQuestion || '未取得'}</p>
          </section>
          <section>
            <h3>読み取り答案</h3>
            <p>{result.recognizedAnswer || '未取得'}</p>
          </section>
          <FormulaPreview formula={result.recognizedLatex || ''} emptyText="読み取りLaTeXなし" />
          <section>
            <h3>フィードバック</h3>
            <p>{result.feedback || 'なし'}</p>
          </section>
          <section>
            <h3>間違い</h3>
            <ul>{(result.mistakes || []).map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
          <section>
            <h3>改善案</h3>
            <ul>{(result.improvements || []).map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
          <p className="meta-text">信頼度: {result.confidence || 'unknown'}</p>
        </div>
      )}
      {rawText && (
        <details className="raw-result">
          <summary>生テキスト</summary>
          <pre>{rawText}</pre>
        </details>
      )}
    </section>
  );
}

function HistoryList({ records, onLoad, onDelete }) {
  return (
    <section className="history-section">
      <h2>採点履歴</h2>
      {records.length === 0 ? (
        <p className="meta-text">まだ履歴はありません。</p>
      ) : (
        <div className="history-list">
          {records.map((record) => (
            <article className="history-card" key={record.id}>
              <button type="button" onClick={() => onLoad(record)}>
                <strong>{record.title || '無題の答案'}</strong>
                <small>{formatDate(record.updatedAt)}</small>
              </button>
              <span>{record.gradingResult ? `${record.gradingResult.score}/${record.gradingResult.maxScore}` : '未採点'}</span>
              <button className="delete-button" type="button" onClick={() => onDelete(record)}>
                削除
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function App() {
  const [draft, setDraft] = useState(emptyDraft);
  const [inputView, setInputView] = useState('answer');
  const [records, setRecords] = useState([]);
  const [usage, setUsage] = useState(null);
  const [dailyLimit, setDailyLimit] = useState(defaultDailyLimit);
  const [modelName, setModelName] = useState('gemini-2.5-flash-lite');
  const [tool, setTool] = useState('pen');
  const [penSize, setPenSize] = useState(4);
  const [eraserSize, setEraserSize] = useState(34);
  const [status, setStatus] = useState('');
  const [rawText, setRawText] = useState('');
  const canvasHostRef = useRef(null);
  const usageDate = getUsageDate();

  const loadRecords = useCallback(async () => {
    setRecords(await getAllRecords());
  }, []);

  const loadUsage = useCallback(async () => {
    const stored = await getUsage(usageDate);
    setUsage(
      stored || {
        usageDate,
        timezoneBasis,
        modelName,
        dailyLimit,
        successfulRequests: 0,
        failedRequests: 0,
      },
    );
  }, [dailyLimit, modelName, usageDate]);

  useEffect(() => {
    loadRecords();
    loadUsage();

    fetch('/api/usage-config')
      .then((response) => response.json())
      .then((config) => {
        if (config.dailyLimit) setDailyLimit(Number(config.dailyLimit));
        if (config.modelName) setModelName(config.modelName);
      })
      .catch(() => {
        setStatus('利用量設定を取得できませんでした。既定値で続行します。');
      });
  }, [loadRecords, loadUsage]);

  const updateDraft = (patch) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const exportCanvasImage = () => {
    const canvas = canvasHostRef.current?.querySelector('canvas');
    return canvas ? canvas.toDataURL('image/png') : '';
  };

  const persistRecord = async (recordPatch = {}) => {
    const now = new Date().toISOString();
    const record = {
      ...draft,
      ...recordPatch,
      answerImageDataUrl: exportCanvasImage(),
      title: draft.title.trim(),
      updatedAt: now,
    };

    await saveRecord(record);
    setDraft(record);
    await loadRecords();
    return record;
  };

  const incrementUsage = async (field) => {
    const current = usage || {
      usageDate,
      timezoneBasis,
      modelName,
      dailyLimit,
      successfulRequests: 0,
      failedRequests: 0,
    };
    const next = {
      ...current,
      dailyLimit,
      modelName,
      [field]: (current[field] || 0) + 1,
      lastRequestAt: new Date().toISOString(),
    };
    if (field === 'failedRequests') {
      next.lastRateLimitErrorAt = new Date().toISOString();
    }
    await saveUsage(next);
    setUsage(next);
  };

  const validateBeforeGrade = () => {
    if (!draft.questionText.trim() && !draft.questionImageDataUrl) {
      return '問題文または問題画像を入力してください。';
    }
    if (!draft.modelAnswer.trim() && !draft.modelAnswerImageDataUrl) {
      return '模範解答または模範解答画像を入力してください。';
    }
    if (!draft.strokes.length) {
      return '答案を手書きしてください。';
    }
    const used = usage?.successfulRequests || 0;
    if (used >= dailyLimit && !confirm('残り目安が0回です。このまま採点しますか？')) {
      return '採点をキャンセルしました。';
    }
    return '';
  };

  const grade = async () => {
    setRawText('');
    const validation = validateBeforeGrade();
    if (validation) {
      setStatus(validation);
      return;
    }

    setStatus('Geminiで採点中です...');
    const answerImageDataUrl = exportCanvasImage();

    try {
      const response = await fetch('/api/grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionText: draft.questionText,
          questionImage: imageDataUrlToPayload(draft.questionImageDataUrl),
          modelAnswer: draft.modelAnswer,
          modelAnswerImage: imageDataUrlToPayload(draft.modelAnswerImageDataUrl),
          rubricText: draft.rubricText,
          maxScore: Number(draft.maxScore) || 10,
          answerImage: imageDataUrlToPayload(answerImageDataUrl),
        }),
      });

      const body = await response.json();

      if (!response.ok) {
        if (response.status === 429) await incrementUsage('failedRequests');
        throw new Error(body.error || '採点に失敗しました。');
      }

      setRawText(body.rawText || '');
      await incrementUsage('successfulRequests');
      await persistRecord({ answerImageDataUrl, gradingResult: body.result });
      setStatus('採点しました。');
    } catch (error) {
      setStatus(error.message);
    }
  };

  const saveCurrent = async () => {
    try {
      await persistRecord();
      setStatus('保存しました。');
    } catch {
      setStatus('保存に失敗しました。');
    }
  };

  const deleteExistingRecord = async (record) => {
    if (!confirm(`「${record.title || '無題の答案'}」を削除しますか？`)) return;
    await deleteRecord(record.id);
    await loadRecords();
    if (draft.id === record.id) {
      setDraft(emptyDraft());
    }
  };

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <p className="eyebrow">Gemini API Grading</p>
          <h1>手書き答案採点</h1>
        </div>
        <UsageMeter usage={usage} dailyLimit={dailyLimit} />
        <div className="header-actions">
          <button type="button" onClick={() => setDraft(emptyDraft())}>
            新規
          </button>
          <button type="button" onClick={saveCurrent}>
            保存
          </button>
          <button className="primary-button" type="button" onClick={grade}>
            採点する
          </button>
        </div>
      </header>

      <section className="grading-layout">
        <section className="input-workspace">
          <div className="input-tabs" aria-label="入力切替">
            <button
              className={inputView === 'answer' ? 'active-tab' : ''}
              type="button"
              onClick={() => setInputView('answer')}
            >
              答案
            </button>
            <button
              className={inputView === 'question' ? 'active-tab' : ''}
              type="button"
              onClick={() => setInputView('question')}
            >
              問題・模範解答
            </button>
          </div>
          {inputView === 'question' ? (
            <QuestionPanel draft={draft} updateDraft={updateDraft} />
          ) : (
            <AnswerPanel
              draft={draft}
              setDraft={setDraft}
              tool={tool}
              setTool={setTool}
              penSize={penSize}
              setPenSize={setPenSize}
              eraserSize={eraserSize}
              setEraserSize={setEraserSize}
              canvasHostRef={canvasHostRef}
            />
          )}
        </section>
        <GradingPanel result={draft.gradingResult} status={status} rawText={rawText} />
      </section>

      <HistoryList records={records} onLoad={setDraft} onDelete={deleteExistingRecord} />
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
