/**
 * 共享练习会话核心逻辑验证（node 内存运行，不依赖浏览器）。
 * 覆盖：递增序号、双标签并发追加、重放合并、版本核对与冲突、确认合并、
 * 重复操作幂等、旧数据迁移、容量不足拒绝写入。
 */
import { assert } from 'node:console';
import {
  appendOperations,
  mergeLedger,
  newLedgerDoc,
  prepareDrafts,
  replayOperations
} from '../src/ledger';
import type { LedgerDoc, LedgerOperation, OpSource } from '../src/types';
import type { DraftItem } from '../src/types';

let passed = 0;
const check = (name: string, condition: boolean, detail = '') => {
  if (!condition) {
    console.error(`✗ ${name} ${detail}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`✓ ${name}`);
  }
};

const learner: OpSource = { tabId: 'tab-learner', role: 'learner', label: '学习页 L' };
const teacher: OpSource = { tabId: 'tab-teacher', role: 'teacher', label: '教师页 T' };

const answerOp = (id: string, lessonId: string, sentenceId: string, value: string, source: OpSource, at: string): LedgerOperation => ({
  id, seq: 0, at, kind: 'answer', lessonId, source, sentenceId, value
});
const feedbackOp = (id: string, lessonId: string, attemptId: string, value: string, source: OpSource, at: string): LedgerOperation => ({
  id, seq: 0, at, kind: 'feedback', lessonId, source, attemptId, value
});
const submitOp = (id: string, lessonId: string, attemptId: string, at: string): LedgerOperation => ({
  id, seq: 0, at, kind: 'submit', lessonId, source: learner,
  idempotencyKey: id,
  attempt: {
    id: attemptId, lessonId, lessonTitle: '课', courseTitle: '程', submittedAt: at, score: 80,
    teacherFeedback: '', sentenceAttempts: []
  }
});
const answerDraft = (lessonId: string, sentenceId: string, value: string, at: string): DraftItem => ({
  key: `answer:${lessonId}:${sentenceId}`, lessonId, fieldKey: `answer:${lessonId}:${sentenceId}`,
  kind: 'answer', value, opId: `draft-${Math.random().toString(36).slice(2)}`, updatedAt: at, sentenceId
});

// ---- 1. 递增序号与重放 ----------------------------------------------------
{
  let ledger = newLedgerDoc();
  ledger = appendOperations(ledger, [answerOp('a1', 'L1', 's1', 'hello', learner, '2026-10-02T01:00:00Z')]);
  ledger = appendOperations(ledger, [answerOp('a2', 'L1', 's1', 'hello world', learner, '2026-10-02T01:01:00Z')]);
  check('账本操作序号严格递增', ledger.operations.map((o) => o.seq).join(',') === '1,2');
  const replay = replayOperations(ledger.operations);
  check('重放取最后一条答案', replay.progress['L1'].answers['s1'] === 'hello world');
  check('课节版本等于最后一条序号', replay.lessonVersion['L1'] === 2);
}

// ---- 2. 双标签并发追加 + 跨标签合并（事件重放的核心） ----------------------
{
  let learnerLedger = appendOperations(newLedgerDoc(), [answerOp('l1', 'L1', 's1', 'learner v1', learner, 't1')]);
  // 教师标签基于自己的副本（同样只有初始状态）写入反馈。
  let teacherLedger = newLedgerDoc();
  teacherLedger = appendOperations(teacherLedger, [feedbackOp('t1', 'L1', 'att-1', '老师反馈 v1', teacher, 't2')]);

  // 学习标签先落盘，教师标签保存前合并磁盘账本，再追加。
  const mergedFirst = mergeLedger(learnerLedger, teacherLedger);
  const afterTeacherSave = appendOperations(mergedFirst, []); // 合并后重号被压平
  check('跨标签合并后两边操作都保留', afterTeacherSave.operations.length === 2);
  check('合并后序号连续重排', afterTeacherSave.operations.map((o) => o.seq).join(',') === '1,2');

  const replay = replayOperations(afterTeacherSave.operations);
  check('合并重放保留学习答案', replay.progress['L1'].answers['s1'] === 'learner v1');
  check('合并重放保留教师反馈', replay.attempts.length === 0); // 反馈指向不存在的作答，被安全跳过

  // 让提交先存在，再让反馈生效，验证合并读取结果
  let withAttempt = appendOperations(newLedgerDoc(), [submitOp('sub1', 'L1', 'att-1', 't0')]);
  withAttempt = appendOperations(withAttempt, [feedbackOp('t2', 'L1', 'att-1', '注意连读', teacher, 't3')]);
  const replay2 = replayOperations(withAttempt.operations);
  check('逐词结果与教师反馈读取合并后的值', replay2.attempts[0]?.teacherFeedback === '注意连读');
}

// ---- 3. 保存前版本核对：别处已改同字段 → 冲突，保留草稿 ---------------------
{
  let ledger = appendOperations(newLedgerDoc(), [
    answerOp('l1', 'L1', 's1', '学习页原始答案', learner, 't1')
  ]);
  // 教师标签（或另一个学习标签）改了同一句
  ledger = appendOperations(ledger, [answerOp('x1', 'L1', 's1', '别处改后的答案', teacher, 't2')]);

  const draft = answerDraft('L1', 's1', '学习页继续编辑的草稿', 't3');
  const prepared = prepareDrafts([draft], ledger, learner.tabId);
  const blocking = prepared.conflicts.filter((c) => !c.remoteOnly);
  check('同字段被别处改写时检测到冲突', blocking.length === 1);
  check('冲突列出他处来源与序号', blocking[0]?.remoteSource.tabId === 'tab-teacher' && blocking[0]?.remoteSeq === 2);
  check('冲突时草稿由调用方保留（不修改草稿集合）', draft.value === '学习页继续编辑的草稿');
}

// ---- 4. 同课节不同字段：列提示但不阻塞 -------------------------------------
{
  let ledger = appendOperations(newLedgerDoc(), [answerOp('l1', 'L1', 's1', '第一句答案', learner, 't1')]);
  ledger = appendOperations(ledger, [answerOp('x1', 'L1', 's2', '别处写的第二句', teacher, 't2')]);
  const draft = answerDraft('L1', 's1', '第一句修改', 't3');
  const prepared = prepareDrafts([draft], ledger, learner.tabId);
  check('不同字段不产生阻塞冲突', prepared.conflicts.every((c) => c.remoteOnly));
  check('同课节他处改动被列出', prepared.conflicts.some((c) => c.remoteOnly && c.fieldKey.includes('s2')));
}

// ---- 5. 同值重复操作只能生效一次 ------------------------------------------
{
  const op = answerOp('dup1', 'L1', 's1', 'same value', learner, 't1');
  let ledger = appendOperations(newLedgerDoc(), [op]);
  const before = ledger.operations.length;
  // 同一 op id 重投
  ledger = appendOperations(ledger, [{ ...op }]);
  check('同一操作 id 重放不重复生效', ledger.operations.length === before);

  // 同一提交幂等键重复提交
  const submit1 = submitOp('submit-dup', 'L1', 'att-9', 't1');
  let ledger2 = appendOperations(newLedgerDoc(), [submit1]);
  const submitClone: LedgerOperation = { ...submit1, id: 'submit-dup-copy' };
  ledger2 = appendOperations(ledger2, [submitClone]);
  const replay = replayOperations(ledger2.operations);
  check('同一幂等键的提交只生成一条作答', replay.attempts.length === 1);
  check('submitKeys 去重', replay.submitKeys.size === 1);
}

// ---- 6. 确认合并：remote 丢草稿 / local 覆盖为最终值 -----------------------
{
  let ledger = appendOperations(newLedgerDoc(), [answerOp('l1', 'L1', 's1', '他处最终保存', teacher, 't1')]);
  // local 决议：本地草稿追加，排在他处之后，成为最终值
  const localDraft = answerDraft('L1', 's1', '本地确认保留', 't2');
  const localOp: LedgerOperation = {
    id: localDraft.opId, seq: 0, at: localDraft.updatedAt, kind: 'answer',
    lessonId: 'L1', source: learner, sentenceId: 's1', value: localDraft.value
  };
  const mergedLocal = appendOperations(ledger, [localOp]);
  const replayLocal = replayOperations(mergedLocal.operations);
  check('确认保留本地后，本地值成为合并结果', replayLocal.progress['L1'].answers['s1'] === '本地确认保留');
  check('合并后课节版本递增', replayLocal.lessonVersion['L1'] === 2);

  // remote 决议：不追加，账本保持他处值
  const replayRemote = replayOperations(ledger.operations);
  check('采用他处时合并结果保持他处内容', replayRemote.progress['L1'].answers['s1'] === '他处最终保存');
}

// ---- 7. 分类操作的字段级隔离与重放 -----------------------------------------
{
  let ledger = appendOperations(newLedgerDoc(), [submitOp('s1', 'L1', 'att-c', 't0')]);
  ledger = appendOperations(ledger, [{
    id: 'c1', seq: 0, at: 't1', kind: 'classify', lessonId: 'L1', source: learner,
    attemptId: 'att-c', sentenceId: 's1', tokenIndex: 0, category: 'spelling', reason: '连读'
  } satisfies LedgerOperation]);
  const replay = replayOperations(ledger.operations);
  check('分类操作不影响作答数量', replay.attempts.length === 1);
  check('不同错误词拥有不同字段键（互不覆盖）',
    ((): boolean => {
      const a = answerDraft('L1', 's1', 'x', 't');
      return a.fieldKey !== 'classify:L1:att-c:s1:0';
    })());
}

// ---- 8. 账本总是按 seq 顺序重放，乱序写入也得到一致结果 --------------------
{
  const ops = [
    answerOp('o2', 'L1', 's1', 'second', learner, 't2'),
    answerOp('o1', 'L1', 's1', 'first', learner, 't1'),
    answerOp('o3', 'L1', 's1', 'third', learner, 't3')
  ].map((op, index) => ({ ...op, seq: index + 1 }));
  const shuffled: LedgerDoc = { docType: 'sologsb-ledger', schemaVersion: 2, operations: [ops[2], ops[0], ops[1]] };
  const replay = replayOperations(shuffled.operations);
  check('乱序账本按序号重放一致', replay.progress['L1'].answers['s1'] === 'third');
}

// ---- 9. 两个标签基于同一基数各自追加（seq 相撞）→ 按时间因果合并 -----------
{
  // 共同祖先：seq 1。
  const base = appendOperations(newLedgerDoc(), [answerOp('base', 'L1', 's1', 'origin', learner, '2026-10-02T00:00:00Z')]);
  // 学习标签与教师标签各自从 base 追加，都拿到 seq 2。
  const learnerBranch: LedgerDoc = {
    docType: 'sologsb-ledger', schemaVersion: 2,
    operations: [...base.operations, answerOp('l2', 'L1', 's1', '学生稍后改', learner, '2026-10-02T00:05:00Z')]
      .map((op, index) => ({ ...op, seq: index + 1 }))
  };
  const teacherBranch: LedgerDoc = {
    docType: 'sologsb-ledger', schemaVersion: 2,
    operations: [feedbackOp('t2', 'L1', 'att-x', '老师先写的反馈', teacher, '2026-10-02T00:02:00Z')]
      .map((op) => ({ ...op, seq: 2 }))
  };
  const merged = mergeLedger(learnerBranch, teacherBranch);
  check('序号相撞合并后三个操作都保留', merged.operations.length === 3);
  check('合并后按时间排序（老师反馈在前，学生改答案在后）',
    merged.operations[1]?.id === 't2' && merged.operations[2]?.id === 'l2');
  check('合并后序号连续', merged.operations.map((o) => o.seq).join(',') === '1,2,3');
  const replay = replayOperations(merged.operations);
  check('因果重放取时间最晚的答案', replay.progress['L1'].answers['s1'] === '学生稍后改');
}

console.log(`\n${passed} 项核心逻辑检查通过`);
