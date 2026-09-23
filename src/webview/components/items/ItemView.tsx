import { memo } from "preact/compat";
import { useItem, useSelector } from "../../store";
import { AssistantMessage } from "./AssistantMessage";
import { Divider, TurnEnd } from "./Misc";
import { Notice } from "./Notice";
import { PlanCard, TodosCard } from "./PlanCard";
import { PlanProposalCard } from "./PlanProposalCard";
import { QuestionCard } from "./QuestionCard";
import { Thought } from "./Thought";
import { ToolCard } from "./ToolCard";
import { UserMessage } from "./UserMessage";

/** Subscribes to a single item by id and dispatches on its type. */
export const ItemView = memo(function ItemView({ id }: { id: string }) {
  const item = useItem(id);
  const showThoughts = useSelector((s) => s.settings.showThoughts);
  if (!item) return null;
  switch (item.type) {
    case "user":
      return <UserMessage item={item} />;
    case "assistant":
      return <AssistantMessage item={item} />;
    case "thought":
      return showThoughts ? <Thought item={item} /> : null;
    case "tool":
      return <ToolCard item={item} />;
    case "plan":
      return <PlanCard item={item} />;
    case "todos":
      return <TodosCard item={item} />;
    case "question":
      return <QuestionCard item={item} />;
    case "plan_proposal":
      return <PlanProposalCard item={item} />;
    case "notice":
      return <Notice item={item} />;
    case "turn_end":
      return <TurnEnd item={item} />;
    case "divider":
      return <Divider item={item} />;
    default:
      return null;
  }
});
