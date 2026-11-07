import type { OtpSender } from "../security/otp.ts";
import { SYSTEM_SESSION, type WaManager } from "./manager.ts";

/** OTP codes go out from the administrator's WhatsApp (system session). */
export function waOtpSender(wa: WaManager): OtpSender {
  return {
    isReady: () => wa.isConnected(SYSTEM_SESSION),
    hasWhatsApp: async (phone) => {
      const sock = wa.socket(SYSTEM_SESSION);
      if (!sock) return false;
      const result = await sock.onWhatsApp(phone);
      return Boolean(result?.[0]?.exists);
    },
    sendText: async (phone, text) => {
      await wa.sendText(SYSTEM_SESSION, `${phone}@s.whatsapp.net`, text);
    },
  };
}
