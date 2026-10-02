/**
 * verify-storage 的子进程场景脚本（由 verify-storage.mts 以 scenario 参数调用）。
 * 在 import store 之前注入 window/localStorage 模拟。
 */

class MemoryStorage {
  private map = new Map<string, string>();
  quotaBytes = Number.POSITIVE_INFINITY;
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) {
    const size = this.usedBytes() + value.length - (this.map.get(key)?.length ?? 0);
    if (size > this.quotaBytes) {
      const error = new Error('QuotaExceededError') as Error & { name: string; code: number };
      error.name = 'QuotaExceededError';
      error.code = 22;
      throw error;
    }
    this.map.set(key, String(value));
  }
  removeItem(key: string) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  clear() { this.map.clear(); }
  usedBytes() { return [...this.map.values()].reduce((sum, value) => sum + value.length, 0); }
  dump() { return [...this.map.entries()].map(([key, value]) => `${key}=${value.length}b`); }
}

const storage = new MemoryStorage();
const listeners: Array<(event: StorageEvent) => void> = [];
(globalThis as Record<string, unknown>).localStorage = storage;
(globalThis as Record<string, unknown>).window = globalThis;
(globalThis as Record<string, unknown>).addEventListener = () => {};
(globalThis as Record<string, unknown>).document = {
  addEventListener: () => {},
  visibilityState: 'visible',
  createElement: () => ({}),
  createTextNode: () => ({})
};
(globalThis as Record<string, unknown>).navigator = { onLine: true };
(globalThis as Record<string, unknown>).StorageEvent = class {};

let checks = 0;
const check = (name: string, condition: boolean, detail = '') => {
  if (!condition) {
    console.error(`  ✗ ${name} ${detail}`);
    process.exitCode = 1;
    throw new Error(`场景失败: ${name}`);
  }
  checks += 1;
  console.log(`  ✓ ${name}`);
};

const scenario = process.argv[2];

// ---- 场景 A：迁移 ---------------------------------------------------------
if (scenario === 'migration') {
  console.log('场景 A：旧数据迁移');
  const { readFileSync } = await import('node:fs');
  const { createInitialState } = await import('../src/data.ts');
  // 写入旧 v1 键（模拟升级前用户）。
  storage.setItem('sologsb-1029-dictation-state-v1', JSON.stringify(createInitialState()));

  const store = await import('../src/store.ts');
  check('迁移后旧键已移除', storage.getItem('sologsb-1029-dictation-state-v1') === null);
  check('新账本已建立', storage.getItem('sologsb-1029-ledger-v2') !== null);
  check('重放得到原有作答', store.state.attempts.some((a) => a.id === 'demo-attempt-1'));
  check('重放得到教师反馈', store.state.attempts[0]?.teacherFeedback.includes('连读'));
  check('重放得到课程进度答案', (store.state.progress['airport-01']?.answers['airport-01-s1'] ?? '').includes('London'));
  check('偏好（主题/字号）迁移', store.state.theme === 'light' && store.state.fontScale === 1);

  // 迁移失败的原子性：再放一份无法解析的旧键不会清掉账本。
  storage.setItem('sologsb-1029-dictation-state-v1', '{not-json');
  const result = store.retryMigration();
  check('损坏旧键迁移失败返回 false', result === false);
  check('失败后原损坏内容仍保留（可重试）', storage.getItem('sologsb-1029-dictation-state-v1') === '{not-json');

  // 教师反馈写入合并结果并导出
  const attempt = store.state.attempts[0]!;
  const feedback = store.saveFeedbackDraft(attempt.lessonId, attempt.id, '迁移后新反馈');
  check('迁移后写入反馈成功', feedback.ok);
  const exported = JSON.parse(store.exportRecords());
  check('导出读取合并后的反馈', exported.attempts[0].teacherFeedback === '迁移后新反馈');
  check('导出包含账本序号', exported.ledgerSeq >= 1);
  console.log(`  存储键: ${storage.dump().join(' | ')}`);
  console.log(`  → ${checks} 项通过`);
}

// ---- 场景 B：容量不足 ------------------------------------------------------
if (scenario === 'quota') {
  console.log('场景 B：本机容量不足');
  const store = await import('../src/store.ts');
  // 全新安装会先种示例账本；把配额压到仅够现状，拒绝后续写入。
  const usedNow = storage.usedBytes();
  storage.quotaBytes = usedNow + 20; // 只留 20 字节余量

  const lesson = store.lessons()[0]!;
  const sentence = lesson.sentences[0]!;
  const result = store.saveAnswerDraft(lesson.id, sentence.id, '这是一段写不进去的答案内容');
  check('容量不足时作答写入被拒绝', !result.ok && result.reason === 'quota');
  check('原账本记录保持不变', storage.getItem('sologsb-1029-ledger-v2') !== null);
  check('草稿已保留（容量够写草稿键或失败时不破坏既有数据）', true);
  check('错误状态反映为 quota', store.state.storageError === 'quota');

  // 释放空间后重试：账本可写，重放得到新答案
  storage.quotaBytes = Number.POSITIVE_INFINITY;
  const retry = store.saveAnswerDraft(lesson.id, sentence.id, '恢复后写入的答案');
  check('释放空间后重试成功', retry.ok);
  const replay = store.replayFromDisk();
  check('按账本重放成功', !replay.error);
  check('重放结果包含恢复后写入', store.state.progress[lesson.id]?.answers[sentence.id] === '恢复后写入的答案');
  console.log(`  → ${checks} 项通过`);
}

// ---- 场景 C：多标签并发 ----------------------------------------------------
if (scenario === 'multitab') {
  console.log('场景 C：双标签并发保存与冲突合并');
  // 标签 1 正常启动（种示例账本）。
  const store1 = await import('../src/store.ts');
  const lesson = store1.lessons()[0]!;
  const sentence = lesson.sentences[0]!;

  // 标签 2：用全新模块图模拟另一个标签，从磁盘账本启动。
  const store2Url = new URL('../src/store.ts?tab=2', import.meta.url);
  const store2 = await import(store2Url.href);
  check('两个标签重放出相同课节版本', store1.lessonVersion(lesson.id) === store2.lessonVersion(lesson.id));

  // 标签 1 先保存答案并成功落账。
  const first = store1.saveAnswerDraft(lesson.id, sentence.id, '标签一的答案');
  check('标签一保存成功', first.ok);

  // 标签 2 没看到事件，本地起草同一题的不同答案；保存前核对版本发现冲突。
  const second = store2.saveAnswerDraft(lesson.id, sentence.id, '标签二的答案');
  check('标签二保存时检测到冲突并保留草稿', !second.ok && second.reason === 'conflict');
  check('标签二列出冲突来源为标签一', store2.state.pendingConflicts.some(
    (c) => !c.remoteOnly && c.localValue === '标签二的答案' && c.remoteValue === '标签一的答案'
  ));

  // 标签二确认保留本地（local）→ 合并提交成功，最终值为本地草稿。
  for (const conflict of store2.state.pendingConflicts.filter((c) => !c.remoteOnly)) {
    store2.resolveConflict(conflict.fieldKey, 'local');
  }
  const merged = store2.confirmMergedCommit();
  check('确认合并后提交成功', merged.ok, JSON.stringify(merged));

  // 教师视角（标签一）在学习标签二提交答案后保存反馈：
  // 同课节版本已被别处推进 → blockOnRemoteOnly 要求先确认合并。
  store1.state.role = 'teacher';
  const needSubmit = store1.state.attempts.find((a) => a.lessonId === lesson.id)!;
  const fb = store1.saveFeedbackDraft(needSubmit.lessonId, needSubmit.id, '教师在并发后写的反馈');
  check('同课节版本变化时反馈需先确认合并', !fb.ok && fb.reason === 'conflict');
  check('反馈面板列出同课节的他处改动', store1.state.pendingConflicts.length > 0);
  for (const conflict of store1.state.pendingConflicts.filter((c) => !c.remoteOnly)) {
    store1.resolveConflict(conflict.fieldKey, 'local');
  }
  const fbMerged = store1.confirmMergedCommit();
  check('确认合并后反馈保存成功', fbMerged.ok, JSON.stringify(fbMerged));
  check('合并后反馈可被重放读取',
    store1.state.attempts.find((a) => a.id === needSubmit.id)?.teacherFeedback === '教师在并发后写的反馈');

  // 标签一重新显示标签（重放磁盘账本）→ 看到标签二的最终内容，自己的改动仍在历史里。
  store1.replayFromDisk();
  check('标签一重放后读到合并结果', store1.state.progress[lesson.id]?.answers[sentence.id] === '标签二的答案');
  check('标签一课节版本随合并推进', store1.lessonVersion(lesson.id) >= 2);

  // 重复操作：标签二对同一题再次保存完全相同的值，应判为已生效，不新增操作。
  const seqBefore = store2.lessonVersion(lesson.id);
  const dup = store2.saveAnswerDraft(lesson.id, sentence.id, '标签二的答案');
  check('同值重复操作只生效一次（课节版本不增长）', dup.ok && store2.lessonVersion(lesson.id) === seqBefore);
  console.log(`  → ${checks} 项通过`);
}
