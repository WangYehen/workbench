export function formatPageEyebrow(value = "") {
  const normalized = String(value)
    .replace(/^\s*\/\/\s*/, "")
    .replace(/\s*\/\s*/g, " / ")
    .trim()
    .toUpperCase();
  return normalized ? normalized : "PERSONAL / WORKBENCH";
}

export function PageHeader({ eyebrow, title, description, actions, meta, compact = false }) {
  const fallbackDescription = `集中查看并处理${typeof title === "string" ? title : "当前页面"}相关信息。`;
  const aside = meta || actions;
  return (
    <header className={`page-header${compact ? " page-header--compact" : ""}`}>
      <div className="page-header__content">
        <span className="eyebrow page-header__eyebrow">{formatPageEyebrow(eyebrow)}</span>
        <h1 className="page-header__title">{title}</h1>
        <p className="page-header__description">{description || fallbackDescription}</p>
      </div>
      {aside ? (
        <div className="page-header__aside">
          {meta ? <div className="page-header__meta">{meta}</div> : null}
          {actions ? <div className="page-header__actions">{actions}</div> : null}
        </div>
      ) : null}
    </header>
  );
}
