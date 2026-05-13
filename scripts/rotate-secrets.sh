#!/usr/bin/env bash
set -euo pipefail

# Rotates JWT signing secrets in .env. All existing access + refresh tokens
# become invalid — users will need to re-authenticate. Encryption keys are
# NOT touched (rotating them would corrupt encrypted data at rest).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE not found" >&2
    exit 1
fi

# Snapshot before mutating.
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP="$ENV_FILE.bak.$TIMESTAMP"
cp "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"
echo "==> Backup written: $BACKUP"

# Keys to rotate. Each entry: "ENV_KEY:generator-command"
KEYS_TO_ROTATE=(
    "JWT_ACCESS_SECRET:openssl rand -base64 48 | tr -d '\\n'"
    "JWT_REFRESH_SECRET:openssl rand -base64 48 | tr -d '\\n'"
)

ROTATED=()
for entry in "${KEYS_TO_ROTATE[@]}"; do
    key="${entry%%:*}"
    gen_cmd="${entry#*:}"
    new_val="$(bash -c "$gen_cmd")"

    if grep -q "^${key}=" "$ENV_FILE"; then
        # Use a delimiter unlikely to appear in base64 output.
        # Anchor to start-of-line so we don't match commented lines etc.
        escaped_val="$(printf '%s' "$new_val" | sed -e 's/[\/&]/\\&/g')"
        sed -i "s|^${key}=.*|${key}=${escaped_val}|" "$ENV_FILE"
        ROTATED+=("$key")
    else
        echo "WARN: $key not found in .env — skipping" >&2
    fi
done

if [[ ${#ROTATED[@]} -eq 0 ]]; then
    echo "Nothing rotated."
    exit 0
fi

chmod 600 "$ENV_FILE"

echo "==> Rotated:"
for k in "${ROTATED[@]}"; do
    echo "    - $k"
done
echo ""
echo "All existing access + refresh tokens are now invalid."
echo "Restart services to pick up the new secrets:"
echo "    just restart"
