export function formatDate(value, fallback = "Unknown") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatChatTimestamp(value, fallback = "") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatShortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
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
  if (!value) return "Unknown export";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown export";
  const pad = (part) => String(part).padStart(2, "0");
  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  ].join(" ");
}
