#!/usr/bin/env bash
# Interactive maintenance for the Worker's server-side credentials.
#
# These never live in the repo, in wrangler.jsonc, or in any client: they are Cloudflare
# secrets, readable only by the Worker itself (CLAUDE.md rule 2). This script is a thin,
# self-documenting wrapper around `wrangler secret` so you don't have to remember the names.
#
#   ./scripts/secrets.sh            # show what is configured
#   ./scripts/secrets.sh set        # guided set/update
#   ./scripts/secrets.sh delete     # remove one
#
# Values are typed into wrangler's own prompt — this script never echoes, stores, or logs them.

set -euo pipefail
cd "$(dirname "$0")/.."

WRANGLER="npx wrangler"

declare -a NAMES=(
  DASHSCOPE_API_KEY_APAC
  DASHSCOPE_API_KEY_US
  DASHSCOPE_WORKSPACE_ID
)
declare -a DESCRIPTIONS=(
  "DashScope API key, Singapore region — powers the quality tier for APAC users AND all streaming (required for both)"
  "DashScope API key, US (Virginia) region — quality tier for everyone outside APAC (optional; without it those users fall back to the free chain)"
  "Model Studio workspace id, Singapore (optional) — switches streaming to the per-workspace host Alibaba recommends; without it the shared intl host is used"
)

list_secrets() {
  echo "Configured secrets on this Worker:"
  $WRANGLER secret list 2>/dev/null | grep -o '"name": "[^"]*"' | sed 's/"name": "/  - /; s/"$//' || {
    echo "  (could not read — are you logged in? try: npx wrangler login)"
    return 1
  }
  echo
  echo "Known names and what they do:"
  for i in "${!NAMES[@]}"; do
    printf '  %-24s %s\n' "${NAMES[$i]}" "${DESCRIPTIONS[$i]}"
  done
  echo
  echo "Note: ANTHROPIC_API_KEY is obsolete (the rewrite engine moved to Qwen-Plus)."
  echo "      Remove it with: ./scripts/secrets.sh delete"
}

choose_name() {
  echo "Which secret?" >&2
  for i in "${!NAMES[@]}"; do
    printf '  %d) %-24s %s\n' "$((i + 1))" "${NAMES[$i]}" "${DESCRIPTIONS[$i]}" >&2
  done
  printf '  %d) (other — type the name yourself)\n' "$((${#NAMES[@]} + 1))" >&2
  read -r -p "> " choice
  if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#NAMES[@]} )); then
    echo "${NAMES[$((choice - 1))]}"
  else
    read -r -p "Secret name: " custom
    echo "$custom"
  fi
}

case "${1:-list}" in
  list)
    list_secrets
    ;;
  set)
    name="$(choose_name)"
    echo "wrangler will now prompt for the value (input is hidden and never touches this script)."
    $WRANGLER secret put "$name"
    echo "Done. Redeploy for it to take effect: npx wrangler deploy"
    ;;
  delete)
    name="$(choose_name)"
    $WRANGLER secret delete "$name"
    ;;
  *)
    echo "usage: $0 [list|set|delete]" >&2
    exit 1
    ;;
esac
