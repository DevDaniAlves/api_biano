FROM evoapicloud/evolution-api:2.4.0-rc2

WORKDIR /evolution

# 2.4.0-rc2 ainda vem com baileys 7.0.0-rc.9 (sem tctoken).
# Sem isso o WhatsApp recusa 1:1: PENDING / status 0 / Closing session / 463.
ENTRYPOINT ["/bin/bash", "-c", "npm install baileys@7.0.0-rc13 --omit=dev --legacy-peer-deps && . ./Docker/scripts/deploy_database.sh && npm run start:prod"]
