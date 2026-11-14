function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? new Date(Number(value.trim()))
      : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value, fallback = "Unknown") {
  const date = parseDate(value);
  if (!date) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatChatTimestamp(value, fallback = "") {
  const date = parseDate(value);
  if (!date) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatShortDate(value) {
  const date = parseDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export function formatExportLabel(exportItem) {
  const name = String(exportItem?.name ?? "");
  const timestamp = name.match(/(?:^|[-_])(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:[-_]|$)/);
  if (timestamp) {
    const [, year, month, day, hour, minute, second] = timestamp;
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }
  if (name) return name;
  return formatIsoLike(exportItem?.modifiedAt);
}

export function roleLabel(role) {
  if (role === "assistant") return "ChatGPT";
  if (role === "user") return "You";
  if (role === "tool") return "Tool";
  if (role === "system") return "System";
  return role ?? "Unknown";
}

export function roleInitial(role) {
  if (role === "assistant") return "AI";
  if (role === "user") return "You";
  return String(role ?? "?").slice(0, 2).toUpperCase();
}

export function truncate(value, length = 180) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

function formatIsoLike(value) {
  const date = parseDate(value);
  if (!date) return "Unknown export";
  const pad = (part) => String(part).padStart(2, "0");
  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  ].join(" ");
}
