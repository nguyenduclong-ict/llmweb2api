import type { InternalMessage } from '../../types/common';

interface TodoItem {
  content: string;
  status: string;
  priority: string;
}

export interface TodoSnapshot {
  todos: TodoItem[];
  hasPending: boolean;
}

/**
 * Một vòng lặp duy nhất duyệt ngược messages, đồng thời:
 * - Tìm todowrite gần nhất và parse todos
 * - Đếm số tool call liên tiếp kể từ cuối đến khi gặp todowrite hoặc user
 *
 * Trả về snapshot nếu cần inject, ngược lại null.
 */
export function shouldInjectTodoReminder(messages: InternalMessage[], minToolCalls = 2): TodoSnapshot | null {
  let toolCallCount = 0;
  let snapshot: TodoSnapshot | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.role === 'user') break;

    if (msg.role !== 'assistant' || !msg.tool_calls) continue;

    const hasTodowrite = msg.tool_calls.some((tc) => tc.function.name === 'todowrite');

    if (hasTodowrite && !snapshot) {
      for (const tc of msg.tool_calls) {
        if (tc.function.name !== 'todowrite') continue;
        try {
          const args = JSON.parse(tc.function.arguments);
          const todos: TodoItem[] = args.todos || [];
          const hasPending = todos.some(
            (t: TodoItem) => t.status === 'pending' || t.status === 'in_progress',
          );
          snapshot = { todos, hasPending };
          break;
        } catch {
          break;
        }
      }
      break;
    }

    if (!hasTodowrite) {
      toolCallCount += msg.tool_calls.length;
    }
  }

  if (!snapshot || !snapshot.hasPending) return null;
  if (toolCallCount < minToolCalls) return null;

  return snapshot;
}

/**
 * Build system block chứa danh sách todowriter hiện tại.
 */
export function buildTodoReminderBlock(snapshot: TodoSnapshot): string {
  const todosJson = JSON.stringify(snapshot.todos, null, 2);
  return `[#l2a:system]

Danh sách todowriter hiện tại, cập nhật nếu cần thiết:

${todosJson}

[/l2a:system]`;
}
