// 集成冒烟测试：在 Node 中模拟浏览器全局，驱动 store 完整流程
// （Node 20 已自带 globalThis.crypto）

// ---- shim 浏览器全局 ----
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => { mem.clear(); }
};
(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
};

const {
  initStore, state, getDisplayProgress, updateAnswer, flushProgress,
  submitAttempt, saveFeedback, saveClassification, syncFromLedger,
  pendingConflicts, confirmMerge, lessonVersions, markLessonKnown
} = await import('../src/store');
const { compareSentence, scoreAttempt } = await import('../src/utils');

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log('— 初始化（首次：迁移 demo 数据）—');
const r = initStore();
check('initStore 返回 ok', r.ok === true);
check('课程已加载', state.courses.length === 2);
check('demo 记录已迁移', state.attempts.length === 1);
check('demo 进度已迁移', !!state.progress['airport-01']);
check('课节版本 > 0', (lessonVersions['airport-01'] ?? 0) > 0);

console.log('— 作答与草稿 —');
markLessonKnown('airport-01');
updateAnswer('airport-01', 'airport-01-s1', 'I would like to check in for my flight to London');
flushProgress('airport-01');
const dp = getDisplayProgress('airport-01');
check('草稿答案已合并展示', dp.answers['airport-01-s1'] === 'I would like to check in for my flight to London');

console.log('— 整课提交 —');
const lesson = state.courses[0].lessons[0];
const sentenceAttempts = lesson.sentences.map((s) => {
  const answer = getDisplayProgress(lesson.id).answers[s.id] ?? '';
  const tokens = compareSentence(s.text, answer);
  return { sentenceId: s.id, source: s.text, answer, tokens, score: tokens.length ? Math.round((tokens.filter(t => t.correct).length / tokens.length) * 100) : 0 };
});
const sid = submitAttempt(lesson.id, lesson.title, state.courses[0].title, sentenceAttempts, scoreAttempt(sentenceAttempts));
check('提交返回记录 id', typeof sid === 'string' && sid!.length > 0);
check('记录数增加', state.attempts.length === 2);

console.log('— 教师反馈 —');
const fbOk = saveFeedback(sid!, '连读进步明显，注意词尾衔接。');
check('反馈保存成功', fbOk === true);
check('反馈已回显', state.attempts.find(a => a.id === sid)?.teacherFeedback === '连读进步明显，注意词尾衔接。');

console.log('— 逐词分类 —');
const token = state.attempts.find(a => a.id === sid)!.sentenceAttempts[0].tokens.find(t => !t.correct);
if (token) {
  const cOk = saveClassification(sid!, lesson.sentences[0].id, token.index, 'spelling', '词尾未听清');
  check('分类保存成功', cOk === true);
} else {
  check('分类保存成功（全对，跳过）', true);
}

console.log('— 跨标签页冲突模拟 —');
// 模拟另一个标签页：直接写一条反馈 op 到账本（绕过本标签页的 knownVersions）
const { loadLedger, appendOp: appendLedgerOp } = await import('../src/ledger');
const otherOp = {
  opId: `tab-other-${Date.now()}`,
  seq: 0,
  source: 'tab-other',
  type: 'feedback' as const,
  lessonId: 'airport-01',
  baseVersion: lessonVersions['airport-01'],
  createdAt: new Date().toISOString(),
  feedback: { attemptId: sid!, teacherFeedback: '其他标签页写入的反馈' }
};
appendLedgerOp(otherOp);
// 本标签页尝试保存反馈 → 应检测到冲突
const conflictOk = saveFeedback(sid!, '本标签页的反馈');
check('保存被冲突拦截', conflictOk === false);
check('冲突已列出', pendingConflicts.length === 1 && pendingConflicts[0].changes.some(c => c.kind === 'feedback'));
// 确认合并
const merged = confirmMerge(pendingConflicts[0]);
check('确认合并成功', merged === true);
check('冲突已清除', pendingConflicts.length === 0);
check('本标签页反馈已写入', state.attempts.find(a => a.id === sid)?.teacherFeedback === '本标签页的反馈');

console.log('— 并发追加不丢失更新 —');
const before = loadLedger().length;
const r1 = appendLedgerOp({ opId: `concurrent-a-${Date.now()}`, seq: 0, source: 'a', type: 'progress', lessonId: 'airport-01', baseVersion: 0, createdAt: new Date().toISOString(), progress: { answers: { sx: 'a' }, activeSentenceId: 'sx' } });
const r2 = appendLedgerOp({ opId: `concurrent-b-${Date.now()}`, seq: 0, source: 'b', type: 'progress', lessonId: 'airport-01', baseVersion: 0, createdAt: new Date().toISOString(), progress: { answers: { sy: 'b' }, activeSentenceId: 'sy' } });
const after = loadLedger().length;
check('两次追加都成功', r1.ok && r2.ok);
check('账本包含两条新操作（无丢失）', after === before + 2);
check('seq 递增', r1.op!.seq < r2.op!.seq);

console.log('— 重放恢复 —');
syncFromLedger();
check('重放后记录仍在', state.attempts.length === 2);
check('重放后反馈仍在', state.attempts.find(a => a.id === sid)?.teacherFeedback === '本标签页的反馈');

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
