/** Password rules (pure, shared by forms and server). Length beats complexity rules; block the obvious ones. */
const COMMON = new Set(["password", "password1", "password123", "1234567890", "qwertyuiop", "iloveyou12", "welcome123", "admin12345", "letmein123", "india12345"]);

export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That's too long (200 characters at most).";
  if (/^(.)\1+$/.test(pw)) return "Don't repeat a single character.";
  if (COMMON.has(pw.toLowerCase())) return "That password is too common. Try a short phrase instead.";
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && pw.toLowerCase().includes(local)) return "Don't use your email in your password.";
  return null;
}
