export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

const ICON: Record<Todo["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
};

export function TodoList({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null;
  return (
    <ul className="space-y-1">
      {todos.map((t, i) => (
        <li key={i} className="flex items-center gap-2 text-sm">
          <span
            className={
              t.status === "completed"
                ? "text-green-600"
                : t.status === "in_progress"
                  ? "text-amber-600"
                  : "text-zinc-400"
            }
          >
            {ICON[t.status] ?? "○"}
          </span>
          <span
            className={t.status === "completed" ? "text-zinc-500 line-through" : ""}
          >
            {t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}
