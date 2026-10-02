import type { ConflictChange, LedgerFile, LedgerOp, MergedData, PersistedState } from './types';

export const LEDGER_KEY = 'sologsb-1029-dictation-ledger-v1';
export const OLD_STATE_KEY = 'sologsb-1029-dictation-state-v1';

export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isQuotaError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

/** 读取并解析账本；账本损坏时抛出，由调用方恢复原内容。 */
export function loadLedger(): LedgerOp[] {
  const raw = localStorage.getItem(LEDGER_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ledger-parse');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as LedgerFile).version !== 1 ||
    !Array.isArray((parsed as LedgerFile).ops)
  ) {
    throw new Error('ledger-shape');
  }
  return (parsed as LedgerFile).ops;
}

export function writeLedger(ops: LedgerOp[]): { ok: boolean; reason?: 'quota' } {
  try {
    const file: LedgerFile = { version: 1, ops };
    localStorage.setItem(LEDGER_KEY, JSON.stringify(file));
    return { ok: true };
  } catch (e) {
    if (isQuotaError(e)) return { ok: false, reason: 'quota' };
    throw e;
  }
}

export function nextSeq(ops: LedgerOp[]): number {
  return ops.reduce((m, op) => Math.max(m, op.seq), 0) + 1;
}

/**
 * 追加一条操作。
 * - 总是从 localStorage 读取最新账本再追加，避免跨标签页并发写入丢失更新。
 * - opId 已存在则视为重复操作，不重复生效（幂等）。
 * - 容量不足时拒绝写入，且不改动原账本（保留原记录）。
 * - 返回最终写入的 op（seq 已按最新账本重新分配）。
 */
export function appendOp(op: LedgerOp): { ok: boolean; reason?: 'quota' | 'duplicate'; ops: LedgerOp[]; op?: LedgerOp } {
  let current: LedgerOp[];
  try {
    current = loadLedger();
  } catch {
    current = [];
  }
  if (current.some((existing) => existing.opId === op.opId)) {
    return { ok: false, reason: 'duplicate', ops: current };
  }
  const finalOp: LedgerOp = { ...op, seq: nextSeq(current) };
  const next = [...current, finalOp];
  const result = writeLedger(next);
  if (!result.ok) return { ok: false, reason: result.reason, ops: current };
  return { ok: true, ops: next, op: finalOp };
}

/** 按 seq 重放账本，合并出进度、记录与课节版本。 */
export function replayLedger(ops: LedgerOp[]): MergedData {
  const attempts: MergedData['attempts'] = [];
  const progress: MergedData['progress'] = {};
  const versions: Record<string, number> = {};
  const byId = new Map<string, MergedData['attempts'][number]>();

  const sorted = [...ops].sort(
    (a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.opId.localeCompare(b.opId)
  );

  for (const op of sorted) {
    versions[op.lessonId] = Math.max(versions[op.lessonId] ?? 0, op.seq);
    switch (op.type) {
      case 'progress': {
        const payload = op.progress!;
        const prev = progress[op.lessonId] ?? { answers: {}, activeSentenceId: payload.activeSentenceId, updatedAt: op.createdAt };
        progress[op.lessonId] = {
          answers: { ...prev.answers, ...payload.answers },
          activeSentenceId: payload.activeSentenceId || prev.activeSentenceId,
          updatedAt: op.createdAt
        };
        break;
      }
      case 'attempt': {
        const attempt = op.attempt!;
        if (!byId.has(attempt.id)) {
          byId.set(attempt.id, attempt);
          attempts.unshift(attempt);
        }
        break;
      }
      case 'feedback': {
        const target = byId.get(op.feedback!.attemptId);
        if (target) target.teacherFeedback = op.feedback!.teacherFeedback;
        break;
      }
      case 'classification': {
        const target = byId.get(op.classification!.attemptId);
        const token = target?.sentenceAttempts
          .find((sa) => sa.sentenceId === op.classification!.sentenceId)
          ?.tokens.find((t) => t.index === op.classification!.tokenIndex);
        if (token) {
          token.category = op.classification!.category;
          token.reason = op.classification!.reason;
        }
        break;
      }
    }
  }

  return { attempts, progress, versions };
}

/** 列出某课节自 sinceSeq 以来在别处发生的改动，供冲突核对展示。 */
export function changesSince(ops: LedgerOp[], lessonId: string, sinceSeq: number): ConflictChange[] {
  const changes: ConflictChange[] = [];
  const relevant = ops
    .filter((op) => op.lessonId === lessonId && op.seq > sinceSeq)
    .sort((a, b) => a.seq - b.seq);

  for (const op of relevant) {
    switch (op.type) {
      case 'progress':
        for (const sentenceId of Object.keys(op.progress!.answers)) {
          changes.push({
            kind: 'progress',
            lessonId,
            sentenceId,
            label: `第 ${sentenceId} 句答案已在别处更新`,
            detail: op.progress!.answers[sentenceId]
          });
        }
        break;
      case 'attempt':
        changes.push({
          kind: 'attempt',
          lessonId,
          attemptId: op.attempt!.id,
          label: `已在别处提交新的听写记录（${op.attempt!.score} 分）`,
          detail: op.attempt!.id
        });
        break;
      case 'feedback':
        changes.push({
          kind: 'feedback',
          lessonId,
          attemptId: op.feedback!.attemptId,
          label: '教师反馈已在别处更新',
          detail: op.feedback!.teacherFeedback
        });
        break;
      case 'classification':
        changes.push({
          kind: 'classification',
          lessonId,
          attemptId: op.classification!.attemptId,
          label: '错误分类已在别处更新'
        });
        break;
    }
  }
  return changes;
}

/** 把旧版整体状态迁移为账本操作（旧数据首次打开时使用）。 */
export function migrateOldStateToOps(old: PersistedState): LedgerOp[] {
  const ops: LedgerOp[] = [];
  let seq = 0;
  const stamp = () => new Date().toISOString();

  for (const [lessonId, prog] of Object.entries(old.progress ?? {})) {
    seq += 1;
    ops.push({
      opId: `migration-progress-${lessonId}`,
      seq,
      source: 'migration',
      type: 'progress',
      lessonId,
      baseVersion: 0,
      createdAt: prog.updatedAt || stamp(),
      progress: { answers: { ...prog.answers }, activeSentenceId: prog.activeSentenceId }
    });
  }

  for (const attempt of old.attempts ?? []) {
    seq += 1;
    ops.push({
      opId: `migration-attempt-${attempt.id}`,
      seq,
      source: 'migration',
      type: 'attempt',
      lessonId: attempt.lessonId,
      baseVersion: 0,
      createdAt: attempt.submittedAt,
      attempt: structuredClone(attempt)
    });

    if (attempt.teacherFeedback) {
      seq += 1;
      ops.push({
        opId: `migration-feedback-${attempt.id}`,
        seq,
        source: 'migration',
        type: 'feedback',
        lessonId: attempt.lessonId,
        baseVersion: 0,
        createdAt: attempt.submittedAt,
        feedback: { attemptId: attempt.id, teacherFeedback: attempt.teacherFeedback }
      });
    }

    for (const sa of attempt.sentenceAttempts) {
      for (const token of sa.tokens) {
        if (token.category !== 'unclassified' || token.reason) {
          seq += 1;
          ops.push({
            opId: `migration-classification-${attempt.id}-${sa.sentenceId}-${token.index}`,
            seq,
            source: 'migration',
            type: 'classification',
            lessonId: attempt.lessonId,
            baseVersion: 0,
            createdAt: attempt.submittedAt,
            classification: {
              attemptId: attempt.id,
              sentenceId: sa.sentenceId,
              tokenIndex: token.index,
              category: token.category,
              reason: token.reason
            }
          });
        }
      }
    }
  }

  return ops;
}
