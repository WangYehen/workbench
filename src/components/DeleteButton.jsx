import { IconTrash } from "@tabler/icons-react";

export function DeleteButton({ onClick, children = "删除", ...props }) {
  return <button type="button" className="delete-button" onClick={onClick} {...props}><IconTrash size={15} stroke={2} /><span>{children}</span></button>;
}
