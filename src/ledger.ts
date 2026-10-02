import type {
  ConflictEntry,
  DraftItem,
  LedgerDoc,
  LedgerOperation,
  OperationKind,
  PracticeAttempt,
  ReconciledState
} from './types';

export const LEDGER_KEY = 'sologsb-1029-ledger-v2';

let opCounter = 0;

/** 操作 id：标签内单调，时间戳后缀降低跨标签碰撞概率。 */
export function makeOpId(tabId: string): string {
  opCounter += 1;
  return `${tabId}-${Date.now().toString(36)}-${opCounter.toString(36)}`;
}

export function newLedgerDoc(): LedgerDoc {
  return { docType: 'sologsb-ledger', schemaVersion: 2, operations: [] };
}

export function isLedgerDoc(value: unknown): value is LedgerDoc {
  return !!value && typeof value === 'object'
    && (value as LedgerDoc).docType === 'sologsb-ledger'
    && Array.isArray((value as LedgerDoc).operations);
}

/**
 * 重放归约：把账本操作按 seq 顺序折叠成「课程进度 / 作答记录 / 课节版本」。
 * 纯函数，迁移、启动、断网恢复都走同一条路径。
 */
export function replayOperations(operations: LedgerOperation[]): ReconciledState {
  const sorted = [...operations].sort((a, b) => a.seq - b.seq);
  const state: ReconciledState = {
    progress: {},
    attempts: [],
    lessonVersion: {},
    fieldLast: {},
    submitKeys: new Set<string>()
  };
  const attemptsById = new Map<string, PracticeAttempt>();

  for (const op of sorted) {
    state.lessonVersion[op.lessonId] = op.seq;
    state.fieldLast[fieldKeyOf(op)] = op;

    switch (op.kind) {
      case 'answer': {
        const progress = state.progress[op.lessonId]
          ?? (state.progress[op.lessonId] = { answers: {}, activeSentenceId: '', updatedAt: op.at });
        if (op.sentenceId !== undefined) progress.answers[op.sentenceId] = op.value ?? '';
        progress.activeSentenceId = op.sentenceId ?? progress.activeSentenceId;
        progress.updatedAt = op.at;
        break;
      }
      case 'submit': {
        if (!op.attempt || !op.idempotencyKey) break;
        // 重复的提交操作（同一幂等键）只能生效一次。
        if (state.submitKeys.has(op.idempotencyKey)) break;
        state.submitKeys.add(op.idempotencyKey);
        if (!attemptsById.has(op.attempt.id)) {
          attemptsById.set(op.attempt.id, op.attempt);
          state.attempts.push(op.attempt);
        }
        break;
      }
      case 'feedback': {
        const attempt = attemptsById.get(op.attemptId ?? '')
          ?? state.attempts.find((item) => item.id === op.attemptId);
        if (attempt) {
          attempt.teacherFeedback = op.value ?? '';
          attemptsById.set(attempt.id, attempt);
        }
        break;
      }
      case 'classify': {
        const attempt = attemptsById.get(op.attemptId ?? '')
          ?? state.attempts.find((item) => item.id === op.attemptId);
        if (attempt && op.sentenceId !== undefined && op.tokenIndex !== undefined) {
          const sentence = attempt.sentenceAttempts.find((item) => item.sentenceId === op.sentenceId);
          const token = sentence?.tokens.find((item) => item.index === op.tokenIndex);
          if (token) {
            if (op.category) token.category = op.category;
            token.reason = op.reason ?? '';
          }
        }
        break;
      }
    }
  }

  state.attempts.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return state;
}

/** 字段键：同课节下，不同句子 / 不同作答 / 不同词的改动互不冲突。 */
export function fieldKeyOf(op: { kind: OperationKind; lessonId: string; sentenceId?: string; attemptId?: string; tokenIndex?: number }): string {
  switch (op.kind) {
    case 'answer':
      return `answer:${op.lessonId}:${op.sentenceId ?? ''}`;
    case 'submit':
      return `submit:${op.lessonId}`;
    case 'feedback':
      return `feedback:${op.lessonId}:${op.attemptId ?? ''}`;
    case 'classify':
      return `classify:${op.lessonId}:${op.attemptId ?? ''}:${op.sentenceId ?? ''}:${op.tokenIndex ?? ''}`;
  }
}

export interface PrepareResult {
  conflicts: ConflictEntry[];
  /** 草稿里课节的版本基线（该课节最后一条已见操作）。 */
  hasRemoteOnlyChange: boolean;
}

/**
 * 保存前核对同一课节版本：以重放后的账本为准，逐条对比本标签待提交草稿。
 * - 同字段被别处（其它 tabId / 角色）改写 → 冲突，保留草稿等待人工合并。
 * - 同课节其它字段被改 → remoteOnly 提示，不阻塞。
 */
export function prepareDrafts(
  drafts: DraftItem[],
  ledger: LedgerDoc,
  ownTabId: string,
  locallyResolvedKeys: Iterable<string> = []
): PrepareResult {
  const locallyResolved = new Set(locallyResolvedKeys);
  const replayed = replayOperations(ledger.operations);
  const conflicts: ConflictEntry[] = [];
  const touchedLessons = new Set(drafts.map((draft) => draft.lessonId));
  let hasRemoteOnlyChange = false;

  for (const draft of drafts) {
    const key = draft.fieldKey;
    const remoteOp = replayed.fieldLast[key];
    if (!remoteOp) continue;
    // 系统来源（旧数据迁移、自动修复）不是别的标签的并发编辑，不构成冲突。
    if (remoteOp.source.system) continue;
    // 用户已在冲突面板选择「保留本地」：按确认结果直接追加。
    if (locallyResolved.has(key)) continue;

    const sameTab = remoteOp.source.tabId === ownTabId;
    const remoteValue = opDisplayValue(remoteOp);
    const valuesDiffer = remoteValue !== draft.value;

    if (!sameTab && valuesDiffer) {
      conflicts.push({
        lessonId: draft.lessonId,
        fieldKey: key,
        kind: draft.kind,
        sentenceId: draft.sentenceId,
        attemptId: draft.attemptId,
        localValue: draft.value,
        remoteValue,
        localAt: draft.updatedAt,
        remoteAt: remoteOp.at,
        remoteSource: remoteOp.source,
        remoteSeq: remoteOp.seq,
        resolution: 'remote',
        decided: false,
        remoteOnly: false
      });
    }
  }

  // 同课节但不同字段的他处改动：列出供确认，不构成字段冲突。
  for (const lessonId of touchedLessons) {
    const lessonTouchedKeys = new Set(drafts.filter((d) => d.lessonId === lessonId).map((d) => d.fieldKey));
    for (const [key, op] of Object.entries(replayed.fieldLast)) {
      if (op.lessonId !== lessonId || op.source.tabId === ownTabId || op.source.system
        || lessonTouchedKeys.has(key) || locallyResolved.has(key)) continue;
      hasRemoteOnlyChange = true;
      conflicts.push({
        lessonId,
        fieldKey: key,
        kind: op.kind,
        sentenceId: op.sentenceId,
        attemptId: op.attemptId,
        localValue: '',
        remoteValue: opDisplayValue(op),
        localAt: '',
        remoteAt: op.at,
        remoteSource: op.source,
        remoteSeq: op.seq,
        resolution: 'remote',
        decided: false,
        remoteOnly: true
      });
    }
  }

  return { conflicts, hasRemoteOnlyChange };
}

/** 冲突项里用于展示/比较的「他处的值」。 */
export function opDisplayValue(op: LedgerOperation): string {
  if (op.kind === 'classify') return [op.category ?? '', op.reason ?? ''].join('|');
  return op.value ?? '';
}

export function describeField(entry: { kind: OperationKind; fieldKey: string }): string {
  if (entry.kind === 'answer') return '学生答案';
  if (entry.kind === 'submit') return '整课提交';
  if (entry.kind === 'feedback') return '教师反馈';
  const parts = entry.fieldKey.split(':');
  return `错误分类（第 ${Number(parts[3] ?? 0) + 1} 词）`;
}

/**
 * 向账本追加一组操作并重新编号，返回新账本。幂等键 / 操作 id 去重，
 * 保证同一个操作（含重复点击、重放重投）只能生效一次。
 */
export function appendOperations(ledger: LedgerDoc, operations: LedgerOperation[]): LedgerDoc {
  const existingIds = new Set(ledger.operations.map((op) => op.id));
  const existingSubmitKeys = new Set(
    ledger.operations
      .filter((op) => op.kind === 'submit' && op.idempotencyKey)
      .map((op) => op.idempotencyKey)
  );

  let nextSeq = ledger.operations.reduce((max, op) => Math.max(max, op.seq), 0);
  const merged = [...ledger.operations];

  for (const op of operations) {
    if (existingIds.has(op.id)) continue;
    if (op.kind === 'submit' && op.idempotencyKey && existingSubmitKeys.has(op.idempotencyKey)) continue;
    nextSeq += 1;
    const assigned: LedgerOperation = { ...op, seq: nextSeq };
    merged.push(assigned);
    existingIds.add(assigned.id);
    if (assigned.kind === 'submit' && assigned.idempotencyKey) existingSubmitKeys.add(assigned.idempotencyKey);
  }

  return { ...ledger, operations: merged };
}

/**
 * 跨标签同步：把外部读到的账本与本地账本合并（按 op id 去重、重排序号）。
 * 两个标签可能基于同一序号基数各自追加，seq 会相撞；因此先按操作时间
 * （同标签内时间与 seq 一致）再按 id 稳定排序，把 seq 压成连续序列。
 */
export function mergeLedger(local: LedgerDoc, remote: LedgerDoc): LedgerDoc {
  const byId = new Map<string, LedgerOperation>();
  for (const op of local.operations) byId.set(op.id, op);
  for (const op of remote.operations) {
    const held = byId.get(op.id);
    // 同一操作 id 以 seq 较大、内容较新的为准；不同 id 都保留。
    if (!held || op.seq > held.seq) byId.set(op.id, op);
  }
  const operations = [...byId.values()]
    .sort((a, b) => (a.at.localeCompare(b.at) || a.id.localeCompare(b.id)))
    .map((op, index) => ({ ...op, seq: index + 1 }));
  return { docType: 'sologsb-ledger', schemaVersion: 2, operations };
}
