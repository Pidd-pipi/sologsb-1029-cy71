import type { LedgerDoc, LedgerOperation, PersistedState, PrefsDoc } from './types';
import { appendOperations, isLedgerDoc, newLedgerDoc } from './ledger';
import { rawRead, readJSON, removeKey, writeJSON } from './storage';

export const LEGACY_STATE_KEY = 'sologsb-1029-dictation-state-v1';
export const LEDGER_KEY = 'sologsb-1029-ledger-v2';
export const PREFS_KEY = 'sologsb-1029-prefs-v2';
const BACKUP_STATE_KEY = 'sologsb-1029-legacy-backup';

export interface MigrationResult {
  migrated: boolean;
  error?: 'quota' | 'unparseable' | 'denied';
}

const migrationSource = { tabId: 'migration', role: 'learner' as const, label: '旧数据迁移', system: true };
const fixedMigrationTime = '2026-10-01T00:00:00.000Z';

/**
 * 旧 v1 数据首次打开迁移：把进度、作答、反馈、错误分类展开成账本操作，
 * 再由统一的重放逻辑折叠成合并结果。
 *
 * 任何一步失败都恢复原内容（旧键始终保留到全部写完并校验通过后才删），
 * 调用方可重试。
 */
export function migrateLegacyState(): MigrationResult {
  const legacyRaw = rawRead(LEGACY_STATE_KEY);
  if (!legacyRaw) return { migrated: false };

  // 账本已存在说明此前迁移过（可能进行到一半），继续补齐偏好设置即可。
  const existingLedger = readJSON<unknown>(LEDGER_KEY);
  if (existingLedger && isLedgerDoc(existingLedger)) {
    const prefsResult = ensurePrefsFromLegacy(legacyRaw);
    if (!prefsResult.ok) return { migrated: true, error: prefsResult.reason === 'quota' ? 'quota' : 'denied' };
    // 迁移收尾：移除旧键与备份键。
    removeKey(LEGACY_STATE_KEY);
    removeKey(BACKUP_STATE_KEY);
    return { migrated: true };
  }

  let legacy: PersistedState;
  try {
    legacy = JSON.parse(legacyRaw) as PersistedState;
    if (!legacy || !Array.isArray(legacy.attempts) || typeof legacy.progress !== 'object') {
      return { migrated: false, error: 'unparseable' };
    }
  } catch {
    return { migrated: false, error: 'unparseable' };
  }

  // 迁移开始前先把原内容另存一份备份；容量不足或后续失败时原记录仍在。
  const backup = writeJSON(BACKUP_STATE_KEY, legacyRaw);
  if (!backup.ok) return { migrated: false, error: backup.reason === 'quota' ? 'quota' : 'denied' };

  const ledger = buildLedgerFromLegacy(legacy);
  const prefs = buildPrefsFromLegacy(legacy);

  const ledgerWrite = writeJSON(LEDGER_KEY, ledger);
  if (!ledgerWrite.ok) {
    rollbackPartialMigration();
    return { migrated: false, error: ledgerWrite.reason === 'quota' ? 'quota' : 'denied' };
  }
  const prefsWrite = writeJSON(PREFS_KEY, prefs);
  if (!prefsWrite.ok) {
    rollbackPartialMigration();
    return { migrated: false, error: prefsWrite.reason === 'quota' ? 'quota' : 'denied' };
  }

  // 回读校验，确保落盘内容可重放；失败则恢复原内容允许重试。
  const verified = readJSON<unknown>(LEDGER_KEY);
  if (!verified || !isLedgerDoc(verified)) {
    rollbackPartialMigration();
    return { migrated: false, error: 'denied' };
  }

  removeKey(LEGACY_STATE_KEY);
  removeKey(BACKUP_STATE_KEY);
  return { migrated: true };
}

function rollbackPartialMigration(): void {
  // 删掉可能写坏的新键，旧键 LEGACY_STATE_KEY 从未被删除，应用下次打开仍读到原内容。
  removeKey(LEDGER_KEY);
  removeKey(PREFS_KEY);
}

function ensurePrefsFromLegacy(legacyRaw: string): { ok: boolean; reason?: 'quota' | 'denied' | 'serialization' } {
  try {
    const legacy = JSON.parse(legacyRaw) as PersistedState;
    return writeJSON(PREFS_KEY, buildPrefsFromLegacy(legacy));
  } catch {
    return { ok: false, reason: 'serialization' };
  }
}

export function buildPrefsFromLegacy(legacy: PersistedState): PrefsDoc {
  const downloads: Record<string, boolean> = {};
  for (const course of legacy.courses ?? []) {
    for (const lesson of course.lessons ?? []) downloads[lesson.id] = !!lesson.downloaded;
  }
  return {
    docType: 'sologsb-prefs',
    schemaVersion: 2,
    theme: legacy.theme ?? 'light',
    fontScale: typeof legacy.fontScale === 'number' ? legacy.fontScale : 1,
    role: legacy.role ?? 'learner',
    activeLessonId: legacy.activeLessonId ?? '',
    activeSentenceId: legacy.activeSentenceId ?? '',
    downloads
  };
}

export function buildLedgerFromLegacy(legacy: PersistedState): LedgerDoc {
  let ledger = newLedgerDoc();
  const operations: LedgerOperation[] = [];
  let counter = 0;
  const nextId = () => `mig-${(counter += 1).toString(36)}`;

  // 1) 课程进度（逐句答案；当前句位置直接取已迁移答案里的最后操作，不产生冗余操作）。
  for (const [lessonId, progress] of Object.entries(legacy.progress ?? {})) {
    for (const [sentenceId, answer] of Object.entries(progress.answers ?? {})) {
      operations.push({
        id: nextId(), seq: 0, at: progress.updatedAt || fixedMigrationTime,
        kind: 'answer', lessonId, source: migrationSource,
        sentenceId, value: answer
      });
    }
  }

  // 2) 已提交作答（含逐词结果快照）。
  for (const attempt of legacy.attempts ?? []) {
    operations.push({
      id: nextId(), seq: 0, at: attempt.submittedAt,
      kind: 'submit', lessonId: attempt.lessonId, source: migrationSource,
      attempt, idempotencyKey: `migrated-submit-${attempt.id}`
    });
    if (attempt.teacherFeedback) {
      operations.push({
        id: nextId(), seq: 0, at: attempt.submittedAt,
        kind: 'feedback', lessonId: attempt.lessonId, source: migrationSource,
        attemptId: attempt.id, value: attempt.teacherFeedback
      });
    }
    for (const sentence of attempt.sentenceAttempts ?? []) {
      for (const token of sentence.tokens ?? []) {
        if (token.correct) continue;
        if (token.category === 'unclassified' && !token.reason) continue;
        operations.push({
          id: nextId(), seq: 0, at: attempt.submittedAt,
          kind: 'classify', lessonId: attempt.lessonId, source: migrationSource,
          attemptId: attempt.id, sentenceId: sentence.sentenceId,
          tokenIndex: token.index, category: token.category, reason: token.reason
        });
      }
    }
  }

  ledger = appendOperations(ledger, operations);
  return ledger;
}
