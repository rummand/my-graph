import { format, formatDistanceToNowStrict } from "date-fns";

export const fmtDate = (iso: string) => format(new Date(iso), "d MMM yyyy");
export const fmtDateTime = (iso: string) => format(new Date(iso), "d MMM yyyy, HH:mm");
export const fmtAgo = (iso: string) => `${formatDistanceToNowStrict(new Date(iso))} ago`;
