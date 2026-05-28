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
  gradingStrictness: 'standard',
  answerInputSource: 'canvas',
  uploadedAnswerImageDataUrl: '',
  uploadedAnswerFileName: '',
  uploadedAnswerMimeType: '',
  uploadedAnswerImportedAt: '',
  recognizedQuestionDraft: '',
  recognizedAnswerDraft: '',
  recognizedLatexDraft: '',
  userCorrectedQuestion: '',
  userCorrectedAnswer: '',
  userCorrectedLatex: '',
  annotations: [],
  mistakeCategories: [],
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

function normalizeRecord(record) {
  return {
    ...emptyDraft(),
    ...record,
    gradingStrictness: record.gradingStrictness || 'standard',
    answerInputSource: record.answerInputSource || 'canvas',
    annotations: record.annotations || record.gradingResult?.annotations || [],
    mistakeCategories: record.mistakeCategories || record.gradingResult?.mistakeCategories || [],
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
        採点の厳しさ
        <select
          value={draft.gradingStrictness}
          onChange={(event) => updateDraft({ gradingStrictness: event.target.value })}
        >
          <option value="lenient">甘め</option>
          <option value="standard">標準</option>
          <option value="strict">厳しめ</option>
        </select>
      </label>

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

function AnswerPanel({ draft, setDraft, updateDraft, tool, setTool, penSize, setPenSize, eraserSize, setEraserSize, canvasHostRef }) {
  const answerFileInputRef = useRef(null);

  const importAnswerImage = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('対応していない画像形式です。');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      updateDraft({
        answerInputSource: 'uploadedImage',
        uploadedAnswerImageDataUrl: reader.result,
        uploadedAnswerFileName: file.name,
        uploadedAnswerMimeType: file.type,
        uploadedAnswerImportedAt: new Date().toISOString(),
      });
    };
    reader.onerror = () => alert('画像を読み込めませんでした。');
    reader.readAsDataURL(file);
    event.target.value = '';
  };

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
      <div className="answer-source-row" aria-label="答案入力方法">
        <button
          className={draft.answerInputSource === 'canvas' ? 'active-source' : ''}
          type="button"
          onClick={() => updateDraft({ answerInputSource: 'canvas' })}
        >
          手書き
        </button>
        <button
          className={draft.answerInputSource === 'uploadedImage' ? 'active-source' : ''}
          type="button"
          onClick={() => answerFileInputRef.current?.click()}
        >
          画像
        </button>
        <input ref={answerFileInputRef} type="file" accept="image/*" onChange={importAnswerImage} hidden />
        {draft.uploadedAnswerImageDataUrl && (
          <button
            className="delete-button"
            type="button"
            onClick={() =>
              updateDraft({
                answerInputSource: 'canvas',
                uploadedAnswerImageDataUrl: '',
                uploadedAnswerFileName: '',
                uploadedAnswerMimeType: '',
                uploadedAnswerImportedAt: '',
              })
            }
          >
            画像削除
          </button>
        )}
      </div>
      {draft.answerInputSource === 'uploadedImage' ? (
        <figure className="answer-image-preview">
          {draft.uploadedAnswerImageDataUrl ? (
            <>
              <img src={draft.uploadedAnswerImageDataUrl} alt="取り込んだ答案" />
              <figcaption>{draft.uploadedAnswerFileName || '答案画像'}</figcaption>
            </>
          ) : (
            <button type="button" onClick={() => answerFileInputRef.current?.click()}>
              答案画像を選択
            </button>
          )}
        </figure>
      ) : (
        <>
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
        </>
      )}
    </section>
  );
}

function RecognitionPanel({ draft, updateDraft, onRecognize, onGradeCorrected, status }) {
  return (
    <section className="panel recognition-panel">
      <div className="panel-heading">
        <h2>認識結果</h2>
      </div>
      {status && <p className="status-message">{status}</p>}
      <div className="review-actions">
        <button type="button" onClick={onRecognize}>
          テキスト化
        </button>
        <button className="primary-button" type="button" onClick={onGradeCorrected}>
          この内容で採点
        </button>
        <button
          type="button"
          disabled={!draft.recognizedQuestionDraft && !draft.recognizedAnswerDraft && !draft.recognizedLatexDraft}
          onClick={() =>
            updateDraft({
              userCorrectedQuestion: draft.recognizedQuestionDraft,
              userCorrectedAnswer: draft.recognizedAnswerDraft,
              userCorrectedLatex: draft.recognizedLatexDraft,
            })
          }
        >
          AI読取に戻す
        </button>
      </div>
      <label>
        読み取り問題
        <textarea
          value={draft.userCorrectedQuestion || draft.recognizedQuestionDraft}
          onChange={(event) => updateDraft({ userCorrectedQuestion: event.target.value })}
          placeholder="テキスト化すると、AIが読み取った問題が入ります"
        />
      </label>
      <label>
        読み取り答案
        <textarea
          value={draft.userCorrectedAnswer || draft.recognizedAnswerDraft}
          onChange={(event) => updateDraft({ userCorrectedAnswer: event.target.value })}
          placeholder="テキスト化すると、AIが読み取った答案が入ります"
        />
      </label>
      <label>
        読み取りLaTeX
        <textarea
          value={draft.userCorrectedLatex || draft.recognizedLatexDraft}
          onChange={(event) => updateDraft({ userCorrectedLatex: event.target.value })}
          placeholder="主要な数式のLaTeX"
        />
      </label>
      <FormulaPreview
        formula={draft.userCorrectedLatex || draft.recognizedLatexDraft}
        emptyText="読み取りLaTeXなし"
      />
    </section>
  );
}

function RedPenPanel({ answerImageDataUrl, annotations = [] }) {
  const positionedAnnotations = annotations.filter(
    (annotation) =>
      Number.isFinite(Number(annotation.x)) &&
      Number.isFinite(Number(annotation.y)) &&
      Number.isFinite(Number(annotation.width)) &&
      Number.isFinite(Number(annotation.height)),
  );

  return (
    <section className="panel redpen-panel">
      <div className="panel-heading">
        <h2>赤ペン</h2>
      </div>
      {!answerImageDataUrl ? (
        <div className="empty-result">答案画像があると赤ペン表示できます。</div>
      ) : (
        <div className="redpen-stage">
          <img src={answerImageDataUrl} alt="赤ペン表示対象の答案" />
          {positionedAnnotations.map((annotation, index) => (
            <span
              className={`redpen-mark ${annotation.type || 'mistake'}`}
              key={annotation.id || `${annotation.message || 'annotation'}-${index}`}
              style={{
                left: `${Number(annotation.x) * 100}%`,
                top: `${Number(annotation.y) * 100}%`,
                width: `${Number(annotation.width) * 100}%`,
                height: `${Number(annotation.height) * 100}%`,
              }}
              title={annotation.message || '注釈'}
            >
              <span>{annotation.message || '確認'}</span>
            </span>
          ))}
        </div>
      )}
      <section className="annotation-list">
        <h3>注釈一覧</h3>
        {annotations.length ? (
          <ul>
            {annotations.map((annotation, index) => (
              <li key={annotation.id || `${annotation.message || 'annotation-list'}-${index}`}>
                <strong>{annotation.type || 'note'}:</strong> {annotation.message || '注釈'}
              </li>
            ))}
          </ul>
        ) : (
          <p className="meta-text">採点後にAIの注釈が表示されます。</p>
        )}
      </section>
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
          {(result.expectedFinalAnswer || result.studentFinalAnswer || result.finalAnswerComparison?.length > 0) && (
            <section>
              <h3>最終解答の照合</h3>
              {result.expectedFinalAnswer && <p>模範: {result.expectedFinalAnswer}</p>}
              {result.studentFinalAnswer && <p>答案: {result.studentFinalAnswer}</p>}
              {result.finalAnswerComparison?.length > 0 && (
                <ul>
                  {result.finalAnswerComparison.map((item, index) => (
                    <li key={`${item.item || 'comparison'}-${index}`}>
                      {item.item ? `${item.item}: ` : ''}
                      {item.difference || `${item.expected || ''} / ${item.student || ''}`}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
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
          {result.mistakeCategories?.length > 0 && (
            <section>
              <h3>ミス分類</h3>
              <ul>{result.mistakeCategories.map((item) => <li key={item}>{item}</li>)}</ul>
            </section>
          )}
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

function MistakeInsights({ records }) {
  const categories = useMemo(() => {
    const counts = new Map();
    records.forEach((record) => {
      const items = record.mistakeCategories || record.gradingResult?.mistakeCategories || [];
      items.forEach((item) => counts.set(item, (counts.get(item) || 0) + 1));
    });
    return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6);
  }, [records]);

  return (
    <section className="history-section insights-section">
      <h2>ミス分析</h2>
      {categories.length ? (
        <div className="insight-list">
          {categories.map(([category, count]) => (
            <span className="insight-chip" key={category}>
              {category} <strong>{count}</strong>
            </span>
          ))}
        </div>
      ) : (
        <p className="meta-text">採点を重ねると、よく出るミス分類が表示されます。</p>
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
    const storedRecords = await getAllRecords();
    setRecords(storedRecords.map(normalizeRecord));
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

  const getCurrentAnswerImageDataUrl = () =>
    draft.answerInputSource === 'uploadedImage' ? draft.uploadedAnswerImageDataUrl : exportCanvasImage();

  const persistRecord = async (recordPatch = {}) => {
    const now = new Date().toISOString();
    const answerImageDataUrl = recordPatch.answerImageDataUrl || getCurrentAnswerImageDataUrl();
    const record = {
      ...draft,
      ...recordPatch,
      answerImageDataUrl,
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
    if (draft.answerInputSource === 'uploadedImage' && !draft.uploadedAnswerImageDataUrl) {
      return '答案画像を選択してください。';
    }
    if (draft.answerInputSource === 'canvas' && !draft.strokes.length) {
      return '答案を手書きしてください。';
    }
    const used = usage?.successfulRequests || 0;
    if (used >= dailyLimit && !confirm('残り目安が0回です。このまま採点しますか？')) {
      return '採点をキャンセルしました。';
    }
    return '';
  };

  const buildGradePayload = (mode, answerImageDataUrl) => ({
    mode,
    questionText: draft.questionText,
    questionImage: imageDataUrlToPayload(draft.questionImageDataUrl),
    modelAnswer: draft.modelAnswer,
    modelAnswerImage: imageDataUrlToPayload(draft.modelAnswerImageDataUrl),
    rubricText: draft.rubricText,
    maxScore: Number(draft.maxScore) || 10,
    answerImage: imageDataUrlToPayload(answerImageDataUrl),
    gradingStrictness: draft.gradingStrictness,
    correctedQuestion: draft.userCorrectedQuestion || draft.recognizedQuestionDraft,
    correctedAnswer: draft.userCorrectedAnswer || draft.recognizedAnswerDraft,
    correctedLatex: draft.userCorrectedLatex || draft.recognizedLatexDraft,
  });

  const requestGemini = async (payload) => {
    const response = await fetch('/api/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = await response.json();

    if (!response.ok) {
      if (response.status === 429) await incrementUsage('failedRequests');
      throw new Error(body.error || 'Gemini APIで処理に失敗しました。');
    }

    setRawText(body.rawText || '');
    await incrementUsage('successfulRequests');
    return body;
  };

  const applyRecognitionResult = (result) => {
    const patch = {
      recognizedQuestionDraft: result.recognizedQuestion || '',
      recognizedAnswerDraft: result.recognizedAnswer || '',
      recognizedLatexDraft: result.recognizedLatex || '',
      userCorrectedQuestion: result.recognizedQuestion || '',
      userCorrectedAnswer: result.recognizedAnswer || '',
      userCorrectedLatex: result.recognizedLatex || '',
    };
    updateDraft(patch);
    return patch;
  };

  const recognize = async () => {
    setRawText('');
    const validation = validateBeforeGrade();
    if (validation) {
      setStatus(validation);
      return;
    }

    setStatus('Geminiでテキスト化中です...');
    const answerImageDataUrl = getCurrentAnswerImageDataUrl();

    try {
      const body = await requestGemini(buildGradePayload('recognize', answerImageDataUrl));
      const recognitionPatch = applyRecognitionResult(body.result || {});
      await persistRecord({ ...recognitionPatch, answerImageDataUrl });
      setInputView('recognition');
      setStatus('テキスト化しました。必要なら修正して採点できます。');
    } catch (error) {
      setStatus(error.message);
    }
  };

  const grade = async () => {
    setRawText('');
    const validation = validateBeforeGrade();
    if (validation) {
      setStatus(validation);
      return;
    }

    setStatus('Geminiで採点中です...');
    const answerImageDataUrl = getCurrentAnswerImageDataUrl();

    try {
      const body = await requestGemini(buildGradePayload('full', answerImageDataUrl));
      const result = body.result || {};
      const recordPatch = {
        answerImageDataUrl,
        gradingResult: result,
        recognizedQuestionDraft: result.recognizedQuestion || '',
        recognizedAnswerDraft: result.recognizedAnswer || '',
        recognizedLatexDraft: result.recognizedLatex || '',
        userCorrectedQuestion: result.recognizedQuestion || '',
        userCorrectedAnswer: result.recognizedAnswer || '',
        userCorrectedLatex: result.recognizedLatex || '',
        annotations: result.annotations || [],
        mistakeCategories: result.mistakeCategories || [],
      };
      await persistRecord(recordPatch);
      setStatus('採点しました。');
    } catch (error) {
      setStatus(error.message);
    }
  };

  const gradeCorrected = async () => {
    setRawText('');
    const validation = validateBeforeGrade();
    if (validation) {
      setStatus(validation);
      return;
    }
    if (!draft.userCorrectedAnswer.trim() && !draft.recognizedAnswerDraft.trim()) {
      setStatus('先にテキスト化するか、読み取り答案を入力してください。');
      return;
    }

    setStatus('修正済みの読み取り内容で採点中です...');
    const answerImageDataUrl = getCurrentAnswerImageDataUrl();

    try {
      const body = await requestGemini(buildGradePayload('grade', answerImageDataUrl));
      const result = body.result || {};
      await persistRecord({
        answerImageDataUrl,
        gradingResult: result,
        annotations: result.annotations || [],
        mistakeCategories: result.mistakeCategories || [],
      });
      setStatus('修正内容で採点しました。');
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
          <button type="button" onClick={recognize}>
            テキスト化
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
            <button
              className={inputView === 'recognition' ? 'active-tab' : ''}
              type="button"
              onClick={() => setInputView('recognition')}
            >
              認識結果
            </button>
            <button
              className={inputView === 'redpen' ? 'active-tab' : ''}
              type="button"
              onClick={() => setInputView('redpen')}
            >
              赤ペン
            </button>
          </div>
          {inputView === 'question' ? (
            <QuestionPanel draft={draft} updateDraft={updateDraft} />
          ) : inputView === 'recognition' ? (
            <RecognitionPanel
              draft={draft}
              updateDraft={updateDraft}
              onRecognize={recognize}
              onGradeCorrected={gradeCorrected}
              status={status}
            />
          ) : inputView === 'redpen' ? (
            <RedPenPanel
              answerImageDataUrl={draft.answerImageDataUrl || getCurrentAnswerImageDataUrl()}
              annotations={draft.annotations || draft.gradingResult?.annotations || []}
            />
          ) : (
            <AnswerPanel
              draft={draft}
              setDraft={setDraft}
              updateDraft={updateDraft}
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

      <MistakeInsights records={records} />
      <HistoryList records={records} onLoad={(record) => setDraft(normalizeRecord(record))} onDelete={deleteExistingRecord} />
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
