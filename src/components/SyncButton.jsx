import { useEffect, useRef, useState } from "react";
import { IconRefresh } from "@tabler/icons-react";

export default function SyncButton({
  syncing = false,
  children,
  className = "btn",
  disabled = false,
  iconSize = 16,
  iconStroke,
  onClick,
  ...props
}) {
  const [showSyncing, setShowSyncing] = useState(syncing);
  const syncingStartedAt = useRef(0);

  useEffect(() => {
    if (syncing) {
      syncingStartedAt.current = Date.now();
      setShowSyncing(true);
      return undefined;
    }

    const remaining = Math.max(0, 600 - (Date.now() - syncingStartedAt.current));
    const timer = setTimeout(() => setShowSyncing(false), remaining);
    return () => clearTimeout(timer);
  }, [syncing]);

  const handleClick = (event) => {
    syncingStartedAt.current = Date.now();
    setShowSyncing(true);
    onClick?.(event);
  };

  return <button {...props} className={`${className}${showSyncing ? " sync-button--active" : ""}`} disabled={disabled || showSyncing} onClick={handleClick}>
    <IconRefresh size={iconSize} stroke={iconStroke} className={showSyncing ? "sync-button__icon" : undefined} aria-hidden="true" />
    {showSyncing ? <span>同步中<span className="sync-button__dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></span> : children}
  </button>;
}
