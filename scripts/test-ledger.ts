// 逻辑测试：账本重放、幂等、冲突、迁移、容量拒绝
import { appendOp, changesSince, migrateOldStateToOps, replayLedger, type LedgerOp } from '../src/ledger';
import type { PersistedState } from '../src/types';

// ---- shim localStorage（Node 20 已自带 globalThis.crypto）----
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); }
};

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}`); }
}

function makeOp(partial: Partial<LedgerOp> & { type: LedgerOp['type']; lessonId: string }): LedgerOp {
  return {
    opId: `op-${Math.random().toString(36).slice(2)}`,
    seq: 0,
    source: 'tab-a',
    baseVersion: 0,
    createdAt: new Date().toISOString(),
    ...partial
  } as LedgerOp;
}

function append(op: LedgerOp): LedgerOp[] {
  const r = appendOp(op);
  if (!r.ok && r.reason !== 'duplicate') throw new Error(`append failed: ${r.reason}`);
  return r.ops;
}

console.log('— 重放与合并 —');
{
  append(makeOp({ type: 'progress', lessonId: 'L1', progress: { answers: { s1: 'hello' }, activeSentenceId: 's1' } }));
  append(makeOp({ type: 'progress', lessonId: 'L1', progress: { answers: { s2: 'world' }, activeSentenceId: 's2' } }));
  const merged = replayLedger(append(makeOp({ type: 'progress', lessonId: 'L1', progress: { answers: {}, activeSentenceId: 's2' } })));
  check('进度按句合并（两处作答都保留）', merged.progress['L1'].answers.s1 === 'hello' && merged.progress['L1'].answers.s2 === 'world');
  check('课节版本为最大 seq', merged.versions['L1'] === 3);
}

console.log('— 幂等：重复 opId 只生效一次 —');
{
  const op = makeOp({ type: 'feedback', lessonId: 'L1', feedback: { attemptId: 'a1', teacherFeedback: 'good' } });
  append(op);
  const r2 = appendOp(op); // 同 opId 再写一次
  check('第二次写入返回 duplicate', r2.ok === false && r2.reason === 'duplicate');
  check('账本只有一条', r2.ops.filter((o) => o.opId === op.opId).length === 1);
}

console.log('— 提交 + 反馈 + 分类 合并 —');
{
  const attempt = {
    id: 'a1', lessonId: 'L1', lessonTitle: '课', courseTitle: '程',
    submittedAt: new Date().toISOString(), score: 90, teacherFeedback: '',
    sentenceAttempts: [{ sentenceId: 's1', source: 'a b', answer: 'a', score: 50, tokens: [{ index: 0, expected: 'a', actual: 'a', correct: true, category: 'unclassified' as const, reason: '' }] }]
  };
  append(makeOp({ type: 'attempt', lessonId: 'L1', attempt }));
  append(makeOp({ type: 'feedback', lessonId: 'L1', feedback: { attemptId: 'a1', teacherFeedback: '注意拼写' } }));
  append(makeOp({ type: 'classification', lessonId: 'L1', classification: { attemptId: 'a1', sentenceId: 's1', tokenIndex: 0, category: 'spelling', reason: '漏听' } }));
  const merged = replayLedger(append(makeOp({ type: 'progress', lessonId: 'L1', progress: { answers: {}, activeSentenceId: 's1' } })));
  check('记录存在', merged.attempts.some((a) => a.id === 'a1'));
  check('反馈已合并', merged.attempts.find((a) => a.id === 'a1')!.teacherFeedback === '注意拼写');
  check('分类已合并', merged.attempts.find((a) => a.id === 'a1')!.sentenceAttempts[0].tokens[0].category === 'spelling');
}

console.log('— 冲突检测：列出别处改动 —');
{
  const p = makeOp({ type: 'progress', lessonId: 'L2', progress: { answers: { s1: 'x' }, activeSentenceId: 's1' } });
  const a = makeOp({ type: 'attempt', lessonId: 'L2', attempt: { id: 'a2', lessonId: 'L2', lessonTitle: '', courseTitle: '', submittedAt: '', score: 0, teacherFeedback: '', sentenceAttempts: [] } });
  const pr = appendOp(p);
  const ar = appendOp(a);
  const pSeq = pr.op!.seq;
  const aSeq = ar.op!.seq;
  const ops = append(makeOp({ type: 'progress', lessonId: 'L2', progress: { answers: {}, activeSentenceId: 's1' } }));
  const changes = changesSince(ops, 'L2', pSeq);
  check('检测到 1 处改动（提交）', changes.length === 1 && changes[0].kind === 'attempt');
  const changes0 = changesSince(ops, 'L2', pSeq - 1);
  check('从版本 0 起列出全部改动', changes0.length >= 2 && changes0.some((c) => c.kind === 'progress') && changes0.some((c) => c.kind === 'attempt'));
  check('seq 严格递增', pSeq < aSeq);
}

console.log('— 容量不足：拒绝写入且不破坏原记录 —');
{
  const p = makeOp({ type: 'progress', lessonId: 'L3', progress: { answers: { s1: 'keep' }, activeSentenceId: 's1' } });
  append(p);
  const orig = (globalThis as any).localStorage.setItem;
  (globalThis as any).localStorage.setItem = () => { const e = new DOMException('quota', 'QuotaExceededError'); throw e; };
  const q = makeOp({ type: 'progress', lessonId: 'L3', progress: { answers: { s1: 'new' }, activeSentenceId: 's1' } });
  const r = appendOp(q);
  (globalThis as any).localStorage.setItem = orig;
  check('写入被拒绝', r.ok === false && r.reason === 'quota');
  check('原记录保留（未追加）', r.ops.filter((o) => o.lessonId === 'L3').length === 1 && r.ops.find((o) => o.lessonId === 'L3')!.progress!.answers.s1 === 'keep');
}

console.log('— 旧数据迁移 —');
{
  const old: PersistedState = {
    schemaVersion: 1,
    courses: [],
    attempts: [{
      id: 'a1', lessonId: 'L4', lessonTitle: '课', courseTitle: '程',
      submittedAt: '2026-09-24T10:20:00.000Z', score: 84, teacherFeedback: '反馈',
      sentenceAttempts: [{ sentenceId: 's1', source: 'a b', answer: 'a', score: 50, tokens: [{ index: 0, expected: 'a', actual: 'a', correct: true, category: 'spelling' as const, reason: 'x' }] }]
    }],
    progress: { L4: { answers: { s1: 'a' }, activeSentenceId: 's1', updatedAt: '2026-09-24T10:10:00.000Z' } },
    activeLessonId: '', activeSentenceId: '', theme: 'light', fontScale: 1, role: 'learner'
  };
  const ops = migrateOldStateToOps(old);
  const merged = replayLedger(ops);
  check('迁移后进度存在', merged.progress['L4'].answers.s1 === 'a');
  check('迁移后记录存在', merged.attempts.length === 1);
  check('迁移后反馈存在', merged.attempts[0].teacherFeedback === '反馈');
  check('迁移后分类存在', merged.attempts[0].sentenceAttempts[0].tokens[0].category === 'spelling');
  check('迁移操作来源标记为 migration', ops.every((o) => o.source === 'migration'));
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
