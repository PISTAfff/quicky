import { parseDay, plusDays } from "../../lib/model";
import { WEEK_LONG } from "../state";

/** When a task put off with "not today" comes back: "tomorrow" or "Fri 6 Nov". */
export const laterDay = (k: string) => {
  if (k === plusDays(1)) return "tomorrow";
  const d = parseDay(k);
  return `${WEEK_LONG[d.getDay()]} ${d.getDate()} ${d.toLocaleString("en", { month: "short" })}`;
};
