/**
 * 本机存储的底层封装。
 *
 * 所有写入都是「先序列化成整串、再一次性 setItem」：localStorage 的规范行为
 * 保证 setItem 要么完整成功，要么抛 QuotaExceededError 且保留原值。写入前先
 * 试算容量，容量不足时直接拒绝写入，原记录保持不动。
 */

export interface StorageWriteResult {
  ok: boolean;
  reason?: 'quota' | 'denied' | 'serialization';
}

const TEST_KEY = '__sologsb-quota-probe__';

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readJSON<T>(key: string): T | undefined {
  const backend = storage();
  if (!backend) return undefined;
  try {
    const raw = backend.getItem(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function rawRead(key: string): string | null {
  const backend = storage();
  if (!backend) return null;
  try {
    return backend.getItem(key);
  } catch {
    return null;
  }
}

/**
 * 容量预检：本次写入相对原值只需多占 (新串长度 - 旧串长度) 字节，
 * 用探针键写入等量增量验证，避免把整份内容复制一遍造成误判。
 * 真正提交时再次捕获异常，任何失败都不会触碰原有键。
 */
export function writeJSON(key: string, value: unknown): StorageWriteResult {
  const backend = storage();
  if (!backend) return { ok: false, reason: 'denied' };

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, reason: 'serialization' };
  }

  let previousLength = 0;
  try {
    previousLength = backend.getItem(key)?.length ?? 0;
  } catch {
    previousLength = 0;
  }
  const growth = Math.max(0, serialized.length - previousLength) + 64;

  try {
    backend.setItem(TEST_KEY, 'x'.repeat(growth));
    backend.removeItem(TEST_KEY);
  } catch {
    try {
      backend.removeItem(TEST_KEY);
    } catch {
      // ignore
    }
    return { ok: false, reason: 'quota' };
  }

  try {
    backend.setItem(key, serialized);
    return { ok: true };
  } catch (error) {
    // 走到这里通常仍是配额问题；原键内容不会被半截写入覆盖。
    if (isQuotaError(error)) return { ok: false, reason: 'quota' };
    return { ok: false, reason: 'denied' };
  }
}

export function removeKey(key: string): void {
  const backend = storage();
  if (!backend) return;
  try {
    backend.removeItem(key);
  } catch {
    // ignore
  }
}

export function isQuotaError(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && ((error as DOMException).name === 'QuotaExceededError'
      || (error as DOMException).code === 22
      || (error as DOMException).code === 1014);
}
