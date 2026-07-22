import { Check, Circle, CircleDot, type LucideIcon } from "lucide-react";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

const ICON: Record<Todo["status"], LucideIcon> = {
  pending: Circle,
  in_progress: CircleDot,
  completed: Check,
};

const COLOR: Record<Todo["status"], string> = {
  pending: "text-muted-foreground",
  in_progress: "text-warning",
  completed: "text-success",
};

export function TodoList({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null;
  return (
    <ul className="space-y-1">
      {todos.map((t, i) => {
        const Icon = ICON[t.status] ?? Circle;
        return (
          <li key={i} className="flex items-center gap-2 text-sm">
            <Icon
              className={`size-3.5 ${COLOR[t.status] ?? "text-muted-foreground"}`}
            />
            <span
              className={
                t.status === "completed"
                  ? "text-muted-foreground line-through"
                  : ""
              }
            >
              {t.content}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
