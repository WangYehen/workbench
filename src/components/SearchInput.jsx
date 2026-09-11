import { IconSearch, IconX } from "@tabler/icons-react";
import "./DataStates.css";

export default function SearchInput({ value, onChange, placeholder = "搜索", ariaLabel, allowClear = true, className = "" }) {
  return <label className={`search-input ${className}`}>
    <IconSearch size={16} aria-hidden="true" />
    <input value={value} onChange={(event) => onChange?.(event.target.value)} placeholder={placeholder} aria-label={ariaLabel || placeholder} />
    {allowClear && value ? <button type="button" className="search-input__clear" onClick={() => onChange?.("")} aria-label="清空搜索"><IconX size={14}/></button> : null}
  </label>;
}
