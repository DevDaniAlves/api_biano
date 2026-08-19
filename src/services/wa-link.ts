/** Link wa.me com encode único (evita texto %XX aparecer no campo do WhatsApp). */
export function buildWaMeLink(phone: string, text: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "";
  const msg = text.trim();
  return msg
    ? `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`
    : `https://wa.me/${digits}`;
}
