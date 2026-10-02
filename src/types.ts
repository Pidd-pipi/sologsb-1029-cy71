export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';
export type Role = 'learner' | 'teacher';
export type OperationKind = 'answer' | 'submit' | 'feedback' | 'classify';
export type ConflictResolution = 'local' | 'remote';

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

/**
 * 操作账本：作答、提交、反馈、分类都作为一条带来源和递增序号的操作只追加写入。
 * seq 在整个账本内严格递增，同一课节最后一条操作的 seq 即该课节的版本号。
 */
export interface OpSource {
  tabId: string;
  role: Role;
  label: string;
  /** 系统来源（旧数据迁移、合并修复等），不视为别的标签的并发编辑。 */
  system?: boolean;
}

export interface LedgerOperation {
  id: string;
  seq: number;
  at: string;
  kind: OperationKind;
  lessonId: string;
  source: OpSource;
  // answer
  sentenceId?: string;
  value?: string;
  // submit
  attempt?: PracticeAttempt;
  idempotencyKey?: string;
  // feedback / classify
  attemptId?: string;
  // classify
  tokenIndex?: number;
  category?: ErrorCategory;
  reason?: string;
}

export interface LedgerDoc {
  docType: 'sologsb-ledger';
  schemaVersion: 2;
  operations: LedgerOperation[];
}

export interface ReconciledState {
  progress: Record<string, LessonProgress>;
  attempts: PracticeAttempt[];
  /** 每个课节的版本：账本中该课节最大 seq。 */
  lessonVersion: Record<string, number>;
  /** fieldKey -> 最后一条写入操作，用于核对别处改动。 */
  fieldLast: Record<string, LedgerOperation>;
  /** 账本中已经生效的提交幂等键，重复提交只能生效一次。 */
  submitKeys: Set<string>;
}

export interface ConflictEntry {
  lessonId: string;
  fieldKey: string;
  kind: OperationKind;
  sentenceId?: string;
  attemptId?: string;
  localValue: string;
  remoteValue: string;
  localAt: string;
  remoteAt: string;
  remoteSource: OpSource;
  remoteSeq: number;
  resolution: ConflictResolution;
  /** 用户是否已对该冲突做出选择。 */
  decided: boolean;
  /** 他处改动了同一课节但不与本标签草稿重叠，仅提示。 */
  remoteOnly: boolean;
}

export interface PrefsDoc {
  docType: 'sologsb-prefs';
  schemaVersion: 2;
  theme: ThemeMode;
  fontScale: number;
  role: Role;
  activeLessonId: string;
  activeSentenceId: string;
  downloads: Record<string, boolean>;
}

export interface DraftItem {
  key: string;
  lessonId: string;
  fieldKey: string;
  kind: OperationKind;
  value: string;
  opId: string;
  updatedAt: string;
  // classify 用的附加上下文
  attemptId?: string;
  tokenIndex?: number;
  category?: ErrorCategory;
  reason?: string;
  sentenceId?: string;
  /** submit 草稿携带的完整作答快照（含逐词结果）。 */
  attemptSnapshot?: PracticeAttempt;
}

export interface DraftsDoc {
  docType: 'sologsb-drafts';
  schemaVersion: 2;
  tabId: string;
  items: DraftItem[];
}

/** 兼容旧数据（v1）的整体存储结构。 */
export interface PersistedState {
  schemaVersion: 1;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: Role;
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}
