export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';

/**
 * 账本操作类型。
 * - progress: 作答进度（答案与当前句）
 * - attempt: 一次整课提交
 * - feedback: 教师反馈
 * - classification: 逐词错误分类与原因
 */
export type OpType = 'progress' | 'attempt' | 'feedback' | 'classification';

/**
 * 写入本机操作账本的一条操作。
 * 每条操作都有来源（source）与全局递增序号（seq），并记录它所基于的课节版本（baseVersion）。
 */
export interface LedgerOp {
  /** 幂等键：重复写入同一 opId 只生效一次 */
  opId: string;
  /** 全局递增序号，重放时按此排序 */
  seq: number;
  /** 来源标签页标识 */
  source: string;
  type: OpType;
  /** 同一课节版本核对的归属课节 */
  lessonId: string;
  /** 该操作基于的课节版本（即写入前的最大 seq） */
  baseVersion: number;
  createdAt: string;
  progress?: { answers: Record<string, string>; activeSentenceId: string };
  attempt?: PracticeAttempt;
  feedback?: { attemptId: string; teacherFeedback: string };
  classification?: { attemptId: string; sentenceId: string; tokenIndex: number; category: ErrorCategory; reason: string };
}

export interface LedgerFile {
  version: 1;
  ops: LedgerOp[];
}

/** 重放后的合并结果 */
export interface MergedData {
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  /** 课节版本：该课节相关操作的最大 seq */
  versions: Record<string, number>;
}

/** 冲突中列出的“别处已改”条目 */
export interface ConflictChange {
  kind: OpType;
  lessonId: string;
  sentenceId?: string;
  attemptId?: string;
  label: string;
  detail?: string;
}

/** 一次操作的载荷（按类型包装） */
export type OpPayload =
  | { progress: { answers: Record<string, string>; activeSentenceId: string } }
  | { attempt: PracticeAttempt }
  | { feedback: { attemptId: string; teacherFeedback: string } }
  | { classification: { attemptId: string; sentenceId: string; tokenIndex: number; category: ErrorCategory; reason: string } };

/** 一次保存前核对发现的冲突 */
export interface ConflictInfo {
  lessonId: string;
  baseVersion: number;
  currentVersion: number;
  changes: ConflictChange[];
  type: OpType;
  draft: OpPayload;
}

export interface SaveBanner {
  show: boolean;
  kind: 'conflict' | 'quota' | 'replay' | 'migration';
  message: string;
  conflict?: ConflictInfo;
}

export interface Sentence {
  id: string;
  text: string;
  translation: string;
  note: string;
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  subtitle: string;
  level: string;
  estimatedMinutes: number;
  downloaded: boolean;
  sentences: Sentence[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  level: string;
  accent: string;
  lessons: Lesson[];
}

export interface TokenResult {
  index: number;
  expected: string;
  actual: string;
  correct: boolean;
  category: ErrorCategory;
  reason: string;
}

export interface SentenceAttempt {
  sentenceId: string;
  source: string;
  answer: string;
  tokens: TokenResult[];
  score: number;
}

export interface PracticeAttempt {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

export interface PersistedState {
  schemaVersion: 1;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}
