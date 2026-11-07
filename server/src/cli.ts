/**
 * npm run admin:hash — prints ADMIN_PASSWORD_HASH for .env.
 * The password is typed without echo and never written anywhere.
 */
import { stdin, stdout } from "node:process";
import { encodeAdminHash } from "./security/admin.ts";
import { hashPassword } from "./security/crypto.ts";

function ask(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    if (!stdin.isTTY) {
      // Piped input (e.g. CI): read one line.
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (buf += c));
      stdin.on("end", () => resolve(buf.split(/\r?\n/)[0] ?? ""));
      stdin.on("error", reject);
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (c === "\u0003") process.exit(130); // Ctrl+C
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

const cmd = process.argv[2];
if (cmd !== "hash-password") {
  console.error("Usage: node src/cli.ts hash-password");
  process.exit(2);
}
const pw = await ask("Новый пароль администратора (минимум 12 символов): ");
if (pw.length < 12) {
  console.error("Пароль слишком короткий — нужно минимум 12 символов.");
  process.exit(1);
}
if (stdin.isTTY) {
  const again = await ask("Повторите пароль: ");
  if (again !== pw) {
    console.error("Пароли не совпадают.");
    process.exit(1);
  }
}
const encoded = encodeAdminHash(await hashPassword(pw));
console.log("\nДобавьте в .env (и удалите ADMIN_PASSWORD, если он там есть):\n");
console.log(`ADMIN_PASSWORD_HASH=${encoded}\n`);
