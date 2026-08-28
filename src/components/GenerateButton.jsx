import { IconRefresh } from "@tabler/icons-react";

/** Reusable AI/content generation action with a consistent loading label. */
export default function GenerateButton({ busy = false, children = "生成 / 刷新", className = "", variant = "primary", ...props }) {
  return (
    <button className={`btn ${variant === "primary" ? "primary " : ""}sm generate-button ${className}`.trim()} disabled={busy || props.disabled} {...props}>
      <IconRefresh size={14} className={busy ? "generate-button__spin" : ""} aria-hidden="true" />
      {busy ? "生成中…" : children}
    </button>
  );
}
