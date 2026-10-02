/**
 * 存储层端到端验证：用内存 localStorage 模拟浏览器，子进程隔离三种场景。
 * 场景 A：旧 v1 数据首次打开 → 迁移 → 重放 → 反馈写入 → 导出合并结果
 * 场景 B：配额不足 → 拒绝写入且原记录保留 → 释放空间后重试成功
 * 场景 C：两个标签（两个 store 实例）并发保存 → 冲突 → 确认合并
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(here, 'session-child.mts');

const scenarios = ['migration', 'quota', 'multitab'];
let failed = false;
for (const scenario of scenarios) {
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', child, scenario], {
      cwd: path.join(here, '..'),
      encoding: 'utf8'
    });
    process.stdout.write(output);
  } catch (error) {
    failed = true;
    console.error((error as { stdout?: Buffer; stderr?: Buffer }).stdout?.toString());
    console.error((error as { stderr?: Buffer }).stderr?.toString());
  }
}
process.exitCode = failed ? 1 : 0;
