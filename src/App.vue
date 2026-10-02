<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  confirmMergedCommit,
  courseForLesson,
  dismissConflictPanel,
  effectiveAnswer,
  exportRecords,
  flushAfterReconnect,
  getTabId,
  lessonById,
  lessonVersion,
  persistPrefs,
  recoverPendingSubmits,
  replayFromDisk,
  resolveConflict,
  retryMigration,
  saveAnswerDraft,
  saveClassification,
  saveFeedbackDraft,
  setDownloaded,
  state,
  queueSubmit,
  updateTokenClassification
} from './store';
import { describeField } from './ledger';
import type { ErrorCategory, Lesson, PracticeAttempt, PracticeView } from './types';
import { compareSentence, scoreAttempt, segmentText } from './utils';

const view = ref<PracticeView>(state.activeLessonId ? 'practice' : 'library');
const online = ref(navigator.onLine);
const toast = ref('');
const resultAttemptId = ref('');
const selectedResultSentence = ref(0);
const segmentStart = ref(0);
const segmentEnd = ref(1);
const teacherAttemptId = ref(state.attempts[0]?.id ?? '');
const teacherDraft = ref(state.attempts[0]?.teacherFeedback ?? '');
const teacherDirty = ref(false);
let toastTimer = 0;
let answerSaveTimer = 0;
let lastSubmittedAttemptId = '';
let suppressAnswerWatch = false;

const activeLesson = computed(() => lessonById(state.activeLessonId));
const activeCourse = computed(() => activeLesson.value ? courseForLesson(activeLesson.value.id) : undefined);
const currentSentence = computed(() => {
  const lesson = activeLesson.value;
  if (!lesson) return undefined;
  return lesson.sentences.find((sentence) => sentence.id === state.activeSentenceId) ?? lesson.sentences[0];
});
const currentAnswer = ref('');
const currentIndex = computed(() => {
  if (!activeLesson.value || !currentSentence.value) return 0;
  return activeLesson.value.sentences.findIndex((item) => item.id === currentSentence.value?.id);
});
const lessonCompletion = computed(() => {
  if (!activeLesson.value) return 0;
  const answered = activeLesson.value.sentences.filter(
    (sentence) => (effectiveAnswer(activeLesson.value!.id, sentence.id) ?? '').trim()
  ).length;
  return Math.round((answered / activeLesson.value.sentences.length) * 100);
});
const activeLessonVersion = computed(() => activeLesson.value ? lessonVersion(activeLesson.value.id) : 0);
const resultAttempt = computed(() => state.attempts.find((attempt) => attempt.id === resultAttemptId.value));
const resultSentence = computed(() => resultAttempt.value?.sentenceAttempts[selectedResultSentence.value]);
const teacherAttempt = computed(() => state.attempts.find((attempt) => attempt.id === teacherAttemptId.value));
const teacherLessonVersion = computed(() => teacherAttempt.value ? lessonVersion(teacherAttempt.value.lessonId) : 0);
const totalWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).length);
const correctedWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).filter((token) => !token.correct && token.category !== 'unclassified').length);

const blockingConflicts = computed(() => state.pendingConflicts.filter((conflict) => !conflict.remoteOnly));
const remoteOnlyConflicts = computed(() => state.pendingConflicts.filter((conflict) => conflict.remoteOnly));
const allConflictsDecided = computed(() => blockingConflicts.value.every((conflict) => conflict.decided));

// 跨标签重放 / 账本变更时，依赖该 tick 让本视图重新取值。
const ledgerTick = computed(() => state.ledgerTick);
const pendingRecoveredSubmits = computed(() => {
  void ledgerTick.value;
  return recoverPendingSubmits();
});

const categoryOptions: Array<{ value: ErrorCategory; label: string }> = [
  { value: 'unclassified', label: '未分类' },
  { value: 'spelling', label: '拼写错误' },
  { value: 'omitted', label: '漏词' },
  { value: 'extra', label: '多词' },
  { value: 'punctuation', label: '标点' },
  { value: 'grammar', label: '语法' }
];

function loadCurrentAnswer() {
  if (!activeLesson.value || !currentSentence.value) {
    currentAnswer.value = '';
    return;
  }
  suppressAnswerWatch = true;
  currentAnswer.value = effectiveAnswer(activeLesson.value.id, currentSentence.value.id);
  suppressAnswerWatch = false;
}

watch(currentSentence, (sentence) => {
  loadCurrentAnswer();
  segmentStart.value = 0;
  segmentEnd.value = sentence ? Math.max(0, segmentText(sentence.text).length - 1) : 0;
}, { immediate: true });

watch(currentAnswer, (value) => {
  if (suppressAnswerWatch) return;
  const lesson = activeLesson.value;
  const sentence = currentSentence.value;
  if (!lesson || !sentence) return;
  window.clearTimeout(answerSaveTimer);
  answerSaveTimer = window.setTimeout(() => {
    const result = saveAnswerDraft(lesson.id, sentence.id, value);
    if (!result.ok && result.reason === 'quota') notify('本机容量不足，答案未写入，原有记录已保留');
  }, 350);
});

watch(activeLesson, (lesson) => {
  if (!lesson) return;
  state.activeLessonId = lesson.id;
  if (!currentSentence.value) state.activeSentenceId = lesson.sentences[0].id;
  persistPrefs();
  loadCurrentAnswer();
});

watch(teacherAttemptId, (id) => {
  teacherDraft.value = state.attempts.find((attempt) => attempt.id === id)?.teacherFeedback ?? '';
  teacherDirty.value = false;
});

// 他处保存反馈后，若本标签未在编辑则回显合并后的内容。
watch(ledgerTick, () => {
  if (!teacherDirty.value && teacherAttempt.value) {
    teacherDraft.value = teacherAttempt.value.teacherFeedback;
  }
  if (view.value === 'practice') loadCurrentAnswer();
  if (lastSubmittedAttemptId && view.value === 'practice') {
    const attempt = state.attempts.find((item) => item.id === lastSubmittedAttemptId);
    if (attempt && !state.pendingAction) {
      resultAttemptId.value = attempt.id;
      selectedResultSentence.value = 0;
      syncSegment();
      view.value = 'result';
      lastSubmittedAttemptId = '';
    }
  }
});

function notify(message: string) {
  toast.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = ''; }, 2600);
}

function startLesson(lesson: Lesson) {
  state.activeLessonId = lesson.id;
  const remembered = state.progress[lesson.id]?.activeSentenceId;
  const globalCurrent = state.activeSentenceId;
  const valid = (id: string) => lesson.sentences.some((sentence) => sentence.id === id);
  state.activeSentenceId = valid(remembered) ? remembered
    : valid(globalCurrent) ? globalCurrent
    : lesson.sentences[0].id;
  persistPrefs();
  loadCurrentAnswer();
  view.value = 'practice';
}

function goToSentence(index: number) {
  const lesson = activeLesson.value;
  if (!lesson || !lesson.sentences[index]) return;
  state.activeSentenceId = lesson.sentences[index].id;
  persistPrefs();
  loadCurrentAnswer();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function reportCommitFailure(reason: string | undefined): boolean {
  if (reason === 'quota') {
    notify('本机容量不足，写入被拒绝，原记录与草稿均已保留');
    return true;
  }
  if (reason === 'denied' || reason === 'unhealthy') {
    notify('本机存储暂不可用，改动保留在本标签，可稍后重试');
    return true;
  }
  return false;
}

function submitLesson() {
  const lesson = activeLesson.value;
  const course = activeCourse.value;
  if (!lesson || !course) return;
  const answeredCount = lesson.sentences.filter(
    (sentence) => (effectiveAnswer(lesson.id, sentence.id) ?? '').trim()
  ).length;
  if (!answeredCount) {
    notify('请至少输入一句话再提交');
    return;
  }
  if (answeredCount < lesson.sentences.length && !window.confirm(`还有 ${lesson.sentences.length - answeredCount} 句未作答，仍然提交吗？`)) return;

  const sentenceAttempts = lesson.sentences.map((sentence) => {
    const source = sentence.text;
    const answer = effectiveAnswer(lesson.id, sentence.id);
    const tokens = compareSentence(source, answer);
    const correct = tokens.filter((token) => token.correct).length;
    return { sentenceId: sentence.id, source, answer, tokens, score: tokens.length ? Math.round((correct / tokens.length) * 100) : 0 };
  });
  const attempt: PracticeAttempt = {
    id: `attempt-${Date.now()}`,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    courseTitle: course.title,
    submittedAt: new Date().toISOString(),
    score: scoreAttempt(sentenceAttempts),
    sentenceAttempts,
    teacherFeedback: ''
  };

  const result = queueSubmit(attempt);
  if (result.ok) {
    openResult(attempt);
    notify('已提交，逐词结果已写入共享账本');
    return;
  }
  if (result.reason === 'conflict') {
    lastSubmittedAttemptId = attempt.id;
    notify('同一课节在别处已有改动，请确认合并后再提交');
    return;
  }
  reportCommitFailure(result.reason);
}

function openResult(attempt: PracticeAttempt) {
  resultAttemptId.value = attempt.id;
  selectedResultSentence.value = 0;
  syncSegment();
  view.value = 'result';
}

function syncSegment() {
  const tokenCount = segmentText(resultSentence.value?.source ?? '').length;
  segmentStart.value = 0;
  segmentEnd.value = Math.max(0, tokenCount - 1);
}

function replay(text: string, rate = 0.82) {
  if (!('speechSynthesis' in window)) {
    notify('当前浏览器不支持语音播放');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = rate;
  window.speechSynthesis.speak(utterance);
}

function replaySegment() {
  const tokens = segmentText(resultSentence.value?.source ?? '');
  const start = Math.min(segmentStart.value, segmentEnd.value);
  const end = Math.max(segmentStart.value, segmentEnd.value);
  replay(tokens.slice(start, end + 1).map((token) => token.display).join(' '), 0.72);
}

function selectResultSentence(index: number) {
  selectedResultSentence.value = index;
  syncSegment();
}

function saveClassificationHandler(attemptId: string, sentenceId: string, tokenIndex: number, category: ErrorCategory, reason: string) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  if (!attempt) return;
  updateTokenClassification(attemptId, sentenceId, tokenIndex, { category, reason });
  const result = saveClassification(attempt.lessonId, attemptId, sentenceId, tokenIndex, { category, reason });
  if (result.reason === 'conflict') notify('该词的分类在别处已改，请在冲突面板确认合并');
  else reportCommitFailure(result.reason);
}

function saveTeacherFeedback() {
  const attempt = teacherAttempt.value;
  if (!attempt) return;
  teacherDirty.value = false;
  attempt.teacherFeedback = teacherDraft.value.trim();
  const result = saveFeedbackDraft(attempt.lessonId, attempt.id, teacherDraft.value.trim());
  if (result.ok) {
    notify('教师反馈已写入共享账本');
    return;
  }
  if (result.reason === 'conflict') notify('该作答在别处已有改动，请确认合并后再保存反馈');
  else reportCommitFailure(result.reason);
}

function chooseResolution(fieldKey: string, resolution: 'local' | 'remote') {
  resolveConflict(fieldKey, resolution);
}

const categoryLabelMap = new Map<ErrorCategory, string>(categoryOptions.map((option) => [option.value, option.label]));

function conflictDisplay(conflict: { kind: string; localValue: string; remoteValue: string }): { local: string; remote: string } {
  if (conflict.kind !== 'classify') return { local: conflict.localValue, remote: conflict.remoteValue };
  const decode = (encoded: string) => {
    const [category, reason] = encoded.split('|');
    const label = categoryLabelMap.get(category as ErrorCategory) ?? category;
    return reason ? `${label} · ${reason}` : label;
  };
  return { local: decode(conflict.localValue), remote: decode(conflict.remoteValue) };
}

function submitConflictHint(kind: string): string {
  if (kind === 'submit') return '学习端已再次提交，确认后以你的提交快照为准并入账本';
  return '';
}

function confirmMerge() {
  const result = confirmMergedCommit();
  if (result.ok) {
    notify(state.pendingAction === 'feedback' ? '反馈已按合并结果保存' : '合并完成，已提交');
    if (lastSubmittedAttemptId) {
      const attempt = state.attempts.find((item) => item.id === lastSubmittedAttemptId);
      if (attempt) {
        openResult(attempt);
        lastSubmittedAttemptId = '';
      }
    }
    return;
  }
  if (result.reason === 'undecided') notify('请先为每一项选择保留方式');
  else if (result.reason === 'conflict') notify('仍有未处理的改动，请继续确认');
  else reportCommitFailure(result.reason);
}

function dismissConflicts() {
  dismissConflictPanel();
  lastSubmittedAttemptId = '';
  notify('已保留两边草稿，可稍后再保存');
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  persistPrefs();
}

function changeFont(delta: number) {
  state.fontScale = Math.min(1.25, Math.max(0.85, Number((state.fontScale + delta).toFixed(2))));
  persistPrefs();
}

function switchRole(role: 'learner' | 'teacher') {
  state.role = role;
  persistPrefs();
}

function downloadRecords() {
  const blob = new Blob([exportRecords()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `echo-step-records-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  notify('已导出合并后的练习记录');
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function retryStorage() {
  if (state.storageError === 'migration') {
    if (retryMigration()) notify('旧数据迁移成功，已按账本重放');
    else notify('迁移仍失败，原内容未改动，可再次重试');
    return;
  }
  const replay = replayFromDisk();
  const flush = flushAfterReconnect();
  if (!replay.error && flush.ok) {
    state.storageError = '';
    notify('已按本机账本重放并恢复');
  } else {
    notify('重放未完成，原内容保持不变');
  }
}

function onConnectionChange() {
  online.value = navigator.onLine;
  state.online = navigator.onLine;
  if (navigator.onLine) flushAfterReconnect();
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    replayFromDisk();
  } else {
    persistPrefs();
  }
}

onMounted(() => {
  window.addEventListener('online', onConnectionChange);
  window.addEventListener('offline', onConnectionChange);
  document.addEventListener('visibilitychange', onVisibilityChange);
  replayFromDisk();
  if (pendingRecoveredSubmits.value.length) {
    notify(`检测到 ${pendingRecoveredSubmits.value.length} 次尚未入账的提交，将在保存前核对版本`);
  }
});

/** 重新显示 / 断网恢复后，手动尝试把挂起的提交按账本核对后入账。 */
function resumePendingSubmit() {
  const snapshot = pendingRecoveredSubmits.value[0];
  if (!snapshot) return;
  const result = queueSubmit(snapshot);
  if (result.ok) {
    openResult(snapshot);
    notify('挂起的提交已按合并结果入账');
  } else if (result.reason === 'conflict') {
    notify('同一课节在别处已改动，请确认合并');
  } else {
    reportCommitFailure(result.reason);
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('online', onConnectionChange);
  window.removeEventListener('offline', onConnectionChange);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.clearTimeout(answerSaveTimer);
  persistPrefs();
});
</script>

<template>
  <var-app>
    <div class="app-shell" :data-theme="state.theme" :style="{ '--font-scale': state.fontScale }">
      <!-- 共享会话冲突面板：保留两边草稿，确认合并后才可提交 -->
      <div v-if="state.pendingConflicts.length" class="conflict-overlay">
        <section class="conflict-panel" role="dialog" aria-modal="true" aria-label="共享会话冲突">
          <header class="conflict-head">
            <h2>同一课节在别处已改动</h2>
            <p>另一个标签（{{ state.pendingConflicts[0]?.remoteSource.label }}）先保存了内容。请逐项确认合并，草稿均已保留不会丢失。</p>
          </header>

          <div v-for="conflict in blockingConflicts" :key="conflict.fieldKey" class="conflict-item">
            <div class="conflict-title">
              <strong>{{ describeField(conflict) }}</strong>
              <span>{{ formatDate(conflict.remoteAt) }} · #{{ conflict.remoteSeq }}</span>
            </div>
            <p v-if="submitConflictHint(conflict.kind)" class="conflict-hint">{{ submitConflictHint(conflict.kind) }}</p>
            <div class="conflict-versions">
              <label class="conflict-choice" :class="{ picked: conflict.decided && conflict.resolution === 'local' }">
                <input type="radio" :name="conflict.fieldKey" :checked="conflict.decided && conflict.resolution === 'local'" @change="chooseResolution(conflict.fieldKey, 'local')" />
                <div><span>保留本标签草稿</span><p>{{ conflictDisplay(conflict).local || '（空）' }}</p></div>
              </label>
              <label class="conflict-choice" :class="{ picked: conflict.decided && conflict.resolution === 'remote' }">
                <input type="radio" :name="conflict.fieldKey" :checked="conflict.decided && conflict.resolution === 'remote'" @change="chooseResolution(conflict.fieldKey, 'remote')" />
                <div><span>采用 {{ conflict.remoteSource.label }}</span><p>{{ conflictDisplay(conflict).remote || '（空）' }}</p></div>
              </label>
            </div>
          </div>

          <div v-if="remoteOnlyConflicts.length" class="conflict-note">
            <strong>同课节还有 {{ remoteOnlyConflicts.length }} 处他处改动</strong>
            <p v-for="item in remoteOnlyConflicts" :key="item.fieldKey">· {{ describeField(item) }} 已由 {{ item.remoteSource.label }} 更新（#{{ item.remoteSeq }}），与你的草稿不冲突，确认后自动合并。</p>
          </div>

          <div class="conflict-actions">
            <var-button block type="default" variant="outline" @click="dismissConflicts">稍后处理</var-button>
            <var-button block type="primary" :disabled="!allConflictsDecided" @click="confirmMerge">
              确认合并{{ state.pendingAction === 'submit' ? '并提交' : state.pendingAction === 'feedback' ? '并保存反馈' : '' }}
            </var-button>
          </div>
        </section>
      </div>

      <!-- 容量不足 / 迁移或重放失败提示：原记录保留，可重试 -->
      <div v-if="state.storageError" class="storage-banner" :class="state.storageError">
        <span v-if="state.storageError === 'quota'">本机容量不足，写入已被拒绝，原有记录完整保留。请释放空间后重试。</span>
        <span v-else-if="state.storageError === 'migration'">旧数据迁移未完成，原内容未改动，可点击重试。</span>
        <span v-else-if="state.storageError === 'replay'">账本重放失败，当前显示可能不是最新合并结果，原内容未改动。</span>
        <span v-else>本机存储被浏览器拒绝，改动暂存于本标签。</span>
        <button type="button" @click="retryStorage">重试</button>
      </div>

      <!-- 重开页面后仍挂起的提交：按账本核对版本后可重新入账 -->
      <div v-if="pendingRecoveredSubmits.length" class="storage-banner migration">
        <span>有 {{ pendingRecoveredSubmits.length }} 次提交尚未写入共享账本（草稿与逐词结果已保留）。</span>
        <button type="button" @click="resumePendingSubmit">核对并提交</button>
      </div>

      <div v-if="view === 'library'" class="page">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">E</div>
            <div><h1>EchoStep</h1><p>共享练习会话 · 多标签同步</p></div>
          </div>
          <div class="icon-row">
            <button class="icon-button" :aria-label="state.theme === 'light' ? '切换到深色模式' : '切换到浅色模式'" @click="toggleTheme">{{ state.theme === 'light' ? '◐' : '☀' }}</button>
            <button class="icon-button" aria-label="减小字号" @click="changeFont(-0.05)">A−</button>
            <button class="icon-button" aria-label="增大字号" @click="changeFont(0.05)">A＋</button>
          </div>
        </header>

        <section class="hero">
          <h2>今天也把声音变成文字</h2>
          <p>学习页与教师页共享同一本操作账：作答、提交、反馈带来源与递增序号写入，保存前核对版本，冲突需确认合并。</p>
          <div class="hero-stats">
            <div class="hero-stat"><strong>{{ state.attempts.length }}</strong><span>练习记录</span></div>
            <div class="hero-stat"><strong>{{ correctedWords }}</strong><span>已分类错误</span></div>
            <div class="hero-stat"><strong>{{ totalWords }}</strong><span>累计词数</span></div>
          </div>
        </section>

        <div class="offline-banner" :class="{ online }">
          <span>{{ online ? '● 在线 · 账本已同步到本机' : '● 离线模式 · 操作入账后断网恢复自动重放' }}</span>
          <span>标签 {{ getTabId().slice(0, 4) }}</span>
        </div>

        <div class="section-head">
          <h3>课程库</h3>
          <div class="segmented">
            <button :class="{ active: state.role === 'learner' }" @click="switchRole('learner'); view = 'library'">学习</button>
            <button :class="{ active: state.role === 'teacher' }" @click="switchRole('teacher'); view = 'teacher'">教师</button>
          </div>
        </div>

        <article v-for="course in state.courses" :key="course.id" class="course-card">
          <div class="course-title">
            <div><h3>{{ course.title }}</h3><p>{{ course.description }}</p></div>
            <span class="level-badge">{{ course.level }}</span>
          </div>
          <div v-for="lesson in course.lessons" :key="lesson.id" class="lesson-row">
            <div><h4>{{ lesson.title }}</h4><p>{{ lesson.subtitle }} · {{ lesson.sentences.length }} 句 · 约 {{ lesson.estimatedMinutes }} 分钟 · 版本 #{{ lessonVersion(lesson.id) }}</p></div>
            <div class="lesson-actions">
              <var-switch :model-value="lesson.downloaded" @update:model-value="setDownloaded(lesson.id, $event as boolean)" />
              <var-button type="primary" size="small" @click="startLesson(lesson)">{{ lesson.downloaded ? '继续' : '开始' }}</var-button>
            </div>
          </div>
        </article>

        <div class="section-head"><h3>最近练习</h3><span>{{ state.attempts.length }} 条记录（合并后）</span></div>
        <article v-if="state.attempts.length" class="panel">
          <div v-for="attempt in state.attempts.slice(0, 4)" :key="attempt.id" class="history-card">
            <div class="history-top"><strong>{{ attempt.lessonTitle }}</strong><span class="history-score">{{ attempt.score }} 分</span></div>
            <p>{{ formatDate(attempt.submittedAt) }} · {{ attempt.teacherFeedback || '暂无教师反馈' }}</p>
          </div>
          <var-button block type="primary" variant="outline" @click="downloadRecords">导出全部练习记录</var-button>
        </article>
        <div v-else class="empty-state"><strong>还没有练习记录</strong>完成一次听写后，可在这里复核和导出。</div>
      </div>

      <div v-else-if="view === 'practice' && activeLesson" class="page">
        <header class="practice-header">
          <div class="practice-nav">
            <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
            <div><h2>{{ activeLesson.title }}</h2></div>
            <span class="status-chip">版本 #{{ activeLessonVersion }} · {{ online ? '在线' : '离线' }}</span>
          </div>
          <div class="progress-line">
            <div class="sentence-count"><span>第 {{ currentIndex + 1 }} / {{ activeLesson.sentences.length }} 句</span><span>{{ lessonCompletion }}% 已填写</span></div>
            <var-progress :value="lessonCompletion" color="#1769e0" />
          </div>
        </header>

        <section class="audio-card">
          <div class="audio-meta">
            <button class="play-button" aria-label="播放当前句子" @click="replay(currentSentence?.text ?? '')">▶</button>
            <div><strong>听写提示</strong><p>先完整播放，再输入你听到的英文。每次作答都带来源写入本机账本，保存前自动核对同课节版本。</p></div>
          </div>
        </section>

        <div class="dictation-label"><strong>输入听到的内容</strong><span>答案带来源入账 · 标签 {{ getTabId().slice(0, 4) }}</span></div>
        <textarea v-model="currentAnswer" class="answer-box" :aria-label="`第 ${currentIndex + 1} 句听写答案`" placeholder="Type what you hear..." @keydown.ctrl.enter="submitLesson" @keydown.meta.enter="submitLesson"></textarea>
        <div class="practice-actions">
          <var-button block type="default" variant="outline" @click="replay(currentSentence?.text ?? '')">再听一次</var-button>
          <var-button block type="primary" @click="submitLesson">提交本次听写</var-button>
        </div>

        <div class="sentence-picker" aria-label="句子导航">
          <button v-for="(sentence, index) in activeLesson.sentences" :key="sentence.id" class="sentence-dot" :class="{ active: sentence.id === currentSentence?.id, done: !!(effectiveAnswer(activeLesson.id, sentence.id) || '').trim() }" :aria-label="`跳到第 ${index + 1} 句`" @click="goToSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="currentSentence" class="panel">
          <div class="detail-head"><div><h3>场景提示</h3><p>{{ currentSentence.translation }}</p></div></div>
          <div class="feedback-card">{{ currentSentence.note }}</div>
        </section>
      </div>

      <div v-else-if="view === 'result' && resultAttempt" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <span class="status-chip">提交于 {{ formatDate(resultAttempt.submittedAt) }}</span>
          <button class="icon-button" @click="downloadRecords">导出</button>
        </header>

        <section class="panel result-score">
          <div class="score-ring" :style="{ '--score': `${resultAttempt.score}%` }"><strong>{{ resultAttempt.score }}</strong></div>
          <h2>{{ resultAttempt.score >= 90 ? '几乎完美' : resultAttempt.score >= 70 ? '继续打磨细节' : '再听一遍会更好' }}</h2>
          <p>{{ resultAttempt.lessonTitle }} · 点击红色词可单独重听，并记录错误原因。</p>
        </section>

        <div class="sentence-picker">
          <button v-for="(attempt, index) in resultAttempt.sentenceAttempts" :key="attempt.sentenceId" class="sentence-dot" :class="{ active: index === selectedResultSentence }" @click="selectResultSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="resultSentence" class="panel token-panel">
          <div class="detail-head">
            <div><h3>第 {{ selectedResultSentence + 1 }} 句逐词结果</h3><p>{{ resultSentence.source }}</p></div>
            <span class="history-score">{{ resultSentence.score }}%</span>
          </div>
          <div class="word-list">
            <button v-for="token in resultSentence.tokens" :key="`${token.index}-${token.expected}-${token.actual}`" class="word-chip" :class="{ wrong: !token.correct }" :title="token.correct ? '点击重听' : `你的答案：${token.actual || '未输入'}`" @click="replay(token.expected || token.actual, 0.7)">
              {{ token.expected || `[+${token.actual}]` }}<small v-if="!token.correct">{{ token.actual || '漏词' }}</small>
            </button>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>片段重听</strong><span>选择起止词后播放</span></div>
            <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center">
              <select v-model.number="segmentStart" aria-label="片段起点"><option v-for="token in segmentText(resultSentence.source)" :key="`s-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <select v-model.number="segmentEnd" aria-label="片段终点"><option v-for="token in segmentText(resultSentence.source)" :key="`e-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <var-button type="primary" size="small" @click="replaySegment">播放片段</var-button>
            </div>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>错误分类与原因</strong><span>带来源入账，保存前核对版本</span></div>
            <div v-for="token in resultSentence.tokens.filter((item) => !item.correct)" :key="`edit-${token.index}`" class="feedback-card">
              <strong>{{ token.expected || `多出的词：${token.actual}` }}</strong>
              <div style="display: grid; grid-template-columns: 120px 1fr; gap: 8px; margin-top: 9px">
                <select :value="token.category" @change="saveClassificationHandler(resultAttempt.id, resultSentence.sentenceId, token.index, ($event.target as HTMLSelectElement).value as ErrorCategory, token.reason)">
                  <option v-for="option in categoryOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <input :value="token.reason" placeholder="记录原因，如连读、词尾未听清" @change="saveClassificationHandler(resultAttempt.id, resultSentence.sentenceId, token.index, token.category, ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
          </div>
        </section>

        <section v-if="resultAttempt.teacherFeedback" class="panel"><div class="feedback-card"><strong>教师反馈（账本合并结果）</strong><p>{{ resultAttempt.teacherFeedback }}</p></div></section>
        <var-button block type="primary" @click="startLesson(activeLesson!)">返回本次课程</var-button>
        <var-button block type="default" variant="outline" style="margin-top: 10px" @click="downloadRecords">导出练习记录</var-button>
      </div>

      <div v-else-if="view === 'teacher'" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <div class="brand"><div class="brand-mark">T</div><div><h1>教师复核</h1><p>共享账本 · 保存前核对课节版本</p></div></div>
        </header>

        <div v-if="state.attempts.length" class="panel">
          <div class="dictation-label"><strong>选择一次作答</strong><span>{{ state.attempts.length }} 条 · 当前课节版本 #{{ teacherLessonVersion }}</span></div>
          <var-select v-model="teacherAttemptId" placeholder="选择作答">
            <var-option v-for="attempt in state.attempts" :key="attempt.id" :label="`${attempt.lessonTitle} · ${attempt.score} 分 · ${formatDate(attempt.submittedAt)}`" :value="attempt.id" />
          </var-select>
          <template v-if="teacherAttempt">
            <div class="feedback-card"><strong>{{ teacherAttempt.courseTitle }}</strong><p>{{ teacherAttempt.lessonTitle }} · 总分 {{ teacherAttempt.score }}，完成 {{ teacherAttempt.sentenceAttempts.length }} 句。若学习端同时在保存，系统会先列出冲突再提交反馈。</p></div>
            <div class="teacher-editor">
              <textarea v-model="teacherDraft" @input="teacherDirty = true" placeholder="给学生一条具体、可执行的反馈..." aria-label="教师反馈"></textarea>
              <var-button block type="primary" style="margin-top: 10px" @click="saveTeacherFeedback">保存反馈</var-button>
            </div>
          </template>
        </div>
        <div v-else class="empty-state"><strong>暂无学生作答</strong>学习端提交听写后，这里会出现练习记录。</div>
      </div>

      <div v-if="toast" style="position: fixed; z-index: 40; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 11px 16px; border-radius: 12px; background: #17233d; color: white; font-size: .78rem; box-shadow: 0 10px 30px rgb(0 0 0 / .2)">{{ toast }}</div>
    </div>
  </var-app>
</template>
