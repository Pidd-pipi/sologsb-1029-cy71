import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import {
  appendOp,
  changesSince,
  LEDGER_KEY,
  loadLedger,
  migrateOldStateToOps,
  OLD_STATE_KEY,
  replayLedger,
  uuid,
  writeLedger
} from './ledger';
import type {
  ConflictInfo,
  ErrorCategory,
  LedgerOp,
  Lesson,
  LessonProgress,
  OpPayload,
  PersistedState,
  PracticeAttempt,
  SaveBanner,
  SentenceAttempt
} from './types';

const SETTINGS_KEY = 'sologsb-1029-dictation-settings-v1';
const TAB_ID = `tab-${uuid()}`;

interface Settings {
  activeLessonId: string;
  activeSentenceId: string;
  theme: 'light' | 'dark';
  fontScale: number;
  role: 'learner' | 'teacher';
  downloadedLessonIds: string[];
}

function defaultSettings(): Settings {
  return { activeLessonId: '', activeSentenceId: '', theme: 'light', fontScale: 1, role: 'learner', downloadedLessonIds: [] };
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // 设置损坏时回退默认值
  }
  return defaultSettings();
}

function persistSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // 设置写入失败不影响账本主流程
  }
}

const settings = reactive<Settings>(loadSettings());

export const state = reactive<PersistedState>({
  schemaVersion: 1,
  courses: createInitialState().courses,
  attempts: [],
  progress: {},
  get activeLessonId() { return settings.activeLessonId; },
  set activeLessonId(v: string) { settings.activeLessonId = v; },
  get activeSentenceId() { return settings.activeSentenceId; },
  set activeSentenceId(v: string) { settings.activeSentenceId = v; },
  get theme() { return settings.theme; },
  set theme(v: 'light' | 'dark') { settings.theme = v; },
  get fontScale() { return settings.fontScale; },
  set fontScale(v: number) { settings.fontScale = v; },
  get role() { return settings.role; },
  set role(v: 'learner' | 'teacher') { settings.role = v; }
});

watch(settings, () => persistSettings(settings), { deep: true });

/** 课节版本：该课节相关操作的最大 seq，由重放得出。 */
export const lessonVersions = reactive<Record<string, number>>({});
/** 本标签页已知的课节版本；保存前据此核对是否被别处改过。 */
const knownVersions = reactive<Record<string, number>>({});
/** 本标签页尚未写入账本的作答草稿（重放不会丢失正在输入的内容）。 */
const localDrafts = reactive<Record<string, { answers: Record<string, string>; activeSentenceId: string }>>({});
export const pendingConflicts = reactive<ConflictInfo[]>([]);
export const saveBanner = reactive<SaveBanner>({ show: false, kind: 'conflict', message: '' });

function syncDownloaded() {
  for (const course of state.courses) {
    for (const lesson of course.lessons) {
      lesson.downloaded = settings.downloadedLessonIds.includes(lesson.id);
    }
  }
}

function seedDownloadedFromCourses() {
  if (settings.downloadedLessonIds.length === 0) {
    settings.downloadedLessonIds = state.courses.flatMap((c) => c.lessons.filter((l) => l.downloaded).map((l) => l.id));
  }
  syncDownloaded();
}

function applyReplay(ops: LedgerOp[]) {
  const merged = replayLedger(ops);
  state.attempts = merged.attempts;
  state.progress = merged.progress;
  for (const key of Object.keys(lessonVersions)) delete lessonVersions[key];
  Object.assign(lessonVersions, merged.versions);
}

function fallbackToOldState() {
  try {
    const raw = localStorage.getItem(OLD_STATE_KEY);
    if (raw) {
      const old = JSON.parse(raw) as PersistedState;
      state.attempts = old.attempts ?? [];
      state.progress = old.progress ?? {};
      return;
    }
  } catch {
    // 旧数据也损坏时清空
  }
  state.attempts = [];
  state.progress = {};
}

/** 启动时初始化：迁移旧数据 / 重放账本，失败则恢复原内容并允许重试。 */
export function initStore(): { ok: boolean; error?: 'migration' | 'replay' } {
  Object.assign(settings, loadSettings());
  const initial = createInitialState();
  state.courses = initial.courses;
  seedDownloadedFromCourses();

  const ledgerExists = localStorage.getItem(LEDGER_KEY) !== null;
  const oldExists = localStorage.getItem(OLD_STATE_KEY) !== null;

  if (ledgerExists) {
    try {
      const ops = loadLedger();
      replayLedger(ops); // 校验账本可读
      applyReplay(ops);
      return { ok: true };
    } catch {
      fallbackToOldState();
      saveBanner.show = true;
      saveBanner.kind = 'replay';
      saveBanner.message = '账本重放失败，已恢复原内容，可重试。';
      return { ok: false, error: 'replay' };
    }
  }

  try {
    const source = oldExists ? (JSON.parse(localStorage.getItem(OLD_STATE_KEY)!) as PersistedState) : initial;
    const ops = migrateOldStateToOps(source);
    const result = writeLedger(ops);
    if (!result.ok) {
      // 容量不足：账本写入失败，仅在内存中保留合并结果（原内容未被破坏）
      applyReplay(ops);
      saveBanner.show = true;
      saveBanner.kind = 'migration';
      saveBanner.message = '本机存储空间不足，迁移未完成，已保留原内容，可重试。';
      return { ok: false, error: 'migration' };
    }
    applyReplay(ops);
    return { ok: true };
  } catch {
    fallbackToOldState();
    saveBanner.show = true;
    saveBanner.kind = 'migration';
    saveBanner.message = '数据迁移失败，已恢复原内容，可重试。';
    return { ok: false, error: 'migration' };
  }
}

export function retryInit() {
  saveBanner.show = false;
  initStore();
}

/** 按账本重放，合并出最新结果；标签页重新显示或断网恢复时调用。 */
export function syncFromLedger() {
  try {
    const ops = loadLedger();
    applyReplay(ops);
  } catch {
    fallbackToOldState();
    saveBanner.show = true;
    saveBanner.kind = 'replay';
    saveBanner.message = '账本重放失败，已恢复原内容，可重试。';
  }
}

window.addEventListener('storage', (e) => {
  if (e.key === LEDGER_KEY) syncFromLedger();
  if (e.key === SETTINGS_KEY) {
    Object.assign(settings, loadSettings());
    syncDownloaded();
  }
});

export function lessons(): Lesson[] {
  return state.courses.flatMap((course) => course.lessons);
}
export function lessonById(id: string): Lesson | undefined {
  return lessons().find((lesson) => lesson.id === id);
}
export function courseForLesson(lessonId: string) {
  return state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);
}

export function markLessonKnown(lessonId: string) {
  knownVersions[lessonId] = lessonVersions[lessonId] ?? 0;
}

/** 合并账本进度与本标签页草稿，用于展示（草稿不会被重放覆盖）。 */
export function getDisplayProgress(lessonId: string): LessonProgress {
  const merged = state.progress[lessonId] ?? { answers: {}, activeSentenceId: '', updatedAt: '' };
  const draft = localDrafts[lessonId];
  if (!draft) return merged;
  return {
    answers: { ...merged.answers, ...draft.answers },
    activeSentenceId: draft.activeSentenceId || merged.activeSentenceId,
    updatedAt: merged.updatedAt
  };
}

function removeConflict(conflict: ConflictInfo) {
  const idx = pendingConflicts.findIndex((c) => c === conflict);
  if (idx >= 0) pendingConflicts.splice(idx, 1);
  if (pendingConflicts.length === 0) saveBanner.show = false;
}

/** 保存前核对同一课节版本；若别处已改则保留草稿并列出冲突。 */
function commitOp(
  lessonId: string,
  type: LedgerOp['type'],
  payload: OpPayload,
  draft: OpPayload
): boolean {
  syncFromLedger();
  const current = lessonVersions[lessonId] ?? 0;
  const known = knownVersions[lessonId] ?? 0;

  if (current > known) {
    const changes = changesSince(loadLedger(), lessonId, known);
    const conflict: ConflictInfo = { lessonId, baseVersion: known, currentVersion: current, changes, type, draft };
    pendingConflicts.push(conflict);
    saveBanner.show = true;
    saveBanner.kind = 'conflict';
    saveBanner.message = '其他标签页已修改本课节，草稿已保留，请确认合并。';
    saveBanner.conflict = conflict;
    return false;
  }

  const op: LedgerOp = {
    opId: `${TAB_ID}-${uuid()}`,
    seq: 0, // 由 appendOp 按最新账本重新分配，保证递增
    source: TAB_ID,
    type,
    lessonId,
    baseVersion: current,
    createdAt: new Date().toISOString(),
    ...payload
  } as LedgerOp;

  const result = appendOp(op);
  if (result.ok && result.op) {
    lessonVersions[lessonId] = result.op.seq;
    knownVersions[lessonId] = result.op.seq;
    if (type === 'progress') delete localDrafts[lessonId];
    syncFromLedger();
    return true;
  }
  if (result.reason === 'duplicate') return true;
  saveBanner.show = true;
  saveBanner.kind = 'quota';
  saveBanner.message = '本机存储空间不足，写入已拒绝，原记录已保留。';
  return false;
}

const flushTimers: Record<string, number> = {};

function scheduleFlush(lessonId: string) {
  window.clearTimeout(flushTimers[lessonId]);
  flushTimers[lessonId] = window.setTimeout(() => flushProgress(lessonId), 800);
}

export function flushProgress(lessonId: string): boolean {
  window.clearTimeout(flushTimers[lessonId]);
  const draft = localDrafts[lessonId];
  if (!draft) return true;
  const payload = { progress: { answers: { ...draft.answers }, activeSentenceId: draft.activeSentenceId } };
  return commitOp(lessonId, 'progress', payload, payload);
}

/** 作答写入：更新本标签页草稿并防抖写入账本。 */
export function updateAnswer(lessonId: string, sentenceId: string, answer: string) {
  const merged = state.progress[lessonId]?.answers[sentenceId] ?? '';
  let draft = localDrafts[lessonId];
  if (!draft) {
    if (answer === merged) return; // 切句时回填相同答案，不产生草稿
    draft = localDrafts[lessonId] = { answers: {}, activeSentenceId: sentenceId };
  }
  draft.answers[sentenceId] = answer;
  draft.activeSentenceId = sentenceId;
  scheduleFlush(lessonId);
}

/** 整课提交：先落草稿再写入提交操作。返回新记录 id，冲突或失败时返回 null。 */
export function submitAttempt(
  lessonId: string,
  lessonTitle: string,
  courseTitle: string,
  sentenceAttempts: SentenceAttempt[],
  score: number
): string | null {
  if (!flushProgress(lessonId)) return null; // 冲突未解决，暂不提交
  const id = `attempt-${Date.now()}`;
  const attempt: PracticeAttempt = {
    id,
    lessonId,
    lessonTitle,
    courseTitle,
    submittedAt: new Date().toISOString(),
    score,
    sentenceAttempts,
    teacherFeedback: ''
  };
  const payload = { attempt };
  return commitOp(lessonId, 'attempt', payload, payload) ? id : null;
}

export function saveFeedback(attemptId: string, teacherFeedback: string): boolean {
  const attempt = state.attempts.find((a) => a.id === attemptId);
  if (!attempt) return false;
  const payload = { feedback: { attemptId, teacherFeedback } };
  return commitOp(attempt.lessonId, 'feedback', payload, payload);
}

export function saveClassification(
  attemptId: string,
  sentenceId: string,
  tokenIndex: number,
  category: ErrorCategory,
  reason: string
): boolean {
  const attempt = state.attempts.find((a) => a.id === attemptId);
  if (!attempt) return false;
  const payload = { classification: { attemptId, sentenceId, tokenIndex, category, reason } };
  return commitOp(attempt.lessonId, 'classification', payload, payload);
}

/** 冲突确认后，把本标签页草稿合并到最新版本之上再提交。 */
export function confirmMerge(conflict: ConflictInfo): boolean {
  const op: LedgerOp = {
    opId: `${TAB_ID}-${uuid()}`,
    seq: 0,
    source: TAB_ID,
    type: conflict.type,
    lessonId: conflict.lessonId,
    baseVersion: conflict.currentVersion,
    createdAt: new Date().toISOString(),
    ...conflict.draft
  } as LedgerOp;

  const result = appendOp(op);
  if (result.ok && result.op) {
    lessonVersions[conflict.lessonId] = result.op.seq;
    knownVersions[conflict.lessonId] = result.op.seq;
    if (conflict.type === 'progress') delete localDrafts[conflict.lessonId];
    removeConflict(conflict);
    syncFromLedger();
    return true;
  }
  if (result.reason === 'duplicate') {
    removeConflict(conflict);
    return true;
  }
  saveBanner.show = true;
  saveBanner.kind = 'quota';
  saveBanner.message = '本机存储空间不足，写入已拒绝，原记录已保留。';
  return false;
}

export function cancelConflict(conflict: ConflictInfo) {
  if (conflict.type === 'progress') delete localDrafts[conflict.lessonId];
  removeConflict(conflict);
}

export function setDownloaded(lessonId: string, value: boolean) {
  if (value && !settings.downloadedLessonIds.includes(lessonId)) settings.downloadedLessonIds.push(lessonId);
  if (!value) settings.downloadedLessonIds = settings.downloadedLessonIds.filter((id) => id !== lessonId);
  syncDownloaded();
}

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    attempts: state.attempts,
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  state.courses = fresh.courses;
  state.attempts = fresh.attempts;
  state.progress = fresh.progress;
  settings.downloadedLessonIds = fresh.courses.flatMap((c) => c.lessons.filter((l) => l.downloaded).map((l) => l.id));
  syncDownloaded();
  const ops = migrateOldStateToOps(fresh);
  writeLedger(ops);
  applyReplay(ops);
}
