import { IconAlertTriangle, IconArrowRight, IconChecklist, IconGavel, IconUsers } from "@tabler/icons-react";
import { PriorityBadge } from "./PriorityBadge";

const groups = [
  { key: "decision", title: "今天该先处理什么？", hint: "需要你判断或拍板", icon: IconGavel, match: (item) => item.priority === "P0" || item.kind === "review" },
  { key: "risk", title: "哪些事情正在失控？", hint: "逾期、阻塞或风险", icon: IconAlertTriangle, match: (item) => item.kind === "blocker" || item.kind === "project" || item.dueAt },
  { key: "owner", title: "该找谁推进？", hint: "负责人和协作线索", icon: IconUsers, match: (item) => item.detail && item.kind !== "todo" },
  { key: "action", title: "我应该做什么动作？", hint: "现在就能推进的事项", icon: IconChecklist, match: () => true },
];

export default function ManagementQuestions({ items = [], onOpen }) {
  return <section className="management-questions" aria-label="主管四问">
    {groups.map((group) => {
      const GroupIcon = group.icon;
      const groupItems = items.filter(group.match).slice(0, 3);
      return <section className={`management-question management-question--${group.key}`} key={group.key}>
        <header><span className="management-question__icon"><GroupIcon size={17} /></span><div><h2>{group.title}</h2><p>{group.hint}</p></div><span className="management-question__count">{groupItems.length}</span></header>
        {groupItems.length ? <div className="management-question__list">{groupItems.map((item) => <button type="button" className="management-question__item" key={`${group.key}:${item.id}`} onClick={() => onOpen?.(item)}>
          <PriorityBadge priority={item.priority} /><span className="management-question__main"><strong>{item.title}</strong><small>{item.detail || item.recommendedAction || "查看事项详情"}</small></span><IconArrowRight size={15} />
        </button>)}</div> : <div className="management-question__empty">当前没有需要关注的事项</div>}
      </section>;
    })}
  </section>;
}
