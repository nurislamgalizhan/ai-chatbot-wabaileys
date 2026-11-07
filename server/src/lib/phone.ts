/**
 * Phone numbers are stored as international digits without "+",
 * e.g. "77071234567". Kazakhstan local formats ("8 707 …") are accepted.
 */
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.includes("+")) return null;
  // Kazakhstan / Russia trunk prefix: 8XXXXXXXXXX -> 7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  // Ten local digits starting with 7 (e.g. "7071234567") -> add country code
  if (digits.length === 10 && digits.startsWith("7")) digits = `7${digits}`;
  if (!/^[1-9]\d{9,14}$/.test(digits)) return null;
  return digits;
}

/** "+7 707 123 45 67" for KZ/RU numbers, "+<digits>" otherwise. */
export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("7")) {
    return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 9)} ${digits.slice(9)}`;
  }
  return `+${digits}`;
}

/** For logs: never write a full phone number. */
export function maskPhone(digits: string | null | undefined): string {
  if (!digits) return "-";
  return `${digits.slice(0, 4)}***${digits.slice(-2)}`;
}
