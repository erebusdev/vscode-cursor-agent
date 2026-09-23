import { memo } from "preact/compat";
import type { PlanEntry, PlanItem, TodoEntry, TodosItem } from "../../../shared/protocol";
import { Badge, Icon, Spinner } from "../ui";

type Status = PlanEntry["status"];

export function StatusGlyph({ status }: { status: Status }) {
  switch (status) {
    case "pending":
      return <Icon name="circle-large-outline" class="task-icon pending" title="Pending" />;
    case "in_progress":
      return <Spinner class="task-icon in-progress" />;
    case "completed":
      return <Icon name="pass-filled" class="task-icon completed" title="Completed" />;
    case "cancelled":
      return <Icon name="circle-slash" class="task-icon cancelled" title="Cancelled" />;
  }
}

export function TaskList({ entries }: { entries: ReadonlyArray<{ content: string; status: Status; priority?: PlanEntry["priority"]; key: string }> }) {
  return (
    <ul class="task-list">
      {entries.map((e) => (
        <li key={e.key} class={`task ${e.status}`}>
          <StatusGlyph status={e.status} />
          <span class="task-text">{e.content}</span>
          {e.priority && <Badge class={`priority ${e.priority}`}>{e.priority}</Badge>}
        </li>
      ))}
    </ul>
  );
}

function summary(entries: ReadonlyArray<{ status: Status }>): string {
  const done = entries.filter((e) => e.status === "completed").length;
  return `${done}/${entries.length}`;
}

export const PlanCard = memo(function PlanCard({ item }: { item: PlanItem }) {
  if (item.entries.length === 0) return null;
  return (
    <div class="card plan-card" data-item-id={item.id}>
      <div class="card-title">
        <Icon name="checklist" />
        <span>Tasks</span>
        <span class="card-title-right">{summary(item.entries)}</span>
      </div>
      <TaskList entries={item.entries.map((e, i) => ({ ...e, key: String(i) }))} />
    </div>
  );
});

export const TodosCard = memo(function TodosCard({ item }: { item: TodosItem }) {
  if (item.todos.length === 0) return null;
  return (
    <div class="card plan-card" data-item-id={item.id}>
      <div class="card-title">
        <Icon name="tasklist" />
        <span>Todos</span>
        <span class="card-title-right">{summary(item.todos)}</span>
      </div>
      <TaskList entries={item.todos.map((t: TodoEntry) => ({ content: t.content, status: t.status, key: t.id }))} />
    </div>
  );
});
