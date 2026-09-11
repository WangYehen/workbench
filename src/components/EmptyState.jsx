import { IconInbox } from "@tabler/icons-react";
import "./DataStates.css";

export default function EmptyState({ icon: Icon = IconInbox, title, description, minHeight }) {
  return <div className="app-empty-state" style={minHeight ? { minHeight } : undefined}>
    <Icon size={22} stroke={1.7} aria-hidden="true" />
    <strong>{title}</strong>
    {description ? <span>{description}</span> : null}
  </div>;
}
