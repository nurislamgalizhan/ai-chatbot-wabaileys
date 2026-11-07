#!/usr/bin/env bash
# certbot --manual-auth-hook for DNS-01 (used when the host blocks foreign
# traffic, so Let's Encrypt cannot reach port 80). Collects the TXT values,
# and the LAST challenge waits until all of them are visible in public DNS.
#
# Interactive only: the system's `certbot renew` timer (no ALMA_ACME_INTERACTIVE)
# fails fast instead of hanging — renewal is done by hand every ~60 days:
#   sudo env ALMA_ACME_INTERACTIVE=1 certbot renew --cert-name almaai.kz --manual-auth-hook ...
set -u
STATE="${ALMA_ACME_DIR:-/home/devuser/acme}"
if [ "${ALMA_ACME_INTERACTIVE:-0}" != "1" ]; then
  echo "DNS validation needs a person (add TXT records); skipping unattended renewal" >&2
  exit 1
fi
mkdir -p "$STATE"
NAME="_acme-challenge.${CERTBOT_DOMAIN}"
echo "$NAME $CERTBOT_VALIDATION" >> "$STATE/values.txt"
n=$(wc -l < "$STATE/values.txt")
[ "$n" -lt "${ALMA_ACME_COUNT:-2}" ] && exit 0
deadline=$(( $(date +%s) + ${ALMA_ACME_WAIT:-10800} ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  ok=1
  while read -r name value; do
    dig +short TXT "$name" @1.1.1.1 | tr -d '"' | grep -qx "$value" || { ok=0; break; }
  done < "$STATE/values.txt"
  if [ "$ok" = 1 ]; then echo "all TXT records visible" > "$STATE/status.txt"; sleep 30; exit 0; fi
  sleep 15
done
echo "timeout waiting for DNS" > "$STATE/status.txt"
exit 1
