import { reactive } from 'vue';
import { demoCourses, createInitialState } from './data';
import type {
  ConflictEntry,
  ConflictResolution,
  DraftItem,
  DraftsDoc,
  ErrorCategory,
  LessonProgress,
  LedgerDoc,
  LedgerOperation,
  Lesson,
  OpSource,
  PersistedState,
  PracticeAttempt,
  PrefsDoc,
  Role
} from './types';
import { readJSON, writeJSON, removeKey } from './storage';
import {
  LEDGER_KEY,
  PREFS_KEY,
  buildLedgerFromLegacy,
  buildPrefsFromLegacy,
  migrateLegacyState
} from './migration';
import {
  appendOperations,
  fieldKeyOf,
  isLedgerDoc,
  makeOpId,
  mergeLedger,
  newLedgerDoc,
  opDisplayValue,
  prepareDrafts,
  replayOperations
} from './ledger';

const LEGACY_STATE_KEY = 'sologsb-1029-dictation-state-v1';
const DRAFTS_KEY_PREFIX = 'sologsb-1029-drafts-v2:';

export type StorageIssue = '' | 'quota' | 'denied' | 'migration' | 'replay';
export type CommitFailReason = 'quota' | 'conflict' | 'denied' | 'unhealthy' | 'undecided';

export interface CommitResult {
  ok: boolean;
  reason?: CommitFailReason;
  conflicts?: ConflictEntry[];
}

export interface SessionStoreState {
  courses: typeof demoCourses;
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  lessonVersion: Record<string, number>;
  theme: 'light' | 'dark';
  fontScale: number;
  role: Role;
  activeLessonId: string;
  activeSentenceId: string;
  /** 正在等待人工合并的冲突（含同课节的他处改动提示）。 */
  pendingConflicts: ConflictEntry[];
  /** 合并确认完成前挂起的动作。 */
  pendingAction: 'submit' | 'feedback' | null;
  storageError: StorageIssue;
  online: boolean;
  /** 账本事件来源订阅者（冲突面板等用它刷新）。 */
  ledgerTick: number;
}

function createTabId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const tabId = createTabId();
export const getTabId = () => tabId;
const sessionSource = (role: Role): OpSource => ({
  tabId,
  role,
  label: role === 'teacher' ? `教师页 · ${tabId.slice(0, 4)}` : `学习页 · ${tabId.slice(0, 4)}`
});

// ---- 启动：迁移旧数据 / 载入账本 / 重放 -----------------------------------

let ledgerDoc: LedgerDoc = newLedgerDoc();
let ledgerHealthy = true;

function bootstrap(): SessionStoreState {
  // 1) 旧数据首次打开迁移；失败保留旧键，原内容不动，可稍后重试。
  const migration = migrateLegacyState();

  // 2) 读取账本（迁移刚写入或历史已存在）。
  const loaded = readJSON<unknown>(LEDGER_KEY);
  if (loaded !== undefined) {
    if (isLedgerDoc(loaded)) ledgerDoc = loaded;
    else ledgerHealthy = false;
  } else if (!migration.migrated && !migration.error && !legacyKeyExists()) {
    // 全新安装：用示例数据建立初始账本。
    const seed = seedLedgerFromDemo();
    if (seed) ledgerDoc = seed;
  }

  // 3) 重放账本得到合并后的课程进度、逐词结果与教师反馈。
  let replayed: ReturnType<typeof replayOperations>;
  try {
    replayed = replayOperations(ledgerDoc.operations);
  } catch {
    ledgerHealthy = false;
    replayed = replayOperations([]);
  }

  const prefs = loadPrefs();
  applyDownloads(prefs);

  const storageError: StorageIssue = !ledgerHealthy
    ? 'replay'
    : migration.error === 'quota'
      ? 'quota'
      : migration.error
        ? 'migration'
        : '';

  return reactive<SessionStoreState>({
    courses: demoCourses,
    attempts: replayed.attempts,
    progress: replayed.progress,
    lessonVersion: replayed.lessonVersion,
    theme: prefs.theme,
    fontScale: prefs.fontScale,
    role: prefs.role,
    activeLessonId: prefs.activeLessonId,
    activeSentenceId: prefs.activeSentenceId,
    pendingConflicts: [],
    pendingAction: null,
    storageError,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    ledgerTick: 0
  });
}

function legacyKeyExists(): boolean {
  try {
    return typeof localStorage !== 'undefined' && !!localStorage.getItem(LEGACY_STATE_KEY);
  } catch {
    return false;
  }
}

function seedLedgerFromDemo(): LedgerDoc | undefined {
  const legacy = createInitialState() as PersistedState;
  const ledger = buildLedgerFromLegacy(legacy);
  const prefs = buildPrefsFromLegacy(legacy);
  const ledgerWrite = writeJSON(LEDGER_KEY, ledger);
  if (!ledgerWrite.ok) return undefined;
  writeJSON(PREFS_KEY, prefs);
  return ledger;
}

function loadPrefs(): PrefsDoc {
  const parsed = readJSON<Partial<PrefsDoc>>(PREFS_KEY);
  if (parsed && parsed.docType === 'sologsb-prefs') {
    return {
      docType: 'sologsb-prefs',
      schemaVersion: 2,
      theme: parsed.theme ?? 'light',
      fontScale: typeof parsed.fontScale === 'number' ? parsed.fontScale : 1,
      role: parsed.role === 'teacher' ? 'teacher' : 'learner',
      activeLessonId: parsed.activeLessonId ?? '',
      activeSentenceId: parsed.activeSentenceId ?? '',
      downloads: parsed.downloads ?? {}
    };
  }
  return { docType: 'sologsb-prefs', schemaVersion: 2, theme: 'light', fontScale: 1, role: 'learner', activeLessonId: '', activeSentenceId: '', downloads: {} };
}

function applyDownloads(prefs: PrefsDoc): void {
  for (const course of demoCourses) {
    for (const lesson of course.lessons) {
      if (lesson.id in prefs.downloads) lesson.downloaded = !!prefs.downloads[lesson.id];
    }
  }
}

function savePrefs(): boolean {
  const prefs: PrefsDoc = {
    docType: 'sologsb-prefs',
    schemaVersion: 2,
    theme: state.theme,
    fontScale: state.fontScale,
    role: state.role,
    activeLessonId: state.activeLessonId,
    activeSentenceId: state.activeSentenceId,
    downloads: collectDownloads()
  };
  const result = writeJSON(PREFS_KEY, prefs);
  if (!result.ok) state.storageError = result.reason === 'quota' ? 'quota' : 'denied';
  return result.ok;
}

function collectDownloads(): Record<string, boolean> {
  const downloads: Record<string, boolean> = {};
  for (const course of demoCourses) for (const lesson of course.lessons) downloads[lesson.id] = lesson.downloaded;
  return downloads;
}

export const state = bootstrap();

// ---- 本标签草稿（容量不足拒绝写入，原记录保留） ----------------------------

let draftsDoc: DraftsDoc = loadDrafts();

/** 用户已在冲突面板选择「保留本地」的字段，确认追加后即清除。 */
const locallyResolvedKeys = new Set<string>();

function draftsStorageKey(): string {
  return `${DRAFTS_KEY_PREFIX}${tabId}`;
}

function loadDrafts(): DraftsDoc {
  const parsed = readJSON<DraftsDoc>(draftsStorageKey());
  if (parsed && parsed.docType === 'sologsb-drafts' && Array.isArray(parsed.items)) {
    return { docType: 'sologsb-drafts', schemaVersion: 2, tabId, items: parsed.items };
  }
  return { docType: 'sologsb-drafts', schemaVersion: 2, tabId, items: [] };
}

function persistDrafts(): boolean {
  const result = writeJSON(draftsStorageKey(), draftsDoc);
  if (!result.ok) state.storageError = result.reason === 'quota' ? 'quota' : 'denied';
  return result.ok;
}

export function pendingDrafts(): DraftItem[] {
  return draftsDoc.items;
}

function upsertDraft(item: DraftItem): boolean {
  const index = draftsDoc.items.findIndex((draft) => draft.key === item.key);
  if (index >= 0) draftsDoc.items[index] = item;
  else draftsDoc.items.push(item);
  return persistDrafts();
}

function removeDrafts(fieldKeys: Iterable<string>): void {
  const keys = new Set(fieldKeys);
  draftsDoc.items = draftsDoc.items.filter((draft) => !keys.has(draft.key));
  persistDrafts();
}

// ---- 查询（均读取重放后的合并结果，本标签草稿优先显示） --------------------

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
  savePrefs();
}

/** 学习页当前显示的答案：合并后的进度为底，本标签未落账本草稿优先。 */
export function effectiveAnswer(lessonId: string, sentenceId: string): string {
  const draft = draftsDoc.items.find(
    (item) => item.kind === 'answer' && item.lessonId === lessonId && item.sentenceId === sentenceId
  );
  if (draft) return draft.value;
  return state.progress[lessonId]?.answers[sentenceId] ?? '';
}

export function lessonVersion(lessonId: string): number {
  return state.lessonVersion[lessonId] ?? 0;
}

export function updateTokenClassification(attemptId: string, sentenceId: string, tokenIndex: number, patch: { category?: ErrorCategory; reason?: string }) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (token) Object.assign(token, patch);
}

// ---- 写入：草稿 → 版本核对 → 冲突 → 原子提交 -------------------------------

function fieldKeyFor(kind: DraftItem['kind'], lessonId: string, extra: { sentenceId?: string; attemptId?: string; tokenIndex?: number }): string {
  return fieldKeyOf({ kind, lessonId, ...extra });
}

/** 作答：带来源写入本机操作账本（保存前核对同课节版本）。 */
export function saveAnswerDraft(lessonId: string, sentenceId: string, value: string): CommitResult {
  const fieldKey = fieldKeyFor('answer', lessonId, { sentenceId });
  const draft: DraftItem = {
    key: fieldKey,
    lessonId,
    fieldKey,
    kind: 'answer',
    value,
    opId: makeOpId(tabId),
    updatedAt: new Date().toISOString(),
    sentenceId
  };
  if (!upsertDraft(draft)) return { ok: false, reason: 'quota' };
  return commitDrafts({ kinds: ['answer'], pendingAction: null });
}

/** 错误分类/原因：核对版本后入账，重复选择同值只生效一次。 */
export function saveClassification(
  lessonId: string,
  attemptId: string,
  sentenceId: string,
  tokenIndex: number,
  patch: { category?: ErrorCategory; reason?: string }
): CommitResult {
  const fieldKey = fieldKeyFor('classify', lessonId, { attemptId, sentenceId, tokenIndex });
  const draft: DraftItem = {
    key: fieldKey,
    lessonId,
    fieldKey,
    kind: 'classify',
    value: `${patch.category ?? ''}|${patch.reason ?? ''}`,
    opId: makeOpId(tabId),
    updatedAt: new Date().toISOString(),
    attemptId,
    sentenceId,
    tokenIndex,
    category: patch.category,
    reason: patch.reason
  };
  if (!upsertDraft(draft)) return { ok: false, reason: 'quota' };
  return commitDrafts({ kinds: ['classify'], pendingAction: null });
}

/** 教师反馈：保存前核对同一课节版本，冲突则保留草稿等待合并。 */
export function saveFeedbackDraft(lessonId: string, attemptId: string, value: string): CommitResult {
  const fieldKey = fieldKeyFor('feedback', lessonId, { attemptId });
  const draft: DraftItem = {
    key: fieldKey,
    lessonId,
    fieldKey,
    kind: 'feedback',
    value,
    opId: makeOpId(tabId),
    updatedAt: new Date().toISOString(),
    attemptId
  };
  if (!upsertDraft(draft)) return { ok: false, reason: 'quota' };
  return commitDrafts({ kinds: ['feedback'], pendingAction: 'feedback', blockOnRemoteOnly: true });
}

/**
 * 整课提交：逐词结果快照随草稿保存（断网/重显可恢复），
 * 以提交动作自身作为幂等键，重复提交只能生效一次。
 */
export function queueSubmit(attempt: PracticeAttempt): CommitResult {
  const fieldKey = fieldKeyFor('submit', attempt.lessonId, {});
  const held = draftsDoc.items.find((draft) => draft.kind === 'submit');
  const opId = held?.opId ?? makeOpId(tabId);
  const draft: DraftItem = {
    key: fieldKey,
    lessonId: attempt.lessonId,
    fieldKey,
    kind: 'submit',
    value: attempt.id,
    opId,
    updatedAt: attempt.submittedAt,
    attemptSnapshot: attempt
  };
  if (!upsertDraft(draft)) return { ok: false, reason: 'quota' };
  return commitDrafts({ kinds: ['submit', 'answer'], pendingAction: 'submit', blockOnRemoteOnly: true });
}

interface CommitOptions {
  kinds: DraftItem['kind'][];
  /** 发生冲突时需要挂起的动作。 */
  pendingAction: 'submit' | 'feedback' | null;
  /** 同课节被别处改动（即使字段不重叠）也要求先确认合并。 */
  blockOnRemoteOnly?: boolean;
  /** 本次调用额外认可「保留本地」的字段（合并确认后重入时使用）。 */
  extraResolvedKeys?: Iterable<string>;
}

/**
 * 核心提交流程：
 * 1) 重新从本机读取账本（别的标签可能刚写过）并与内存账本合并；
 * 2) 重放得到最新版本，核对同课节版本与字段，发现别处已改 → 保留草稿、列出冲突；
 * 3) 同值重复操作直接视为已生效，不再追加；
 * 4) 无阻塞冲突时把操作追加（统一分配递增 seq）并原子写回；
 * 5) 写盘（容量）失败则保留原账本与全部草稿，可重试；
 * 6) 成功后重放刷新合并结果，并清掉已入账草稿。
 */
function commitDrafts(options: CommitOptions): CommitResult {
  if (!ledgerHealthy) return { ok: false, reason: 'unhealthy' };

  const candidates = draftsDoc.items.filter((draft) => options.kinds.includes(draft.kind));
  if (!candidates.length) return { ok: true };

  const disk = readJSON<unknown>(LEDGER_KEY);
  if (disk !== undefined) {
    if (!isLedgerDoc(disk)) return { ok: false, reason: 'unhealthy' };
    ledgerDoc = mergeLedger(ledgerDoc, disk);
  }

  const replayed = replayOperations(ledgerDoc.operations);

  // 重复操作只能生效一次：账本现值与草稿一致（且是本标签此前写入）时直接清草稿。
  const alreadyApplied: string[] = [];
  for (const draft of candidates) {
    if (draft.kind === 'submit') {
      const attempt = draft.attemptSnapshot;
      if (attempt && replayed.attempts.some((item) => item.id === attempt.id)) alreadyApplied.push(draft.key);
      continue;
    }
    const last = replayed.fieldLast[draft.fieldKey];
    if (last && last.source.tabId === tabId && opDisplayValue(last) === draft.value) alreadyApplied.push(draft.key);
  }
  if (alreadyApplied.length) removeDrafts(alreadyApplied);
  const pending = candidates.filter((draft) => !alreadyApplied.includes(draft.key));
  if (!pending.length) {
    state.ledgerTick += 1;
    return { ok: true };
  }

  const resolvedKeys = new Set(locallyResolvedKeys);
  for (const key of options.extraResolvedKeys ?? []) resolvedKeys.add(key);
  const prepared = prepareDrafts(pending, ledgerDoc, tabId, resolvedKeys);
  const blocking = prepared.conflicts.filter((conflict) => !conflict.remoteOnly);
  if (blocking.length) {
    state.pendingConflicts = dedupeConflicts([
      ...state.pendingConflicts.filter((existing) => existing.decided),
      ...prepared.conflicts
    ]);
    state.pendingAction = options.pendingAction;
    return { ok: false, reason: 'conflict', conflicts: prepared.conflicts };
  }

  // 提交整课 / 保存反馈时，同课节的他处改动也要先列出并确认合并。
  if (options.blockOnRemoteOnly && prepared.conflicts.some((conflict) => conflict.remoteOnly)) {
    state.pendingConflicts = dedupeConflicts([...state.pendingConflicts, ...prepared.conflicts]);
    state.pendingAction = options.pendingAction;
    state.ledgerTick += 1;
    return { ok: false, reason: 'conflict', conflicts: prepared.conflicts };
  }

  // 其它场景下同课节的他处改动仅作信息提示，不阻塞。
  if (prepared.conflicts.length) {
    state.pendingConflicts = dedupeConflicts([
      ...state.pendingConflicts.filter((conflict) => conflict.remoteOnly),
      ...prepared.conflicts
    ]);
  }

  const operations = pending.map(buildOperation);
  const nextLedger = appendOperations(ledgerDoc, operations);

  // 原子写盘：成功才替换内存账本；配额不足拒绝写入且原记录保留。
  const write = writeJSON(LEDGER_KEY, nextLedger);
  if (!write.ok) {
    state.storageError = write.reason === 'quota' ? 'quota' : 'denied';
    return { ok: false, reason: write.reason === 'quota' ? 'quota' : 'denied' };
  }

  ledgerDoc = nextLedger;
  state.storageError = '';
  removeDrafts(pending.map((draft) => draft.key));
  for (const draft of pending) locallyResolvedKeys.delete(draft.key);
  reapplyReplay();
  state.ledgerTick += 1;
  return { ok: true };
}

function buildOperation(draft: DraftItem): LedgerOperation {
  const source = sessionSource(state.role);
  const base: LedgerOperation = {
    id: draft.opId,
    seq: 0,
    at: draft.updatedAt,
    kind: draft.kind,
    lessonId: draft.lessonId,
    source
  };
  if (draft.kind === 'answer') {
    base.sentenceId = draft.sentenceId;
    base.value = draft.value;
  } else if (draft.kind === 'submit') {
    base.idempotencyKey = draft.opId;
    base.attempt = draft.attemptSnapshot;
  } else if (draft.kind === 'feedback') {
    base.attemptId = draft.attemptId;
    base.value = draft.value;
  } else if (draft.kind === 'classify') {
    base.attemptId = draft.attemptId;
    base.sentenceId = draft.sentenceId;
    base.tokenIndex = draft.tokenIndex;
    base.category = draft.category;
    base.reason = draft.reason;
  }
  return base;
}

function dedupeConflicts(conflicts: ConflictEntry[]): ConflictEntry[] {
  const map = new Map<string, ConflictEntry>();
  for (const conflict of conflicts) map.set(conflict.fieldKey, conflict);
  return [...map.values()];
}

// ---- 冲突合并：确认后才可提交 ----------------------------------------------

export function resolveConflict(fieldKey: string, resolution: ConflictResolution): void {
  const conflict = state.pendingConflicts.find((item) => item.fieldKey === fieldKey);
  if (!conflict || conflict.remoteOnly) return;
  conflict.resolution = resolution;
  conflict.decided = true;
  if (resolution === 'local') {
    locallyResolvedKeys.add(fieldKey);
  } else {
    locallyResolvedKeys.delete(fieldKey);
    removeDrafts([fieldKey]);
  }
  state.ledgerTick += 1;
}

/**
 * 确认合并：所有阻塞冲突都有明确选择后才可提交。
 * - remote：丢弃本地草稿，采用账本中他处内容；
 * - local：保留本地草稿，作为最终值重新追加入账。
 */
export function confirmMergedCommit(): CommitResult {
  const blocking = state.pendingConflicts.filter((conflict) => !conflict.remoteOnly);
  if (blocking.some((conflict) => !conflict.decided)) {
    return { ok: false, reason: 'undecided', conflicts: state.pendingConflicts };
  }

  // remote 决议的草稿在 resolveConflict 时已删除；local 的字段随本次调用显式认可。
  const localKeys = blocking.filter((conflict) => conflict.resolution === 'local').map((conflict) => conflict.fieldKey);
  for (const key of localKeys) locallyResolvedKeys.add(key);
  const action = state.pendingAction;
  // 面板里列出的同课节他处改动（remoteOnly）用户已经看到并确认，重入时不再阻塞。
  const acknowledgedRemoteOnly = state.pendingConflicts
    .filter((conflict) => conflict.remoteOnly)
    .map((conflict) => conflict.fieldKey);
  state.pendingConflicts = [];
  state.pendingAction = null;

  const kinds: DraftItem['kind'][] = action === 'submit'
    ? ['submit', 'answer', 'classify', 'feedback']
    : ['answer', 'classify', 'feedback'];
  const result = commitDrafts({
    kinds,
    pendingAction: action,
    // 进入合并确认后，已知的 remoteOnly 仅作信息，不再拦截最终提交。
    blockOnRemoteOnly: false,
    extraResolvedKeys: [...localKeys, ...acknowledgedRemoteOnly]
  });
  if (result.ok) for (const key of localKeys) locallyResolvedKeys.delete(key);
  if (!result.ok && result.reason !== 'conflict') state.pendingAction = action;
  return result;
}

/** 暂不合并：关闭面板，草稿原样保留，下次保存时仍会核对。 */
export function dismissConflictPanel(): void {
  state.pendingConflicts = [];
  state.pendingAction = null;
  locallyResolvedKeys.clear();
  state.ledgerTick += 1;
}

export function hasPendingSubmit(): boolean {
  return draftsDoc.items.some((draft) => draft.kind === 'submit');
}

/** 断网/重开后从草稿恢复的提交快照（尚未入账）。 */
export function recoverPendingSubmits(): PracticeAttempt[] {
  return draftsDoc.items
    .filter((draft) => draft.kind === 'submit' && draft.attemptSnapshot)
    .map((draft) => draft.attemptSnapshot as PracticeAttempt);
}

// ---- 重放：标签重新显示 / 断网恢复 / 跨标签 storage 事件 --------------------

export function replayFromDisk(): { changed: boolean; error?: 'replay' } {
  if (!ledgerHealthy) {
    const retry = readJSON<unknown>(LEDGER_KEY);
    if (retry && isLedgerDoc(retry)) {
      ledgerDoc = retry;
      ledgerHealthy = true;
    } else {
      return { changed: false, error: 'replay' };
    }
  }
  const disk = readJSON<unknown>(LEDGER_KEY);
  if (!disk || !isLedgerDoc(disk)) return { changed: false };
  const merged = mergeLedger(ledgerDoc, disk);
  const changed = merged.operations.length !== ledgerDoc.operations.length
    || JSON.stringify(merged.operations) !== JSON.stringify(ledgerDoc.operations);
  ledgerDoc = merged;
  try {
    reapplyReplay();
    state.storageError = '';
    state.ledgerTick += 1;
  } catch {
    state.storageError = 'replay';
    return { changed, error: 'replay' };
  }
  return { changed };
}

function reapplyReplay(): void {
  const replayed = replayOperations(ledgerDoc.operations);
  state.attempts = replayed.attempts;
  state.progress = replayed.progress;
  state.lessonVersion = replayed.lessonVersion;
}

/** 迁移失败后由用户触发重试：成功则重放并恢复原内容的合并视图。 */
export function retryMigration(): boolean {
  const result = migrateLegacyState();
  if (result.error) {
    state.storageError = result.error === 'quota' ? 'quota' : 'migration';
    return false;
  }
  const disk = readJSON<unknown>(LEDGER_KEY);
  if (disk && isLedgerDoc(disk)) {
    ledgerDoc = disk;
    ledgerHealthy = true;
    reapplyReplay();
    const prefs = loadPrefs();
    applyDownloads(prefs);
    state.theme = prefs.theme;
    state.fontScale = prefs.fontScale;
    state.role = prefs.role;
    state.storageError = '';
    return true;
  }
  return false;
}

/** 断网恢复：按账本重放，再把未落账本草稿经版本核对后提交（有冲突先合并）。 */
export function flushAfterReconnect(): CommitResult {
  replayFromDisk();
  return commitDrafts({ kinds: ['answer', 'classify', 'feedback', 'submit'], pendingAction: null, blockOnRemoteOnly: true });
}

// ---- 偏好 / 导出 / 兼容入口 -------------------------------------------------

export function persistPrefs(): boolean {
  return savePrefs();
}

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    schemaVersion: 2,
    ledgerSeq: ledgerDoc.operations.reduce((max, op) => Math.max(max, op.seq), 0),
    attempts: state.attempts,
    progress: state.progress
  }, null, 2);
}

/**
 * 兼容旧代码的统一持久化入口：保存偏好并尝试提交所有非提交类草稿。
 * 返回 false 表示存在配额问题或未解决冲突（调用方可提示）。
 */
export const persist = (): boolean => {
  savePrefs();
  const result = commitDrafts({ kinds: ['answer', 'classify', 'feedback'], pendingAction: null });
  return result.ok;
};

export { removeKey, LEGACY_STATE_KEY };

// ---- 跨标签与生命周期事件：按账本重放 --------------------------------------

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key && event.key.startsWith(DRAFTS_KEY_PREFIX) && event.key !== draftsStorageKey()) return;
    if (event.key === LEDGER_KEY || event.key === null) {
      replayFromDisk();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') replayFromDisk();
  });
  window.addEventListener('online', () => {
    state.online = true;
    flushAfterReconnect();
  });
  window.addEventListener('offline', () => {
    state.online = false;
  });
}
