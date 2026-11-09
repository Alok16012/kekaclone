/**
 * Generates a VAPID key pair for Web Push, locally (nothing leaves this machine). Paste the lines into .env.local.
 *   pnpm push:keys
 */
import webpush from "web-push";

const k = webpush.generateVAPIDKeys();
console.log("# Web Push (plat2): add to .env.local, then restart the server");
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${k.privateKey}`);
console.log("VAPID_SUBJECT=mailto:admin@example.com");
